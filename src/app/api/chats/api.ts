import {
  defaultMessageReducer,
  type ClientSessionState,
  type MessageStreamEvent,
} from "eve/client";
import type { UserContent } from "ai";

import {
  applyAppBrowserSession,
  resolveAppBrowserSession,
  type AppBrowserSession,
} from "@/app-session";
import { resolveProxyChat } from "@/app/api/chats/eve-proxy";
import { createRepository, type Chat, type EveEvent, type Repository } from "@/db/repository";
import { getDbClient } from "@/db/provider";
import {
  derivePendingInput,
  EMPTY_PENDING_INPUT,
  type PendingInputState,
} from "@/eve/proxy-contract";
import {
  deserializePendingUserContent,
  serializePendingUserContent,
  userContentText,
} from "@/lib/chat-messages";
import { createChatSchema } from "@/lib/validation";
import {
  CallerTokenError,
  callerTokenErrorResponse,
  getCallerTokenVerifier,
  type AppIdentity,
} from "@/identity/server";

export type ChatResponse = {
  id: string;
  agentConnectionId: string;
  title: string;
  status: Chat["status"];
  /** The ID-addressed cursor only; a 0.29/0.30 token never leaves the server. */
  sessionState: ClientSessionState | null;
  /** The proxy's pending-input ledger: batches Eve is still parked on. */
  pendingInput: PendingInputState;
  pendingUserMessage: UserContent | null;
  createdAt: string;
  updatedAt: string;
};

export type ChatSummaryResponse = Omit<
  ChatResponse,
  "pendingUserMessage" | "sessionState" | "pendingInput"
> & {
  agentName: string;
  evelandProjectId: string | null;
  lastMessage: string | null;
  pendingUserMessage: string | null;
};

export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init);
}

export async function listChats(request: Request): Promise<Response> {
  try {
    const access = await resolveChatAccess(request);
    const repository = createRepository(getDbClient());
    const clientChats = await repository.listChatsForClient(
      access.session.clientId,
    );
    const identityChats = access.identity
      ? await repository.listChatsForAppIdentity(
          appIdentityScope(access.identity),
        )
      : [];
    const chats = uniqueChats([...identityChats, ...clientChats]);
    const summaries = await Promise.all(chats.map((chat) => chatSummaryResponse(repository, chat)));
    return applyAppBrowserSession(
      jsonResponse({ chats: summaries }),
      access.session,
    );
  } catch (error) {
    if (error instanceof CallerTokenError) return callerTokenErrorResponse(error);
    return jsonResponse({ error: "Internal server error" }, { status: 500 });
  }
}

export async function createChatWithFirstMessage(
  request: Request,
  body: unknown,
): Promise<Response> {
  const parsed = createChatSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse({ error: "Invalid chat request" }, { status: 400 });
  }

  try {
    const repository = createRepository(getDbClient());
    const agent = await repository.getAgentConnection(parsed.data.agentId);
    if (!agent) {
      return jsonResponse({ error: "Agent connection not found" }, { status: 404 });
    }
    const access = await resolveChatAccess(request);
    if (agent.status === "unreachable") {
      return jsonResponse({ error: "Agent connection is unreachable" }, { status: 409 });
    }
    const messageText = userContentText(parsed.data.message);
    const firstFile = Array.isArray(parsed.data.message)
      ? parsed.data.message.find((part) => part.type === "file")
      : undefined;
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: (messageText || firstFile?.filename || "New chat").slice(0, 80),
      pendingUserMessage: serializePendingUserContent(parsed.data.message),
      ownerClientId: access.session.clientId,
      ownerIdentityIssuer: access.identity?.issuer,
      ownerIdentityPrincipalId: access.identity?.principalId,
      ownerIdentityRealmId: access.identity?.realmId,
      evelandProjectId: agent.evelandProjectId,
    });
    return applyAppBrowserSession(
      jsonResponse({ chat: chatResponse(chat) }, { status: 201 }),
      access.session,
    );
  } catch (error) {
    if (error instanceof CallerTokenError) return callerTokenErrorResponse(error);
    return jsonResponse({ error: "Internal server error" }, { status: 500 });
  }
}

export async function getChatWithEvents(
  request: Request,
  chatId: string,
): Promise<Response> {
  try {
    const access = await resolveChatAccess(request);
    const repository = createRepository(getDbClient());
    const clientChat = await repository.getChatForClient(
      chatId,
      access.session.clientId,
    );
    const chat =
      clientChat ??
      (access.identity
        ? await repository.getChatForAppIdentity(
            chatId,
            appIdentityScope(access.identity),
          )
        : null);
    if (!chat) return jsonResponse({ error: "Chat not found" }, { status: 404 });
    const [agent, events] = await Promise.all([
      repository.getAgentConnection(chat.agentConnectionId),
      repository.listEvents(chat.id),
    ]);
    if (!agent) {
      return jsonResponse({ error: "Chat not found" }, { status: 404 });
    }
    const pendingInput = await ensurePendingInput(repository, chat, events);
    return applyAppBrowserSession(
      jsonResponse({
        chat: {
          ...chatResponse(chat),
          pendingInput,
          agentName: agent.name,
        },
        events: events.map((event) => event.payload),
      }),
      access.session,
    );
  } catch (error) {
    if (error instanceof CallerTokenError) return callerTokenErrorResponse(error);
    return jsonResponse({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * Serves the current ledger alone; the client refetches it to reconcile.
 * Shares the proxy's chat resolution so a Caller Token — what the thread
 * holds after an Eveland challenge — can read it too.
 */
export async function getChatPendingInput(
  request: Request,
  chatId: string,
): Promise<Response> {
  try {
    const resolved = await resolveProxyChat(request, chatId);
    if (resolved instanceof Response) {
      return resolved;
    }
    const pendingInput = await ensurePendingInput(resolved.repository, resolved.chat);
    return jsonResponse({ pendingInput });
  } catch (error) {
    if (error instanceof CallerTokenError) return callerTokenErrorResponse(error);
    return jsonResponse({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * A chat from before the ledger derives its state from stored events once,
 * and the result is written back so every later read is authoritative. The
 * conditional write leaves a concurrently persisted state untouched.
 */
async function ensurePendingInput(
  repository: Repository,
  chat: Chat,
  events?: EveEvent[],
): Promise<PendingInputState> {
  if (chat.pendingInput) {
    return chat.pendingInput;
  }
  const stored = events ?? (await repository.listEvents(chat.id));
  const derived = derivePendingInput({
    events: stored,
    sessionId: chat.sessionState?.sessionId,
    active: chat.status === "active",
  });
  const persisted = await repository.updatePendingInput(chat.id, (current) =>
    current === null ? derived : null,
  );
  return persisted ?? derived;
}

function chatResponse(chat: Chat): ChatResponse {
  return {
    id: chat.id,
    agentConnectionId: chat.agentConnectionId,
    title: chat.title,
    status: chat.status,
    sessionState: chat.sessionState
      ? {
          sessionId: chat.sessionState.sessionId,
          streamIndex: chat.sessionState.streamIndex ?? 0,
        }
      : null,
    pendingInput: chat.pendingInput ?? EMPTY_PENDING_INPUT,
    pendingUserMessage: deserializePendingUserContent(chat.pendingUserMessage),
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
  };
}

async function chatSummaryResponse(repository: Repository, chat: Chat): Promise<ChatSummaryResponse> {
  const reducer = defaultMessageReducer();
  const [agent, events] = await Promise.all([
    repository.getAgentConnection(chat.agentConnectionId),
    repository.listEvents(chat.id),
  ]);
  if (!agent) {
    throw new Error(`Agent connection not found for chat ${chat.id}`);
  }
  const projection = events.reduce(
    (data, event) => reducer.reduce(data, event.payload as MessageStreamEvent),
    reducer.initial(),
  );
  const lastMessage = [...projection.messages]
    .reverse()
    .map((message) =>
      message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
    )
    .find((text) => text.length > 0) ?? null;
  const {
    sessionState: _sessionState,
    pendingInput: _pendingInput,
    ...summary
  } = chatResponse(chat);
  return {
    ...summary,
    agentName: agent.name,
    evelandProjectId: chat.evelandProjectId,
    lastMessage,
    pendingUserMessage: summary.pendingUserMessage
      ? userContentText(summary.pendingUserMessage).trim() || null
      : null,
  };
}

async function resolveChatAccess(request: Request): Promise<{
  identity: AppIdentity | null;
  session: AppBrowserSession;
}> {
  const session = resolveAppBrowserSession(request);
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    return { identity: null, session };
  }
  const identity = await getCallerTokenVerifier().verifyAppAuthorization(
    authorization,
    process.env.NEXT_PUBLIC_EVELAND_IDENTITY_RETURN_TARGET ?? "eve-chats",
  );
  return { identity, session };
}

function appIdentityScope(identity: AppIdentity) {
  return {
    issuer: identity.issuer,
    principalId: identity.principalId,
    realmId: identity.realmId,
  };
}

function uniqueChats(chats: Chat[]): Chat[] {
  return [
    ...new Map(chats.map((chat) => [chat.id, chat])).values(),
  ].sort(
    (left, right) =>
      right.createdAt.getTime() - left.createdAt.getTime() ||
      right.id.localeCompare(left.id),
  );
}
