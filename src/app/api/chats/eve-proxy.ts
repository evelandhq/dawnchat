import type { HandleMessageStreamEvent } from "eve/client";

import {
  createRepository,
  type Chat,
  type Repository,
  type SessionState,
} from "@/db/repository";
import { getDbClient } from "@/db/provider";
import { createEveClientForConnection } from "@/eve/client";
import { EVE_PROXY_CONTINUATION_TOKEN } from "@/eve/proxy-contract";

const NDJSON_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";

type ProxyContext = {
  chat: Chat;
  repository: Repository;
  client: ReturnType<typeof createEveClientForConnection>;
};

export async function proxyCreateEveSession(request: Request, chatId: string): Promise<Response> {
  const resolved = await resolveProxyContext(chatId);
  if (resolved instanceof Response) {
    return resolved;
  }

  if (resolved.chat.status === "completed") {
    return errorResponse("Chat is completed", 409);
  }
  if (resolved.chat.status === "active" && resolved.chat.sessionState?.sessionId) {
    return errorResponse("Chat already has an Eve session", 409);
  }

  return proxyTurnRequest(request, resolved);
}

export async function proxyContinueEveSession(
  request: Request,
  chatId: string,
  sessionId: string,
): Promise<Response> {
  const resolved = await resolveProxyContext(chatId);
  if (resolved instanceof Response) {
    return resolved;
  }

  if (resolved.chat.status === "completed") {
    return errorResponse("Chat is completed", 409);
  }
  if (resolved.chat.sessionState?.sessionId !== sessionId) {
    return errorResponse("Eve session does not belong to this chat", 409);
  }

  return proxyTurnRequest(request, resolved, sessionId);
}

export async function proxyEveSessionStream(
  request: Request,
  chatId: string,
  sessionId: string,
): Promise<Response> {
  const resolved = await resolveProxyContext(chatId);
  if (resolved instanceof Response) {
    return resolved;
  }

  const session = resolved.chat.sessionState;
  if (session?.sessionId !== sessionId) {
    return errorResponse("Eve session does not belong to this chat", 409);
  }

  const requestUrl = new URL(request.url);
  const parsedStartIndex = parseStartIndex(requestUrl.searchParams.get("startIndex"));
  if (parsedStartIndex === null) {
    return errorResponse("Invalid stream startIndex", 400);
  }

  const abort = new AbortController();
  if (request.signal.aborted) {
    abort.abort();
  } else {
    request.signal.addEventListener("abort", () => abort.abort(), { once: true });
  }
  const iterator = resolved.client
    .session({
      sessionId,
      continuationToken: session.continuationToken,
      streamIndex: parsedStartIndex,
    })
    .stream({ startIndex: parsedStartIndex, signal: abort.signal })
    [Symbol.asyncIterator]();
  let first: IteratorResult<HandleMessageStreamEvent>;
  try {
    first = await iterator.next();
  } catch {
    return errorResponse("Unable to reach Eve agent", 502);
  }

  const persisted = createPersistedEventStream({
    abort,
    chat: resolved.chat,
    first,
    iterator,
    repository: resolved.repository,
    session,
    sessionId,
    startIndex: parsedStartIndex,
  });
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": NDJSON_CONTENT_TYPE,
  });

  return new Response(persisted, { status: 200, headers });
}

async function proxyTurnRequest(
  request: Request,
  context: ProxyContext,
  sessionId?: string,
): Promise<Response> {
  const input = await readObjectBody(request);
  if (input instanceof Response) {
    return input;
  }

  const body: Record<string, unknown> = { ...input };
  delete body.continuationToken;
  const currentSession = context.chat.sessionState;
  if (sessionId && currentSession?.continuationToken) {
    body.continuationToken = currentSession.continuationToken;
  }

  const path = sessionId
    ? `/eve/v1/session/${encodeURIComponent(sessionId)}`
    : "/eve/v1/session";
  let remote: Response;
  try {
    remote = await context.client.fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: request.signal,
    });
  } catch {
    await context.repository.updateChatStatus(context.chat.id, "failed");
    return errorResponse("Unable to reach Eve agent", 502);
  }

  if (!remote.ok) {
    await context.repository.updateChatStatus(context.chat.id, "failed");
    return forwardErrorResponse(remote);
  }

  const payload = await readResponseObject(remote);
  if (payload instanceof Response) {
    await context.repository.updateChatStatus(context.chat.id, "failed");
    return payload;
  }

  const resolvedSessionId =
    stringValue(payload.sessionId) ?? remote.headers.get("x-eve-session-id")?.trim() ?? sessionId;
  if (!resolvedSessionId) {
    await context.repository.updateChatStatus(context.chat.id, "failed");
    return errorResponse("Eve response did not include a session id", 502);
  }

  const isContinuing = currentSession?.sessionId === resolvedSessionId;
  const nextSession: SessionState = {
    sessionId: resolvedSessionId,
    continuationToken:
      stringValue(payload.continuationToken) ??
      (isContinuing ? currentSession?.continuationToken : undefined),
    streamIndex: isContinuing ? (currentSession?.streamIndex ?? 0) : 0,
  };
  await context.repository.updateChatSessionState(context.chat.id, nextSession, "active");
  await context.repository.clearPendingUserMessage(context.chat.id);

  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  headers.set("x-eve-session-id", resolvedSessionId);
  return new Response(
    JSON.stringify({ ...payload, continuationToken: EVE_PROXY_CONTINUATION_TOKEN }),
    { status: remote.status, headers },
  );
}

async function resolveProxyContext(chatId: string): Promise<ProxyContext | Response> {
  const repository = createRepository(getDbClient());
  const chat = await repository.getChat(chatId);
  if (!chat) {
    return errorResponse("Chat not found", 404);
  }

  const agent = await repository.getAgentConnection(chat.agentConnectionId);
  if (!agent) {
    return errorResponse("Agent connection not found", 404);
  }
  if (agent.status === "unreachable") {
    return errorResponse("Agent connection is unreachable", 409);
  }

  try {
    return { chat, repository, client: createEveClientForConnection(agent) };
  } catch {
    return errorResponse("Agent authentication configuration is invalid", 500);
  }
}

function createPersistedEventStream(input: {
  abort: AbortController;
  chat: Chat;
  first: IteratorResult<HandleMessageStreamEvent>;
  iterator: AsyncIterator<HandleMessageStreamEvent>;
  repository: Repository;
  session: SessionState;
  sessionId: string;
  startIndex: number;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let buffered: IteratorResult<HandleMessageStreamEvent> | null = input.first;
  let nextStreamIndex = input.startIndex;
  let latestCursor = input.session.streamIndex ?? 0;

  const persistEvent = async (event: HandleMessageStreamEvent): Promise<boolean> => {
    await input.repository.appendEvent({
      chatId: input.chat.id,
      sessionId: input.sessionId,
      streamIndex: nextStreamIndex,
      type: event.type,
      payload: event,
    });
    nextStreamIndex += 1;
    latestCursor = Math.max(latestCursor, nextStreamIndex);
    const status = chatStatusFromEvent(event);
    await input.repository.updateChatSessionState(
      input.chat.id,
      { ...input.session, streamIndex: latestCursor },
      status,
    );
    return status !== undefined;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = buffered ?? (await input.iterator.next());
        buffered = null;
        if (next.done) {
          controller.close();
          return;
        }

        const terminal = await persistEvent(next.value);
        controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
        if (terminal) {
          input.abort.abort();
          void input.iterator.return?.();
          controller.close();
        }
      } catch (error) {
        if (input.abort.signal.aborted) {
          controller.close();
        } else {
          controller.error(error);
        }
      }
    },
    cancel() {
      input.abort.abort();
      void input.iterator.return?.();
    },
  });
}

function chatStatusFromEvent(event: HandleMessageStreamEvent): Chat["status"] | undefined {
  if (event.type === "session.waiting") return "active";
  if (event.type === "session.completed") return "completed";
  if (event.type === "session.failed") return "failed";
  return undefined;
}

function parseStartIndex(value: string | null): number | null {
  if (value === null || value === "") return 0;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function readObjectBody(request: Request): Promise<Record<string, unknown> | Response> {
  try {
    const value = (await request.json()) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : errorResponse("Invalid Eve request body", 400);
  } catch {
    return errorResponse("Invalid JSON", 400);
  }
}

async function readResponseObject(response: Response): Promise<Record<string, unknown> | Response> {
  try {
    const value = (await response.json()) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : errorResponse("Eve returned an invalid response", 502);
  } catch {
    return errorResponse("Eve returned an invalid response", 502);
  }
}

async function forwardErrorResponse(response: Response): Promise<Response> {
  const body = await response.text();
  return new Response(body || JSON.stringify({ error: "Eve request failed" }), {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json; charset=utf-8" },
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function errorResponse(error: string, status: number): Response {
  return Response.json({ error }, { status });
}
