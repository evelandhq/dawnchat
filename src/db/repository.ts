import { asc, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { z } from "zod";

import { createId } from "@/lib/ids";
import {
  agentConnections,
  chats,
  events,
  type AgentConnectionStatus,
  type AuthType,
  type ChatStatus,
  type MessageRole,
  messages,
  schema,
} from "@/db/schema";

export type RepositoryDb = BetterSQLite3Database<typeof schema>;

export type SessionState = z.infer<typeof sessionStateSchema>;

const sessionStateSchema = z.object({
  sessionId: z.string().min(1),
  continuationToken: z.string().optional(),
  streamIndex: z.number().int().nonnegative().optional(),
});

export type AgentConnection = typeof agentConnections.$inferSelect;
export type Chat = Omit<typeof chats.$inferSelect, "sessionStateJson"> & {
  sessionState: SessionState | null;
};
export type Message = typeof messages.$inferSelect;
export type EveEvent = Omit<typeof events.$inferSelect, "payloadJson"> & {
  payload: unknown;
};

export type CreateAgentConnectionInput = {
  name: string;
  baseUrl: string;
  authType: AuthType;
  authConfigEncrypted?: string | null;
};

export type UpdateAgentHealthInput = {
  status: AgentConnectionStatus;
  lastCheckedAt?: Date | null;
};

export type CreateChatInput = {
  agentConnectionId: string;
  title: string;
};

export type AppendMessageInput = {
  chatId: string;
  role: MessageRole;
  content: string;
  eventIndex?: number | null;
};

export type AppendEventInput = {
  chatId: string;
  eventIndex: number;
  type: string;
  payload: unknown;
};

export type Repository = {
  createAgentConnection(input: CreateAgentConnectionInput): Promise<AgentConnection>;
  listAgentConnections(): Promise<AgentConnection[]>;
  getAgentConnection(id: string): Promise<AgentConnection | null>;
  updateAgentHealth(id: string, input: UpdateAgentHealthInput): Promise<AgentConnection>;
  createChat(input: CreateChatInput): Promise<Chat>;
  listChats(): Promise<Chat[]>;
  getChat(id: string): Promise<Chat | null>;
  appendMessage(input: AppendMessageInput): Promise<Message>;
  listMessages(chatId: string): Promise<Message[]>;
  appendEvent(input: AppendEventInput): Promise<EveEvent>;
  listEvents(chatId: string): Promise<EveEvent[]>;
  updateChatSessionState(chatId: string, state: SessionState, status?: ChatStatus): Promise<Chat>;
  updateChatStatus(chatId: string, status: ChatStatus): Promise<Chat>;
};

function parseSessionState(sessionStateJson: string | null): SessionState | null {
  if (sessionStateJson === null) {
    return null;
  }

  try {
    return sessionStateSchema.parse(JSON.parse(sessionStateJson));
  } catch {
    throw new Error("Stored chat session state is invalid");
  }
}

function mapChat(row: typeof chats.$inferSelect): Chat {
  return {
    ...row,
    sessionState: parseSessionState(row.sessionStateJson),
  };
}

function parseEventPayload(payloadJson: string): unknown {
  try {
    return JSON.parse(payloadJson);
  } catch {
    throw new Error("Stored Eve event payload is invalid");
  }
}

function mapEvent(row: typeof events.$inferSelect): EveEvent {
  const { payloadJson, ...rest } = row;
  return {
    ...rest,
    payload: parseEventPayload(payloadJson),
  };
}

export function createRepository(db: RepositoryDb): Repository {
  return {
    async createAgentConnection(input) {
      const now = new Date();
      const record: typeof agentConnections.$inferInsert = {
        id: createId("agent"),
        name: input.name,
        baseUrl: input.baseUrl,
        authType: input.authType,
        authConfigEncrypted: input.authConfigEncrypted ?? null,
        status: "unknown",
        lastCheckedAt: null,
        createdAt: now,
        updatedAt: now,
      };

      return db.insert(agentConnections).values(record).returning().get();
    },

    async listAgentConnections() {
      return db.select().from(agentConnections).orderBy(asc(agentConnections.createdAt), asc(agentConnections.id));
    },

    async getAgentConnection(id) {
      return db.select().from(agentConnections).where(eq(agentConnections.id, id)).get() ?? null;
    },

    async updateAgentHealth(id, input) {
      const hasLastCheckedAt = Object.hasOwn(input, "lastCheckedAt");
      const updated = db
        .update(agentConnections)
        .set({
          status: input.status,
          lastCheckedAt: hasLastCheckedAt ? input.lastCheckedAt : new Date(),
          updatedAt: new Date(),
        })
        .where(eq(agentConnections.id, id))
        .returning()
        .get();

      if (!updated) {
        throw new Error(`Agent connection not found: ${id}`);
      }

      return updated;
    },

    async createChat(input) {
      const now = new Date();
      const record: typeof chats.$inferInsert = {
        id: createId("chat"),
        agentConnectionId: input.agentConnectionId,
        title: input.title,
        sessionStateJson: null,
        status: "active" satisfies ChatStatus,
        createdAt: now,
        updatedAt: now,
      };

      const created = db.insert(chats).values(record).returning().get();
      return mapChat(created);
    },

    async listChats() {
      const rows = await db.select().from(chats).orderBy(asc(chats.createdAt), asc(chats.id));
      return rows.map(mapChat);
    },

    async getChat(id) {
      const row = db.select().from(chats).where(eq(chats.id, id)).get();
      return row ? mapChat(row) : null;
    },

    async appendMessage(input) {
      const record: typeof messages.$inferInsert = {
        id: createId("msg"),
        chatId: input.chatId,
        role: input.role,
        content: input.content,
        eventIndex: input.eventIndex ?? null,
        createdAt: new Date(),
      };

      return db.insert(messages).values(record).returning().get();
    },

    async listMessages(chatId) {
      return db
        .select()
        .from(messages)
        .where(eq(messages.chatId, chatId))
        .orderBy(sql`${messages.eventIndex} IS NULL`, asc(messages.eventIndex), asc(messages.createdAt), asc(messages.id));
    },

    async appendEvent(input) {
      const record: typeof events.$inferInsert = {
        id: createId("evt"),
        chatId: input.chatId,
        eventIndex: input.eventIndex,
        type: input.type,
        payloadJson: JSON.stringify(input.payload),
        createdAt: new Date(),
      };

      return mapEvent(db.insert(events).values(record).returning().get());
    },

    async listEvents(chatId) {
      const rows = await db
        .select()
        .from(events)
        .where(eq(events.chatId, chatId))
        .orderBy(asc(events.eventIndex), asc(events.id));
      return rows.map(mapEvent);
    },

    async updateChatSessionState(chatId, state, status) {
      const updated = db
        .update(chats)
        .set({
          sessionStateJson: JSON.stringify(state),
          ...(status ? { status } : {}),
          updatedAt: new Date(),
        })
        .where(eq(chats.id, chatId))
        .returning()
        .get();

      if (!updated) {
        throw new Error(`Chat not found: ${chatId}`);
      }

      return mapChat(updated);
    },

    async updateChatStatus(chatId, status) {
      const updated = db
        .update(chats)
        .set({ status, updatedAt: new Date() })
        .where(eq(chats.id, chatId))
        .returning()
        .get();

      if (!updated) {
        throw new Error(`Chat not found: ${chatId}`);
      }

      return mapChat(updated);
    },
  };
}
