import { defaultMessageReducer, type HandleMessageStreamEvent } from "eve/client";

import { createRepository, type Chat, type Repository, type SessionState } from "@/db/repository";
import { getDbClient } from "@/db/provider";
import { createChatSchema } from "@/lib/validation";

export type ChatResponse = {
  id: string;
  agentConnectionId: string;
  title: string;
  status: Chat["status"];
  sessionState: SessionState | null;
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

export async function listChats(): Promise<Response> {
  try {
    const repository = createRepository(getDbClient());
    const chats = await repository.listChats();
    const summaries = await Promise.all(chats.map((chat) => chatSummaryResponse(repository, chat)));
    return jsonResponse({ chats: summaries });
  } catch {
    return jsonResponse({ error: "Internal server error" }, { status: 500 });
  }
}

export async function createChatWithFirstMessage(body: unknown): Promise<Response> {
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
    if (agent.status === "unreachable") {
      return jsonResponse({ error: "Agent connection is unreachable" }, { status: 409 });
    }

    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: parsed.data.message.slice(0, 80),
      pendingUserMessage: parsed.data.message,
    });
    return jsonResponse({ chat: chatResponse(chat) }, { status: 201 });
  } catch {
    return jsonResponse({ error: "Internal server error" }, { status: 500 });
  }
}

function chatResponse(chat: Chat): ChatResponse {
  return {
    id: chat.id,
    agentConnectionId: chat.agentConnectionId,
    title: chat.title,
    status: chat.status,
    sessionState: chat.sessionState,
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
