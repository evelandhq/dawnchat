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
import { collapseStreamedDeltas } from "@/eve/stream-projection";
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
  /** The Eveland Project behind a managed chat; the browser derives its Caller Token flow from it. */
  evelandProjectId: string | null;
  /** The browser-safe, ID-addressed Eve session cursor. */
  sessionState: ClientSessionState | null;
  /**
   * A session-create request was issued for this chat and never proved what
   * the Agent did with it. The initial message stays, and only an explicit
   * retry may send it again.
   */
  sessionCreateUnconfirmed: boolean;
  /** The proxy's pending-input ledger: batches Eve is still parked on. */
  pendingInput: PendingInputState;
  pendingUserMessage: UserContent | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * How many trailing text-bearing events a preview projects per chat. A turn
 * spans one event per step, so this covers the last message many times over.
 */
const CHAT_PREVIEW_EVENT_LIMIT = 32;

export type ChatSummaryResponse = Omit<
  ChatResponse,
  "pendingUserMessage" | "sessionState" | "pendingInput"
> & {
  agentName: string;
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
    const [agents, messageTails] = await Promise.all([
      repository.listAgentConnections(),
      repository.listMessageTailEvents(
        chats.map((chat) => chat.id),
        CHAT_PREVIEW_EVENT_LIMIT,
      ),
    ]);
    const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));
    const summaries = chats.map((chat) =>
      chatSummaryResponse(chat, agentNames, messageTails.get(chat.id) ?? []),
    );
    return applyAppBrowserSession(
      jsonResponse({ chats: summaries }),
      access.session,
    );
  } catch (error) {
    if (error instanceof CallerTokenError) return callerTokenErrorResponse(error);
    return jsonResponse({ error: "Internal server error" }, { status: 500 });
  }
}

export async function claimChats(request: Request): Promise<Response> {
  try {
    const access = await resolveChatAccess(request);
    if (!access.identity) {
      return jsonResponse(
        { error: "Eveland Identity is required to claim chats" },
        { status: 401 },
      );
    }
    const repository = createRepository(getDbClient());
    const claimed = await repository.claimChatsForClient(
      access.session.clientId,
      appIdentityScope(access.identity),
    );
    return applyAppBrowserSession(jsonResponse({ claimed }), access.session);
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
        events: collapseStreamedDeltas(events).map((event) => event.payload),
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
    evelandProjectId: chat.evelandProjectId,
    sessionState: chat.sessionState
      ? {
          sessionId: chat.sessionState.sessionId,
          streamIndex: chat.sessionState.streamIndex ?? 0,
        }
      : null,
    sessionCreateUnconfirmed: chat.sessionCreateUnconfirmedAt !== null,
    pendingInput: chat.pendingInput ?? EMPTY_PENDING_INPUT,
    pendingUserMessage: deserializePendingUserContent(chat.pendingUserMessage),
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
  };
}

/**
 * Projects the preview from the tail of a chat's text-bearing events. The
 * projection creates the message a `turnId` belongs to on demand, so a tail
 * yields the same last-message text a whole-stream replay would.
 */
function chatSummaryResponse(
  chat: Chat,
  agentNames: Map<string, string>,
  messageTail: EveEvent[],
): ChatSummaryResponse {
  const agentName = agentNames.get(chat.agentConnectionId);
  if (agentName === undefined) {
    throw new Error(`Agent connection not found for chat ${chat.id}`);
  }
  const reducer = defaultMessageReducer();
  const projection = messageTail.reduce(
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
    agentName,
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
