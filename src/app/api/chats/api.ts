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

/**
 * One NDJSON line of the streaming send-message response. `delta` carries the
 * full assistant text so far (not an increment); `message` marks one assistant
 * message as completed; `done`/`error` are terminal and carry the persisted
 * authoritative state.
 */
export type ChatStreamLine =
  | { type: "delta"; message: string }
  | { type: "message"; message: string }
  | { type: "done"; chat: ChatResponse; messages: MessageResponse[] }
  | { type: "error"; error: string; chat?: ChatResponse; messages?: MessageResponse[] };

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
    if (chat.status === "completed") {
      return jsonResponse({ error: "Chat is completed" }, { status: 409 });
    }
    // A failed chat legitimately has no session state when its first turn never
    // finished; the turn below then starts a fresh session. On an active chat a
    // missing state is corrupt.
    if (chat.status === "active" && !chat.sessionState) {
      return jsonResponse({ error: "Chat session state is missing" }, { status: 409 });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (line: ChatStreamLine) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        try {
          await repository.appendMessage({
            chatId: chat.id,
            role: "user",
            content: parsed.data.message,
            eventIndex: chat.sessionState?.streamIndex ?? null,
          });

          const turn = streamEveTurn(repository, chat, agent, parsed.data.message);
          let step = await turn.next();
          while (!step.done) {
            const update = step.value;
            if (update.type === "message.appended") {
              send({ type: "delta", message: update.message });
            }
            if (update.type === "message.completed" && update.message !== null) {
              send({ type: "message", message: update.message });
            }
            step = await turn.next();
          }

          const messages = await repository.listMessages(chat.id);
          send({ type: "done", chat: chatResponse(step.value), messages: messages.map(messageResponse) });
        } catch {
          try {
            const failed = await repository.updateChatStatus(chat.id, "failed");
            const messages = await repository.listMessages(chat.id);
            send({ type: "error", error: "Eve turn failed", chat: chatResponse(failed), messages: messages.map(messageResponse) });
          } catch {
            send({ type: "error", error: "Eve turn failed" });
          }
        } finally {
          controller.close();
        }
      },
    });

    // Streaming starts after the guards, so guard failures keep real HTTP
    // status codes; turn failures surface as an in-stream `error` line
    // because the 200 header is already on the wire by then.
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
    });
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
  const turn = streamEveTurn(repository, chat, agent, message);
  let step = await turn.next();
  while (!step.done) {
    step = await turn.next();
  }
  return step.value;
}

async function* streamEveTurn(
  repository: Repository,
  chat: Chat,
  agent: Parameters<typeof sendEveTurn>[0],
  message: string,
): AsyncGenerator<EveTurnUpdate, Chat, void> {
  // A failed turn can leave events persisted past the saved streamIndex, and
  // (chatId, eventIndex) is unique — a retry must resume numbering after
  // whichever is furthest or its inserts collide.
  const persistedEvents = await repository.listEvents(chat.id);
  const lastPersistedIndex = persistedEvents.reduce((max, event) => Math.max(max, event.eventIndex), 0);
  const baseIndex = Math.max(chat.sessionState?.streamIndex ?? 0, lastPersistedIndex);
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
    if (update.type === "session.waiting") {
      // Explicit so a successful retry flips a failed chat back to active.
      latestStatus = "active";
    }
    if (update.type === "session.completed") {
      latestStatus = "completed";
    }
    if (update.type === "session.failed") {
      latestStatus = "failed";
    }

    yield update;
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
