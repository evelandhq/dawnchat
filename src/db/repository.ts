import { and, asc, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { DatabaseError } from "pg";
import { z } from "zod";

import { createId } from "@/lib/ids";
import {
  agentConnections,
  agentAuthCredentials,
  agentAuthTransactions,
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
export type AgentAuthCredential = typeof agentAuthCredentials.$inferSelect;
export type AgentAuthTransaction = typeof agentAuthTransactions.$inferSelect;
export type Chat = Omit<typeof chats.$inferSelect, "sessionStateJson"> & {
  sessionState: SessionState | null;
};
export type EveEvent = Omit<typeof events.$inferSelect, "payloadJson"> & {
  payload: unknown;
};

export type CreateAgentConnectionInput = {
  id?: string;
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
  expectedSecurityRevision?: number;
  securityChanged?: boolean;
};

export type AgentAuthCredentialKey = Pick<
  AgentAuthCredential,
  "agentConnectionId" | "securityRevision" | "authMethod" | "credentialScope" | "scopeSubject" | "credentialKey"
>;

export type UpdateAgentHealthInput = {
  status: AgentConnectionStatus;
  lastCheckedAt?: Date | null;
  expectedSecurityRevision?: number;
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

export type Repository = {
  createAgentConnection(input: CreateAgentConnectionInput): Promise<AgentConnection>;
  listAgentConnections(): Promise<AgentConnection[]>;
  getAgentConnection(id: string): Promise<AgentConnection | null>;
  updateAgentConnection(id: string, input: UpdateAgentConnectionInput): Promise<AgentConnection | null>;
  deleteAgentConnection(id: string): Promise<boolean>;
  updateAgentHealth(id: string, input: UpdateAgentHealthInput): Promise<AgentConnection>;
  putAgentAuthCredential(input: AgentAuthCredentialKey & {
    payloadEncrypted: string;
    expiresAt: Date | null;
  }): Promise<AgentAuthCredential>;
  getAgentAuthCredential(key: AgentAuthCredentialKey): Promise<AgentAuthCredential | null>;
  deleteAgentAuthCredential(key: AgentAuthCredentialKey, expectedRotationSeq: number): Promise<boolean>;
  replaceAgentAuthCredential(input: AgentAuthCredentialKey & {
    expectedRotationSeq: number;
    payloadEncrypted: string;
    expiresAt: Date | null;
  }): Promise<AgentAuthCredential | null>;
  claimAgentAuthRefreshLease(input: AgentAuthCredentialKey & {
    expectedRotationSeq: number;
    refreshOwner: string;
    refreshLeaseId: string;
    now: Date;
    leaseUntil: Date;
  }): Promise<AgentAuthCredential | null>;
  completeAgentAuthRefresh(input: AgentAuthCredentialKey & {
    expectedRotationSeq: number;
    refreshOwner: string;
    refreshLeaseId: string;
    now: Date;
    payloadEncrypted: string;
    expiresAt: Date | null;
  }): Promise<AgentAuthCredential | null>;
  releaseAgentAuthRefreshLease(input: AgentAuthCredentialKey & {
    expectedRotationSeq: number;
    refreshOwner: string;
    refreshLeaseId: string;
  }): Promise<boolean>;
  deleteAgentAuthCredentialWithRefreshLease(input: AgentAuthCredentialKey & {
    expectedRotationSeq: number;
    refreshOwner: string;
    refreshLeaseId: string;
    now: Date;
  }): Promise<boolean>;
  createAgentAuthTransaction(input: {
    agentConnectionId: string;
    stateHash: string;
    payloadEncrypted: string;
    expiresAt: Date;
  }): Promise<AgentAuthTransaction>;
  consumeAgentAuthTransaction(stateHash: string, now?: Date): Promise<AgentAuthTransaction | null>;
  deleteExpiredAgentAuthTransactions(now?: Date, limit?: number): Promise<number>;
  deleteStaleAgentAuthCredentials(agentConnectionId: string, currentSecurityRevision: number): Promise<number>;
  createChat(input: CreateChatInput): Promise<Chat>;
  listChats(): Promise<Chat[]>;
  getChat(id: string): Promise<Chat | null>;
  appendEvent(input: AppendEventInput): Promise<EveEvent>;
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

export class AgentConnectionChangedError extends Error {
  constructor() {
    super("Agent connection changed while an operation was in progress");
    this.name = "AgentConnectionChangedError";
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

function agentAuthCredentialWhere(key: AgentAuthCredentialKey) {
  return and(
    eq(agentAuthCredentials.agentConnectionId, key.agentConnectionId),
    eq(agentAuthCredentials.securityRevision, key.securityRevision),
    eq(agentAuthCredentials.authMethod, key.authMethod),
    eq(agentAuthCredentials.credentialScope, key.credentialScope),
    eq(agentAuthCredentials.scopeSubject, key.scopeSubject),
    eq(agentAuthCredentials.credentialKey, key.credentialKey),
  );
}

export function createRepository(db: RepositoryDb): Repository {
  return {
    async createAgentConnection(input) {
      const now = new Date();
      const record: typeof agentConnections.$inferInsert = {
        id: input.id ?? createId("agent"),
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
        const where = input.expectedSecurityRevision === undefined
          ? eq(agentConnections.id, id)
          : and(
              eq(agentConnections.id, id),
              eq(agentConnections.securityRevision, input.expectedSecurityRevision),
            );
        const [updated] = await db
          .update(agentConnections)
          .set({
            name: input.name,
            baseUrl: input.baseUrl,
            authType: input.authType,
            authConfigEncrypted: input.authConfigEncrypted,
            ...(input.securityChanged
              ? { securityRevision: sql`${agentConnections.securityRevision} + 1` }
              : {}),
            status: "unknown",
            lastCheckedAt: null,
            updatedAt: new Date(),
          })
          .where(where)
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
      const where = input.expectedSecurityRevision === undefined
        ? eq(agentConnections.id, id)
        : and(
            eq(agentConnections.id, id),
            eq(agentConnections.securityRevision, input.expectedSecurityRevision),
          );
      const [updated] = await db
        .update(agentConnections)
        .set({
          status: input.status,
          lastCheckedAt: hasLastCheckedAt ? input.lastCheckedAt : new Date(),
          updatedAt: new Date(),
        })
        .where(where)
        .returning();

      if (!updated) {
        if (input.expectedSecurityRevision !== undefined) throw new AgentConnectionChangedError();
        throw new Error(`Agent connection not found: ${id}`);
      }

      return updated;
    },

    async putAgentAuthCredential(input) {
      const [stored] = await db
        .insert(agentAuthCredentials)
        .values(input)
        .onConflictDoUpdate({
          target: [
            agentAuthCredentials.agentConnectionId,
            agentAuthCredentials.securityRevision,
            agentAuthCredentials.authMethod,
            agentAuthCredentials.credentialScope,
            agentAuthCredentials.scopeSubject,
            agentAuthCredentials.credentialKey,
          ],
          set: {
            payloadEncrypted: input.payloadEncrypted,
            expiresAt: input.expiresAt,
            rotationSeq: sql`${agentAuthCredentials.rotationSeq} + 1`,
            refreshOwner: null,
            refreshLeaseId: null,
            refreshLeaseUntil: null,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!stored) throw new Error("Failed to store Agent credential");
      return stored;
    },

    async getAgentAuthCredential(key) {
      const [credential] = await db
        .select()
        .from(agentAuthCredentials)
        .where(agentAuthCredentialWhere(key))
        .limit(1);
      return credential ?? null;
    },

    async deleteAgentAuthCredential(key, expectedRotationSeq) {
      const [deleted] = await db
        .delete(agentAuthCredentials)
        .where(and(
          agentAuthCredentialWhere(key),
          eq(agentAuthCredentials.rotationSeq, expectedRotationSeq),
          isNull(agentAuthCredentials.refreshLeaseId),
        ))
        .returning({ rotationSeq: agentAuthCredentials.rotationSeq });
      return Boolean(deleted);
    },

    async replaceAgentAuthCredential(input) {
      const [updated] = await db
        .update(agentAuthCredentials)
        .set({
          payloadEncrypted: input.payloadEncrypted,
          expiresAt: input.expiresAt,
          rotationSeq: sql`${agentAuthCredentials.rotationSeq} + 1`,
          refreshOwner: null,
          refreshLeaseId: null,
          refreshLeaseUntil: null,
          updatedAt: new Date(),
        })
        .where(and(
          agentAuthCredentialWhere(input),
          eq(agentAuthCredentials.rotationSeq, input.expectedRotationSeq),
        ))
        .returning();
      return updated ?? null;
    },

    async claimAgentAuthRefreshLease(input) {
      const [claimed] = await db
        .update(agentAuthCredentials)
        .set({
          refreshOwner: input.refreshOwner,
          refreshLeaseId: input.refreshLeaseId,
          refreshLeaseUntil: input.leaseUntil,
          updatedAt: input.now,
        })
        .where(and(
          agentAuthCredentialWhere(input),
          eq(agentAuthCredentials.rotationSeq, input.expectedRotationSeq),
          or(
            isNull(agentAuthCredentials.refreshLeaseUntil),
            lte(agentAuthCredentials.refreshLeaseUntil, input.now),
          ),
        ))
        .returning();
      return claimed ?? null;
    },

    async completeAgentAuthRefresh(input) {
      const [completed] = await db
        .update(agentAuthCredentials)
        .set({
          payloadEncrypted: input.payloadEncrypted,
          expiresAt: input.expiresAt,
          rotationSeq: sql`${agentAuthCredentials.rotationSeq} + 1`,
          refreshOwner: null,
          refreshLeaseId: null,
          refreshLeaseUntil: null,
          updatedAt: input.now,
        })
        .where(and(
          agentAuthCredentialWhere(input),
          eq(agentAuthCredentials.rotationSeq, input.expectedRotationSeq),
          eq(agentAuthCredentials.refreshOwner, input.refreshOwner),
          eq(agentAuthCredentials.refreshLeaseId, input.refreshLeaseId),
          gt(agentAuthCredentials.refreshLeaseUntil, input.now),
        ))
        .returning();
      return completed ?? null;
    },

    async releaseAgentAuthRefreshLease(input) {
      const [released] = await db
        .update(agentAuthCredentials)
        .set({
          refreshOwner: null,
          refreshLeaseId: null,
          refreshLeaseUntil: null,
          updatedAt: new Date(),
        })
        .where(and(
          agentAuthCredentialWhere(input),
          eq(agentAuthCredentials.rotationSeq, input.expectedRotationSeq),
          eq(agentAuthCredentials.refreshOwner, input.refreshOwner),
          eq(agentAuthCredentials.refreshLeaseId, input.refreshLeaseId),
        ))
        .returning({ rotationSeq: agentAuthCredentials.rotationSeq });
      return Boolean(released);
    },

    async deleteAgentAuthCredentialWithRefreshLease(input) {
      const [deleted] = await db
        .delete(agentAuthCredentials)
        .where(and(
          agentAuthCredentialWhere(input),
          eq(agentAuthCredentials.rotationSeq, input.expectedRotationSeq),
          eq(agentAuthCredentials.refreshOwner, input.refreshOwner),
          eq(agentAuthCredentials.refreshLeaseId, input.refreshLeaseId),
          gt(agentAuthCredentials.refreshLeaseUntil, input.now),
        ))
        .returning({ rotationSeq: agentAuthCredentials.rotationSeq });
      return Boolean(deleted);
    },

    async createAgentAuthTransaction(input) {
      const [transaction] = await db.insert(agentAuthTransactions).values(input).returning();
      if (!transaction) throw new Error("Failed to create Agent Auth transaction");
      return transaction;
    },

    async consumeAgentAuthTransaction(stateHash, now = new Date()) {
      const [transaction] = await db
        .delete(agentAuthTransactions)
        .where(eq(agentAuthTransactions.stateHash, stateHash))
        .returning();
      return transaction && transaction.expiresAt > now ? transaction : null;
    },

    async deleteExpiredAgentAuthTransactions(now = new Date(), limit = 100) {
      const deleted = await db
        .delete(agentAuthTransactions)
        .where(inArray(
          agentAuthTransactions.stateHash,
          db
            .select({ stateHash: agentAuthTransactions.stateHash })
            .from(agentAuthTransactions)
            .where(lte(agentAuthTransactions.expiresAt, now))
            .limit(limit),
        ))
        .returning({ stateHash: agentAuthTransactions.stateHash });
      return deleted.length;
    },

    async deleteStaleAgentAuthCredentials(agentConnectionId, currentSecurityRevision) {
      const deleted = await db
        .delete(agentAuthCredentials)
        .where(and(
          eq(agentAuthCredentials.agentConnectionId, agentConnectionId),
          lt(agentAuthCredentials.securityRevision, currentSecurityRevision),
        ))
        .returning({ rotationSeq: agentAuthCredentials.rotationSeq });
      return deleted.length;
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
