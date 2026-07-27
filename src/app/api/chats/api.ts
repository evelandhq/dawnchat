import { defaultMessageReducer, type HandleMessageStreamEvent } from "eve/client";

import { createRepository, type Chat, type Repository, type SessionState } from "@/db/repository";
import { getDbClient } from "@/db/provider";
import { createChatSchema } from "@/lib/validation";
import {
  CallerTokenError,
  callerTokenErrorResponse,
  getCallerTokenVerifier,
  type CallerIdentity,
} from "@/identity/server";

export type ChatResponse = {
  id: string;
  agentConnectionId: string;
  title: string;
  status: Chat["status"];
  sessionState: Omit<SessionState, "continuationToken"> | null;
  pendingUserMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ChatSummaryResponse = Omit<ChatResponse, "sessionState"> & {
  lastMessage: string | null;
};

export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init);
}

export async function listChats(request: Request): Promise<Response> {
  try {
    const identity = await authenticateCaller(request);
    const repository = createRepository(getDbClient());
    const chats = await repository.listChatsForIdentity(identityScope(identity));
    const summaries = await Promise.all(chats.map((chat) => chatSummaryResponse(repository, chat)));
    return jsonResponse({ chats: summaries });
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
    if (!agent.evelandProjectId) {
      return jsonResponse(
        { error: "Agent is not connected to Eveland Identity" },
        { status: 409 },
      );
    }
    if (agent.authType !== "none" || agent.authConfigEncrypted) {
      return jsonResponse(
        { error: "Eveland project identity conflicts with legacy Agent auth" },
        { status: 409 },
      );
    }
    const identity = await authenticateCaller(request, agent.evelandProjectId);
    if (agent.status === "unreachable") {
      return jsonResponse({ error: "Agent connection is unreachable" }, { status: 409 });
    }

    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: parsed.data.message.slice(0, 80),
      pendingUserMessage: parsed.data.message,
      ownerIdentityPrincipalId: identity.principalId,
      ownerIdentityRealmId: identity.realmId,
      evelandProjectId: identity.projectId,
    });
    return jsonResponse({ chat: chatResponse(chat) }, { status: 201 });
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
    const identity = await authenticateCaller(request);
    const repository = createRepository(getDbClient());
    const chat = await repository.getChatForIdentity(chatId, identityScope(identity));
    if (!chat) return jsonResponse({ error: "Chat not found" }, { status: 404 });
    const [agent, events] = await Promise.all([
      repository.getAgentConnection(chat.agentConnectionId),
      repository.listEvents(chat.id),
    ]);
    if (!agent || agent.evelandProjectId !== identity.projectId) {
      return jsonResponse({ error: "Chat not found" }, { status: 404 });
    }
    return jsonResponse({
      chat: {
        ...chatResponse(chat),
        agentName: agent.name,
      },
      events: events.map((event) => event.payload),
    });
  } catch (error) {
    if (error instanceof CallerTokenError) return callerTokenErrorResponse(error);
    return jsonResponse({ error: "Internal server error" }, { status: 500 });
  }
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
    pendingUserMessage: chat.pendingUserMessage,
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
  };
}

async function chatSummaryResponse(repository: Repository, chat: Chat): Promise<ChatSummaryResponse> {
  const reducer = defaultMessageReducer();
  const events = await repository.listEvents(chat.id);
  const projection = events.reduce(
    (data, event) => reducer.reduce(data, event.payload as HandleMessageStreamEvent),
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
  const { sessionState: _sessionState, ...summary } = chatResponse(chat);
  return { ...summary, lastMessage };
}

async function authenticateCaller(
  request: Request,
  expectedProjectId?: string,
): Promise<CallerIdentity> {
  return getCallerTokenVerifier().verifyAuthorization(
    request.headers.get("authorization"),
    expectedProjectId,
  );
}

function identityScope(identity: CallerIdentity) {
  return {
    principalId: identity.principalId,
    realmId: identity.realmId,
    projectId: identity.projectId,
  };
}
