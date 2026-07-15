import { isDeepStrictEqual } from "node:util";

import { and, asc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { DatabaseError } from "pg";
import { z } from "zod";

import { createId } from "@/lib/ids";
import {
  agentConnections,
  chats,
  events,
  type AgentConnectionStatus,
  type AuthType,
  type ChatStatus,
  schema,
} from "@/db/schema";

export type RepositoryDb = NodePgDatabase<typeof schema>;

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
export type EveEvent = Omit<typeof events.$inferSelect, "payloadJson"> & {
  payload: unknown;
};

export type CreateAgentConnectionInput = {
  name: string;
  baseUrl: string;
  authType: AuthType;
  authConfigEncrypted?: string | null;
};

export type UpdateAgentConnectionInput = {
  name: string;
  baseUrl: string;
  authType: AuthType;
  authConfigEncrypted: string | null;
};

export type UpdateAgentHealthInput = {
  status: AgentConnectionStatus;
  lastCheckedAt?: Date | null;
};

export type CreateChatInput = {
  agentConnectionId: string;
  title: string;
  pendingUserMessage?: string | null;
};

export type AppendEventInput = {
  chatId: string;
  type: string;
  payload: unknown;
} & (
  | {
      eventIndex: number;
      sessionId?: never;
      streamIndex?: never;
    }
  | {
      eventIndex?: never;
      sessionId: string;
      streamIndex: number;
    }
);

export type PersistStreamEventInput = {
  chatId: string;
  sessionId: string;
  streamIndex: number;
  type: string;
  payload: unknown;
  status?: ChatStatus;
};

export type PersistStreamEventResult = {
  event: EveEvent;
  inserted: boolean;
  advanced: boolean;
  chat: Chat;
};

export type Repository = {
  createAgentConnection(input: CreateAgentConnectionInput): Promise<AgentConnection>;
  listAgentConnections(): Promise<AgentConnection[]>;
  getAgentConnection(id: string): Promise<AgentConnection | null>;
  updateAgentConnection(id: string, input: UpdateAgentConnectionInput): Promise<AgentConnection | null>;
  deleteAgentConnection(id: string): Promise<boolean>;
  updateAgentHealth(id: string, input: UpdateAgentHealthInput): Promise<AgentConnection>;
  createChat(input: CreateChatInput): Promise<Chat>;
  listChats(): Promise<Chat[]>;
  getChat(id: string): Promise<Chat | null>;
  appendEvent(input: AppendEventInput): Promise<EveEvent>;
  persistStreamEvent(input: PersistStreamEventInput): Promise<PersistStreamEventResult>;
  listEvents(chatId: string): Promise<EveEvent[]>;
  clearPendingUserMessage(chatId: string): Promise<Chat>;
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

const duplicateAgentUrlConstraint = "agent_connections_base_url_unique";

export class DuplicateAgentUrlError extends Error {
  constructor(cause: unknown) {
    super("Agent URL already registered", { cause });
    this.name = "DuplicateAgentUrlError";
  }
}

function isDuplicateAgentUrlError(error: unknown): boolean {
  let current = error;

  while (current instanceof Error) {
    if (
      current instanceof DatabaseError &&
      current.code === "23505" &&
      current.constraint === duplicateAgentUrlConstraint
    ) {
      return true;
    }
    current = current.cause;
  }

  return false;
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

      try {
        const [created] = await db.insert(agentConnections).values(record).returning();
        return created;
      } catch (error) {
        if (isDuplicateAgentUrlError(error)) {
          throw new DuplicateAgentUrlError(error);
        }
        throw error;
      }
    },

    async listAgentConnections() {
      return db.select().from(agentConnections).orderBy(asc(agentConnections.createdAt), asc(agentConnections.id));
    },

    async getAgentConnection(id) {
      const [agent] = await db.select().from(agentConnections).where(eq(agentConnections.id, id)).limit(1);
      return agent ?? null;
    },

    async updateAgentConnection(id, input) {
      try {
        const [updated] = await db
          .update(agentConnections)
          .set({
            name: input.name,
            baseUrl: input.baseUrl,
            authType: input.authType,
            authConfigEncrypted: input.authConfigEncrypted,
            status: "unknown",
            lastCheckedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(agentConnections.id, id))
          .returning();
        return updated ?? null;
      } catch (error) {
        if (isDuplicateAgentUrlError(error)) {
          throw new DuplicateAgentUrlError(error);
        }
        throw error;
      }
    },

    async deleteAgentConnection(id) {
      const deleted = await db
        .delete(agentConnections)
        .where(eq(agentConnections.id, id))
        .returning({ id: agentConnections.id });
      return deleted.length > 0;
    },

    async updateAgentHealth(id, input) {
      const hasLastCheckedAt = Object.hasOwn(input, "lastCheckedAt");
      const [updated] = await db
        .update(agentConnections)
        .set({
          status: input.status,
          lastCheckedAt: hasLastCheckedAt ? input.lastCheckedAt : new Date(),
          updatedAt: new Date(),
        })
        .where(eq(agentConnections.id, id))
        .returning();

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
        pendingUserMessage: input.pendingUserMessage ?? null,
        status: "active" satisfies ChatStatus,
        createdAt: now,
        updatedAt: now,
      };

      const [created] = await db.insert(chats).values(record).returning();
      return mapChat(created);
    },

    async listChats() {
      const rows = await db.select().from(chats).orderBy(asc(chats.createdAt), asc(chats.id));
      return rows.map(mapChat);
    },

    async getChat(id) {
      const [row] = await db.select().from(chats).where(eq(chats.id, id)).limit(1);
      return row ? mapChat(row) : null;
    },

    async appendEvent(input) {
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.chatId}))`);

        if (input.sessionId !== undefined && input.streamIndex !== undefined) {
          const [existing] = await tx
            .select()
            .from(events)
            .where(
              and(
                eq(events.chatId, input.chatId),
                eq(events.sessionId, input.sessionId),
                eq(events.streamIndex, input.streamIndex),
              ),
            )
            .limit(1);
          if (existing) {
            return mapEvent(existing);
          }
        }

        const eventIndex =
          input.eventIndex ??
          Number(
            (
              await tx
                .select({ value: sql<number>`coalesce(max(${events.eventIndex}), 0) + 1` })
                .from(events)
                .where(eq(events.chatId, input.chatId))
            )[0]?.value ?? 1,
          );
        const record: typeof events.$inferInsert = {
          id: createId("evt"),
          chatId: input.chatId,
          eventIndex,
          sessionId: input.sessionId,
          streamIndex: input.streamIndex,
          type: input.type,
          payloadJson: JSON.stringify(input.payload),
          createdAt: new Date(),
        };

        const [created] = await tx.insert(events).values(record).returning();
        return mapEvent(created);
      });
    },

    async persistStreamEvent(input) {
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.chatId}))`);

        const [chatRow] = await tx
          .select()
          .from(chats)
          .where(eq(chats.id, input.chatId))
          .limit(1);
        if (!chatRow) {
          throw new Error(`Chat not found: ${input.chatId}`);
        }
        const session = parseSessionState(chatRow.sessionStateJson);
        if (!session || session.sessionId !== input.sessionId) {
          throw new Error("Eve session does not belong to this chat");
        }
        const cursor = session.streamIndex ?? 0;
        if (
          !Number.isInteger(input.streamIndex) ||
          input.streamIndex < 0 ||
          input.streamIndex > 2_147_483_647
        ) {
          throw new Error("Eve stream index is invalid");
        }

        const [existingRow] = await tx
          .select()
          .from(events)
          .where(
            and(
              eq(events.chatId, input.chatId),
              eq(events.sessionId, input.sessionId),
              eq(events.streamIndex, input.streamIndex),
            ),
          )
          .limit(1);

        let event: EveEvent;
        let inserted = false;
        if (existingRow) {
          event = mapEvent(existingRow);
          if (event.type !== input.type || !isDeepStrictEqual(event.payload, input.payload)) {
            throw new Error("Eve replay conflicts with the persisted event");
          }
        } else {
          const eventIndex = Number(
            (
              await tx
                .select({ value: sql<number>`coalesce(max(${events.eventIndex}), 0) + 1` })
                .from(events)
                .where(eq(events.chatId, input.chatId))
            )[0]?.value ?? 1,
          );
          const [created] = await tx
            .insert(events)
            .values({
              id: createId("evt"),
              chatId: input.chatId,
              eventIndex,
              sessionId: input.sessionId,
              streamIndex: input.streamIndex,
              type: input.type,
              payloadJson: JSON.stringify(input.payload),
              createdAt: new Date(),
            })
            .returning();
          event = mapEvent(created);
          inserted = true;
        }

        let resultChat = mapChat(chatRow);
        const advanced = input.streamIndex === cursor;
        if (advanced) {
          const nextState: SessionState = { ...session, streamIndex: cursor + 1 };
          const nextStatus = monotonicChatStatus(chatRow.status, input.status);
          const [updated] = await tx
            .update(chats)
            .set({
              sessionStateJson: JSON.stringify(nextState),
              status: nextStatus,
              updatedAt: new Date(),
            })
            .where(eq(chats.id, input.chatId))
            .returning();
          resultChat = mapChat(updated);
        }

        return { event, inserted, advanced, chat: resultChat };
      });
    },

    async listEvents(chatId) {
      const rows = await db
        .select()
        .from(events)
        .where(eq(events.chatId, chatId))
        .orderBy(asc(events.eventIndex), asc(events.id));
      return rows.map(mapEvent);
    },

    async clearPendingUserMessage(chatId) {
      const [updated] = await db
        .update(chats)
        .set({ pendingUserMessage: null, updatedAt: new Date() })
        .where(eq(chats.id, chatId))
        .returning();

      if (!updated) {
        throw new Error(`Chat not found: ${chatId}`);
      }

      return mapChat(updated);
    },

    async updateChatSessionState(chatId, state, status) {
      const [updated] = await db
        .update(chats)
        .set({
          sessionStateJson: JSON.stringify(state),
          ...(status ? { status } : {}),
          updatedAt: new Date(),
        })
        .where(eq(chats.id, chatId))
        .returning();

      if (!updated) {
        throw new Error(`Chat not found: ${chatId}`);
      }

      return mapChat(updated);
    },

    async updateChatStatus(chatId, status) {
      const [updated] = await db
        .update(chats)
        .set({ status, updatedAt: new Date() })
        .where(eq(chats.id, chatId))
        .returning();

      if (!updated) {
        throw new Error(`Chat not found: ${chatId}`);
      }

      return mapChat(updated);
    },
  };
}

function monotonicChatStatus(current: ChatStatus, requested: ChatStatus | undefined): ChatStatus {
  if (current === "completed" || current === "failed") {
    return current;
  }
  return requested ?? current;
}
