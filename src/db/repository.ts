import { asc, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { z } from "zod";

import { createId } from "@/lib/ids";
import {
  agentConnections,
  chats,
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

export type Repository = {
  createAgentConnection(input: CreateAgentConnectionInput): Promise<AgentConnection>;
  listAgentConnections(): Promise<AgentConnection[]>;
  getAgentConnection(id: string): Promise<AgentConnection | null>;
  updateAgentHealth(id: string, input: UpdateAgentHealthInput): Promise<AgentConnection>;
  createChat(input: CreateChatInput): Promise<Chat>;
  getChat(id: string): Promise<Chat | null>;
  appendMessage(input: AppendMessageInput): Promise<Message>;
  listMessages(chatId: string): Promise<Message[]>;
  updateChatSessionState(chatId: string, state: SessionState): Promise<Chat>;
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

    async updateChatSessionState(chatId, state) {
      const updated = db
        .update(chats)
        .set({
          sessionStateJson: JSON.stringify(state),
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
  };
}
