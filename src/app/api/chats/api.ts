import { createRepository, type Chat, type Message, type Repository, type SessionState as ChatSessionState } from "@/db/repository";
import { getDbClient } from "@/db/provider";
import { sendEveTurn, type EveTurnUpdate, type SessionState as EveClientSessionState } from "@/eve/client";
import { createChatSchema, sendMessageSchema } from "@/lib/validation";

export type ChatResponse = {
  id: string;
  agentConnectionId: string;
  title: string;
  status: Chat["status"];
  sessionState: ChatSessionState | null;
  createdAt: string;
  updatedAt: string;
};

export type ChatSummaryResponse = Omit<ChatResponse, "sessionState"> & {
  lastMessage: string | null;
};

export type MessageResponse = {
  id: string;
  chatId: string;
  role: Message["role"];
  content: string;
  eventIndex: number | null;
  createdAt: string;
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
      title: createChatTitle(parsed.data.message),
    });
    await repository.appendMessage({ chatId: chat.id, role: "user", content: parsed.data.message, eventIndex: 0 });

    try {
      const completed = await persistEveTurn(repository, chat, agent, parsed.data.message);
      const messages = await repository.listMessages(chat.id);

      return jsonResponse({ chat: chatResponse(completed), messages: messages.map(messageResponse) }, { status: 201 });
    } catch {
      const failed = await repository.updateChatStatus(chat.id, "failed");
      const messages = await repository.listMessages(chat.id);
      return jsonResponse({ chat: chatResponse(failed), messages: messages.map(messageResponse), error: "Eve turn failed" }, { status: 502 });
    }
  } catch {
    return jsonResponse({ error: "Internal server error" }, { status: 500 });
  }
}

export async function sendChatMessage(chatId: string, body: unknown): Promise<Response> {
  const parsed = sendMessageSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse({ error: "Invalid message request" }, { status: 400 });
  }

  try {
    const repository = createRepository(getDbClient());
    const chat = await repository.getChat(chatId);
    if (!chat) {
      return jsonResponse({ error: "Chat not found" }, { status: 404 });
    }

    const agent = await repository.getAgentConnection(chat.agentConnectionId);
    if (!agent) {
      return jsonResponse({ error: "Agent connection not found" }, { status: 404 });
    }
    if (agent.status === "unreachable") {
      return jsonResponse({ error: "Agent connection is unreachable" }, { status: 409 });
    }
    if (chat.status !== "active") {
      return jsonResponse({ error: "Chat is not active" }, { status: 409 });
    }
    if (!chat.sessionState) {
      return jsonResponse({ error: "Chat session state is missing" }, { status: 409 });
    }

    try {
      await repository.appendMessage({
        chatId: chat.id,
        role: "user",
        content: parsed.data.message,
        eventIndex: chat.sessionState.streamIndex ?? null,
      });

      const completed = await persistEveTurn(repository, chat, agent, parsed.data.message);
      const messages = await repository.listMessages(chat.id);

      return jsonResponse({ chat: chatResponse(completed), messages: messages.map(messageResponse) });
    } catch {
      const failed = await repository.updateChatStatus(chat.id, "failed");
      const messages = await repository.listMessages(chat.id);
      return jsonResponse({ chat: chatResponse(failed), messages: messages.map(messageResponse), error: "Eve turn failed" }, { status: 502 });
    }
  } catch {
    return jsonResponse({ error: "Internal server error" }, { status: 500 });
  }
}

function createChatTitle(message: string): string {
  return message.trim().slice(0, 80);
}

async function persistEveTurn(
  repository: Repository,
  chat: Chat,
  agent: Parameters<typeof sendEveTurn>[0],
  message: string,
): Promise<Chat> {
  const baseIndex = chat.sessionState?.streamIndex ?? 0;
  let eventOffset = 0;
  let latestSessionState: ChatSessionState | null = chat.sessionState;
  let latestStatus: Chat["status"] | undefined;

  const eveSessionState = toEveClientSessionState(chat.sessionState);
  for await (const update of sendEveTurn(agent, eveSessionState, message)) {
    eventOffset += 1;
    const eventIndex = baseIndex + eventOffset;
    await repository.appendEvent({ chatId: chat.id, eventIndex, type: update.type, payload: update.raw });

    if (update.type === "message.completed" && update.message !== null) {
      await repository.appendMessage({ chatId: chat.id, role: "assistant", content: update.message, eventIndex });
    }

    const terminalState = sessionStateFromUpdate(update);
    if (terminalState) {
      latestSessionState = terminalState;
    }
    if (update.type === "session.completed") {
      latestStatus = "completed";
    }
    if (update.type === "session.failed") {
      latestStatus = "failed";
    }
  }

  if (latestSessionState) {
    return repository.updateChatSessionState(chat.id, latestSessionState, latestStatus);
  }
  if (latestStatus) {
    return repository.updateChatStatus(chat.id, latestStatus);
  }

  return chat;
}

function sessionStateFromUpdate(update: EveTurnUpdate): ChatSessionState | null {
  switch (update.type) {
    case "session.waiting":
    case "session.completed":
      return toRepositorySessionState(update.sessionState);
    case "session.failed":
      return update.sessionState ? toRepositorySessionState(update.sessionState) : null;
    default:
      return null;
  }
}

function toEveClientSessionState(state: ChatSessionState | null): EveClientSessionState | null {
  if (!state) {
    return null;
  }

  return {
    sessionId: state.sessionId,
    continuationToken: state.continuationToken,
    streamIndex: state.streamIndex ?? 0,
  };
}

function toRepositorySessionState(state: EveClientSessionState | null | undefined): ChatSessionState | null {
  if (!state?.sessionId) {
    return null;
  }

  return {
    sessionId: state.sessionId,
    continuationToken: state.continuationToken,
    streamIndex: state.streamIndex,
  };
}

function chatResponse(chat: Chat): ChatResponse {
  return {
    id: chat.id,
    agentConnectionId: chat.agentConnectionId,
    title: chat.title,
    status: chat.status,
    sessionState: chat.sessionState,
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
  };
}

async function chatSummaryResponse(repository: Repository, chat: Chat): Promise<ChatSummaryResponse> {
  const messages = await repository.listMessages(chat.id);
  const lastMessage = messages.at(-1)?.content ?? null;
  const { sessionState: _sessionState, ...summary } = chatResponse(chat);
  return { ...summary, lastMessage };
}

function messageResponse(message: Message): MessageResponse {
  return {
    id: message.id,
    chatId: message.chatId,
    role: message.role,
    content: message.content,
    eventIndex: message.eventIndex,
    createdAt: message.createdAt.toISOString(),
  };
}
