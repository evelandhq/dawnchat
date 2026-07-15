import type {
  AgentAuthFailure,
  AgentAuthFailureCode,
  AgentRequestInit,
} from "@/agent-auth/contracts";
import { getAgentAuthModule } from "@/agent-auth/runtime.server";
import {
  createRepository,
  type Chat,
  type Repository,
  type SessionState,
} from "@/db/repository";
import { getDbClient } from "@/db/provider";
import { EVE_PROXY_CONTINUATION_TOKEN } from "@/eve/proxy-contract";

const NDJSON_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";
const MAX_STREAM_INDEX = 2_147_483_647;
const MAX_NDJSON_RECORD_BYTES = 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

const AUTH_FAILURE_STATUS = {
  interaction_required: 401,
  credential_rejected: 401,
  forbidden: 403,
  configuration_invalid: 422,
  provider_unavailable: 503,
  upstream_unavailable: 502,
  retry_required: 409,
} satisfies Record<AgentAuthFailureCode, number>;

type ProxyContext = {
  chat: Chat;
  repository: Repository;
};

type EveStreamEvent = Record<string, unknown> & { type: string };

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

  const linkedAbort = linkAbortSignal(request.signal);
  const result = await getAgentAuthModule().request(
    authTarget(resolved.chat),
    {
      pathname: `/eve/v1/session/${encodeURIComponent(sessionId)}/stream`,
      searchParams: { startIndex: String(parsedStartIndex) },
    },
    { signal: linkedAbort.controller.signal },
    { chatId },
  );
  if (!(result instanceof Response)) {
    linkedAbort.detach();
    return agentAuthFailureResponse(result);
  }
  if (!result.ok) {
    try {
      return await forwardErrorResponse(result, {
        abort: linkedAbort.controller,
        signal: linkedAbort.controller.signal,
      });
    } finally {
      linkedAbort.detach();
    }
  }
  if (result.body === null) {
    linkedAbort.detach();
    linkedAbort.controller.abort(new Error("Eve stream response did not include a body"));
    return errorResponse("Eve returned an invalid stream response", 502);
  }

  const persisted = createPersistedEventStream({
    abort: linkedAbort.controller,
    chat: resolved.chat,
    detachRequestAbort: linkedAbort.detach,
    repository: resolved.repository,
    sessionId,
    source: result.body,
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

  const pathname = sessionId
    ? `/eve/v1/session/${encodeURIComponent(sessionId)}`
    : "/eve/v1/session";
  const init: AgentRequestInit = {
    method: "POST",
    jsonBody: body,
    signal: request.signal,
  };
  const result = await getAgentAuthModule().request(
    authTarget(context.chat),
    { pathname },
    init,
    { chatId: context.chat.id },
  );
  if (!(result instanceof Response)) {
    return agentAuthFailureResponse(result);
  }
  const remote = result;

  if (!remote.ok) {
    await context.repository.updateChatStatus(context.chat.id, "failed");
    return forwardErrorResponse(remote, { signal: request.signal });
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

  return { chat, repository };
}

function authTarget(chat: Chat): { agentConnectionId: string; principalId: string } {
  // Task 5 replaces this temporary value with the caller-principal cookie. All
  // methods available in Task 4 are connection-scoped, so no credential is keyed
  // or shared by this empty placeholder.
  return { agentConnectionId: chat.agentConnectionId, principalId: "" };
}

function createPersistedEventStream(input: {
  abort: AbortController;
  chat: Chat;
  detachRequestAbort: () => void;
  repository: Repository;
  sessionId: string;
  source: ReadableStream<Uint8Array>;
  startIndex: number;
}): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  const reader = input.source.getReader();
  let currentChunk: Uint8Array | undefined;
  let currentOffset = 0;
  let recordParts: Uint8Array[] = [];
  let recordByteLength = 0;
  let sourceDone = false;
  let nextStreamIndex = input.startIndex;
  let cancelPromise: Promise<void> | undefined;

  const cancelUpstream = (reason: unknown): Promise<void> => {
    input.detachRequestAbort();
    if (!input.abort.signal.aborted) {
      input.abort.abort(reason);
    }
    cancelPromise ??= reader.cancel(reason).catch(() => undefined);
    return cancelPromise;
  };

  const abortReader = () => {
    void cancelUpstream(input.abort.signal.reason);
  };
  if (input.abort.signal.aborted) {
    abortReader();
  } else {
    input.abort.signal.addEventListener("abort", abortReader, { once: true });
  }

  const appendRecordPart = (part: Uint8Array): void => {
    if (part.byteLength === 0) {
      return;
    }
    if (recordByteLength + part.byteLength > MAX_NDJSON_RECORD_BYTES) {
      throw new Error("Eve stream record exceeds the proxy limit");
    }
    recordParts.push(part);
    recordByteLength += part.byteLength;
  };

  const finishRecord = (): string => {
    const bytes = new Uint8Array(recordByteLength);
    let offset = 0;
    for (const part of recordParts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    recordParts = [];
    recordByteLength = 0;
    return decoder.decode(bytes).trim();
  };

  const persistEvent = async (
    event: EveStreamEvent,
  ): Promise<{ event: EveStreamEvent; terminal: boolean }> => {
    const requestedStatus = chatStatusFromEvent(event);
    const persistedStreamIndex = nextStreamIndex;
    const persisted = await input.repository.persistStreamEvent({
      chatId: input.chat.id,
      sessionId: input.sessionId,
      streamIndex: persistedStreamIndex,
      type: event.type,
      payload: event,
      status: requestedStatus,
    });
    nextStreamIndex += 1;
    const persistedEvent = validateStreamEvent(persisted.event.payload);
    const persistedCursor =
      persisted.chat.sessionState?.sessionId === input.sessionId
        ? (persisted.chat.sessionState.streamIndex ?? 0)
        : 0;
    const latestPersistedBoundary =
      !persisted.advanced && persistedStreamIndex + 1 === persistedCursor;
    return {
      event: persistedEvent,
      terminal:
        chatStatusFromEvent(persistedEvent) !== undefined &&
        (persisted.advanced || latestPersistedBoundary),
    };
  };

  const readEvent = async (): Promise<EveStreamEvent | null> => {
    while (true) {
      if (currentChunk !== undefined && currentOffset < currentChunk.byteLength) {
        const newline = currentChunk.indexOf(0x0a, currentOffset);
        if (newline >= 0) {
          appendRecordPart(currentChunk.subarray(currentOffset, newline));
          currentOffset = newline + 1;
          if (currentOffset >= currentChunk.byteLength) {
            currentChunk = undefined;
            currentOffset = 0;
          }
          const line = finishRecord();
          if (!line) {
            continue;
          }
          return parseStreamEvent(line);
        }

        appendRecordPart(currentChunk.subarray(currentOffset));
        currentChunk = undefined;
        currentOffset = 0;
        continue;
      }

      if (sourceDone) {
        if (input.abort.signal.aborted) {
          throw input.abort.signal.reason;
        }
        if (recordByteLength === 0) {
          return null;
        }
        const line = finishRecord();
        return line ? parseStreamEvent(line) : null;
      }

      if (input.abort.signal.aborted) {
        throw input.abort.signal.reason;
      }
      const next = await reader.read();
      if (next.done) {
        if (input.abort.signal.aborted) {
          throw input.abort.signal.reason;
        }
        sourceDone = true;
      } else {
        currentChunk = next.value;
        currentOffset = 0;
      }
    }
  };

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const event = await readEvent();
          if (event === null) {
            input.detachRequestAbort();
            controller.close();
            return;
          }

          const persisted = await persistEvent(event);
          controller.enqueue(encoder.encode(`${JSON.stringify(persisted.event)}\n`));
          if (persisted.terminal) {
            await cancelUpstream(undefined);
            controller.close();
          }
        } catch (error) {
          await cancelUpstream(error);
          controller.error(error);
        }
      },
      cancel(reason) {
        return cancelUpstream(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

function parseStreamEvent(line: string): EveStreamEvent {
  return validateStreamEvent(JSON.parse(line) as unknown);
}

function validateStreamEvent(value: unknown): EveStreamEvent {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("type" in value) ||
    typeof value.type !== "string" ||
    value.type.length === 0
  ) {
    throw new Error("Eve returned an invalid stream event");
  }
  return value as EveStreamEvent;
}

function chatStatusFromEvent(event: EveStreamEvent): Chat["status"] | undefined {
  if (event.type === "session.waiting") return "active";
  if (event.type === "session.completed") return "completed";
  if (event.type === "session.failed") return "failed";
  return undefined;
}

function linkAbortSignal(signal: AbortSignal): {
  controller: AbortController;
  detach: () => void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);

  if (signal.aborted) {
    abort();
    return { controller, detach: () => undefined };
  }

  signal.addEventListener("abort", abort, { once: true });
  return {
    controller,
    detach: () => signal.removeEventListener("abort", abort),
  };
}

function agentAuthFailureResponse(failure: AgentAuthFailure): Response {
  return Response.json(failure, { status: AUTH_FAILURE_STATUS[failure.code] });
}

function parseStartIndex(value: string | null): number | null {
  if (value === null || value === "") return 0;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAX_STREAM_INDEX ? parsed : null;
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

interface ForwardErrorOptions {
  readonly abort?: AbortController;
  readonly signal?: AbortSignal;
}

class UpstreamErrorBodyTooLargeError extends Error {
  constructor() {
    super("Eve error response exceeds the proxy limit");
    this.name = "UpstreamErrorBodyTooLargeError";
  }
}

async function forwardErrorResponse(
  response: Response,
  options: ForwardErrorOptions = {},
): Promise<Response> {
  if (response.status >= 300 && response.status < 400) {
    const reason = new Error("Eve returned an unexpected redirect");
    if (!options.abort?.signal.aborted) {
      options.abort?.abort(reason);
    }
    await response.body?.cancel(reason).catch(() => undefined);
    return errorResponse("Eve returned an unexpected redirect", 502);
  }

  let body: string;
  try {
    body = new TextDecoder().decode(
      await readBoundedResponseBody(response, options.signal, MAX_ERROR_BODY_BYTES),
    );
  } catch (error) {
    if (!(error instanceof UpstreamErrorBodyTooLargeError)) {
      throw error;
    }
    if (!options.abort?.signal.aborted) {
      options.abort?.abort(error);
    }
    return errorResponse("Eve returned an oversized error response", 502);
  }

  const headers = new Headers({
    "content-type":
      response.headers.get("content-type") ?? "application/json; charset=utf-8",
  });
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) {
    headers.set("retry-after", retryAfter);
  }
  return new Response(body || JSON.stringify({ error: "Eve request failed" }), {
    status: response.status,
    headers,
  });
}

async function readBoundedResponseBody(
  response: Response,
  signal: AbortSignal | undefined,
  limit: number,
): Promise<Uint8Array> {
  if (response.body === null) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const cancelForAbort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  if (signal?.aborted) {
    cancelForAbort();
  } else {
    signal?.addEventListener("abort", cancelForAbort, { once: true });
  }

  try {
    while (true) {
      if (signal?.aborted) {
        throw signal.reason;
      }
      const next = await reader.read();
      if (signal?.aborted) {
        throw signal.reason;
      }
      if (next.done) {
        break;
      }
      if (byteLength + next.value.byteLength > limit) {
        const error = new UpstreamErrorBodyTooLargeError();
        await reader.cancel(error).catch(() => undefined);
        throw error;
      }
      chunks.push(next.value);
      byteLength += next.value.byteLength;
    }
  } finally {
    signal?.removeEventListener("abort", cancelForAbort);
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function errorResponse(error: string, status: number): Response {
  return Response.json({ error }, { status });
}
