import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
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
import {
  clearPendingBatchesForTurn,
  EMPTY_PENDING_INPUT,
  openPendingBatch,
  parsePendingInput,
  serializePendingInput,
  settleAnsweredRequests,
  type PendingInputRequest,
  type PendingInputState,
} from "@/eve/proxy-contract";

export type RepositoryDb = NodePgDatabase<typeof schema>;

export type SessionState = z.infer<typeof sessionStateSchema>;

const sessionStateSchema = z.object({
  sessionId: z.string().min(1),
  continuationToken: z.string().optional(),
  streamIndex: z.number().int().nonnegative().optional(),
});

export type AgentConnection = typeof agentConnections.$inferSelect;
export type Chat = Omit<
  typeof chats.$inferSelect,
  "sessionStateJson" | "pendingInputJson"
> & {
  sessionState: SessionState | null;
  /** `null` = legacy chat, state not derived yet (see proxy-contract). */
  pendingInput: PendingInputState | null;
};
export type EveEvent = Omit<typeof events.$inferSelect, "payloadJson"> & {
  payload: unknown;
};

export type CreateAgentConnectionInput = {
  name: string;
  baseUrl: string;
  authType: AuthType;
  authConfigEncrypted?: string | null;
  evelandProjectId?: string | null;
};

export type UpsertCatalogAgentInput = {
  identityIssuer: string;
  evelandProjectId: string;
  name: string;
  description: string | null;
  baseUrl: string;
};

export type UpdateAgentConnectionInput = {
  name: string;
  baseUrl: string;
  authType: AuthType;
  authConfigEncrypted: string | null;
  evelandProjectId?: string | null;
};

export type UpdateAgentHealthInput = {
  status: AgentConnectionStatus;
  lastCheckedAt?: Date | null;
};

export type CreateChatInput = {
  agentConnectionId: string;
  title: string;
  pendingUserMessage?: string | null;
  ownerClientId?: string | null;
  ownerIdentityIssuer?: string | null;
  ownerIdentityPrincipalId?: string | null;
  ownerIdentityRealmId?: string | null;
  evelandProjectId?: string | null;
};

export type ChatIdentityScope = {
  principalId: string;
  realmId: string;
  projectId: string;
};

export type AppIdentityScope = {
  issuer: string;
  principalId: string;
  realmId: string;
};

export type AppendEventInput = {
  chatId: string;
  type: string;
  payload: unknown;
  /**
   * Pending-input transition to run atomically with the insert, applied only
   * when the event row is newly inserted — a replayed event must not reopen a
   * settled batch.
   */
  pendingInput?:
    | { open: PendingInputRequest[]; turnId?: string }
    | { clear: true }
    | { clearTurn: string }
    | { settle: string[] };
  /**
   * Session cursor to persist atomically with the insert, applied only when
   * the event row is newly inserted — a replayed event recomputes the same
   * cursor, so skipping it changes nothing and saves the write.
   */
  sessionState?: { state: SessionState; status?: ChatStatus };
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
  // An app-owned event has no Eve stream coordinates and lands at the tail.
  | {
      eventIndex?: never;
      sessionId?: never;
      streamIndex?: never;
    }
);

export type Repository = {
  createAgentConnection(input: CreateAgentConnectionInput): Promise<AgentConnection>;
  upsertCatalogAgent(input: UpsertCatalogAgentInput): Promise<AgentConnection>;
  listAgentConnections(): Promise<AgentConnection[]>;
  getAgentConnection(id: string): Promise<AgentConnection | null>;
  updateAgentConnection(id: string, input: UpdateAgentConnectionInput): Promise<AgentConnection | null>;
  deleteAgentConnection(id: string): Promise<boolean>;
  updateAgentHealth(id: string, input: UpdateAgentHealthInput): Promise<AgentConnection>;
  createChat(input: CreateChatInput): Promise<Chat>;
  listChats(): Promise<Chat[]>;
  getChat(id: string): Promise<Chat | null>;
  listChatsForClient(clientId: string): Promise<Chat[]>;
  getChatForClient(id: string, clientId: string): Promise<Chat | null>;
  listChatsForIdentity(scope: ChatIdentityScope): Promise<Chat[]>;
  getChatForIdentity(id: string, scope: ChatIdentityScope): Promise<Chat | null>;
  listChatsForAppIdentity(scope: AppIdentityScope): Promise<Chat[]>;
  getChatForAppIdentity(id: string, scope: AppIdentityScope): Promise<Chat | null>;
  /**
   * Adopt the browser session's identity-less chats into the given identity.
   * Chats that already belong to an identity are never re-owned.
   */
  claimChatsForClient(clientId: string, scope: AppIdentityScope): Promise<number>;
  appendEvent(input: AppendEventInput): Promise<EveEvent>;
  listEvents(chatId: string): Promise<EveEvent[]>;
  /**
   * The tail of each chat's text-bearing events, newest turns last, capped per
   * chat. One query for every chat, so a chat list never replays whole streams.
   */
  listMessageTailEvents(
    chatIds: string[],
    perChatLimit: number,
  ): Promise<Map<string, EveEvent[]>>;
  clearPendingUserMessage(chatId: string): Promise<Chat>;
  updateChatSessionState(chatId: string, state: SessionState, status?: ChatStatus): Promise<Chat>;
  updateChatStatus(chatId: string, status: ChatStatus): Promise<Chat>;
  /**
   * Read-modify-write on the pending-input ledger under the same per-chat
   * advisory lock as `appendEvent`. `fn` returns the state to persist, or
   * `null` to leave the row untouched (including the legacy `NULL` marker).
   */
  updatePendingInput(
    chatId: string,
    fn: (current: PendingInputState | null) => PendingInputState | null,
  ): Promise<PendingInputState | null>;
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
  const { sessionStateJson, pendingInputJson, ...rest } = row;
  return {
    ...rest,
    sessionState: parseSessionState(sessionStateJson),
    pendingInput: parsePendingInput(pendingInputJson),
  };
}

function parseEventPayload(payloadJson: string): unknown {
  try {
    return JSON.parse(payloadJson);
  } catch {
    throw new Error("Stored Eve event payload is invalid");
  }
}

/**
 * The event types the message projection turns into message text. A chat
 * preview only needs these, so a list never reads whole event streams.
 */
const MESSAGE_TEXT_EVENT_TYPES = [
  "message.received",
  "message.appended",
  "message.completed",
] as const;

const eventColumns = {
  id: events.id,
  chatId: events.chatId,
  eventIndex: events.eventIndex,
  sessionId: events.sessionId,
  streamIndex: events.streamIndex,
  type: events.type,
  payloadJson: events.payloadJson,
  createdAt: events.createdAt,
};

function mapEvent(row: typeof events.$inferSelect): EveEvent {
  const { payloadJson, ...rest } = row;
  return {
    ...rest,
    payload: parseEventPayload(payloadJson),
  };
}

const duplicateAgentUrlConstraint = "agent_connections_external_base_url_unique";

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
        evelandProjectId: input.evelandProjectId ?? null,
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

    async upsertCatalogAgent(input) {
      const now = new Date();
      const [managed] = await db
        .select()
        .from(agentConnections)
        .where(
          and(
            eq(agentConnections.source, "managed"),
            eq(agentConnections.identityIssuer, input.identityIssuer),
            eq(agentConnections.evelandProjectId, input.evelandProjectId),
          ),
        )
        .limit(1);
      const [legacy] = managed
        ? []
        : await db
            .select()
            .from(agentConnections)
            .where(
              and(
                eq(agentConnections.evelandProjectId, input.evelandProjectId),
                isNull(agentConnections.identityIssuer),
                eq(agentConnections.authType, "none"),
                isNull(agentConnections.authConfigEncrypted),
              ),
            )
            .limit(1);
      const existing = managed ?? legacy;
      if (existing) {
        const [updated] = await db
          .update(agentConnections)
          .set({
            name: input.name,
            description: input.description,
            baseUrl: input.baseUrl,
            source: "managed",
            identityIssuer: input.identityIssuer,
            evelandProjectId: input.evelandProjectId,
            catalogLastSeenAt: now,
            updatedAt: now,
          })
          .where(eq(agentConnections.id, existing.id))
          .returning();
        if (!updated) throw new Error("Failed to update Catalog Agent.");
        return updated;
      }
      const [created] = await db
        .insert(agentConnections)
        .values({
          id: createId("agent"),
          name: input.name,
          description: input.description,
          baseUrl: input.baseUrl,
          source: "managed",
          authType: "none",
          authConfigEncrypted: null,
          identityIssuer: input.identityIssuer,
          evelandProjectId: input.evelandProjectId,
          catalogLastSeenAt: now,
          status: "unknown",
          lastCheckedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            agentConnections.identityIssuer,
            agentConnections.evelandProjectId,
          ],
          targetWhere: sql`${agentConnections.source} = 'managed'`,
          set: {
            name: input.name,
            description: input.description,
            baseUrl: input.baseUrl,
            catalogLastSeenAt: now,
            updatedAt: now,
          },
        })
        .returning();
      if (!created) throw new Error("Failed to create Catalog Agent.");
      return created;
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
            evelandProjectId: input.evelandProjectId ?? null,
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
        ownerClientId: input.ownerClientId ?? null,
        ownerIdentityIssuer: input.ownerIdentityIssuer ?? null,
        ownerIdentityPrincipalId: input.ownerIdentityPrincipalId ?? null,
        ownerIdentityRealmId: input.ownerIdentityRealmId ?? null,
        evelandProjectId: input.evelandProjectId ?? null,
        sessionStateJson: null,
        pendingInputJson: serializePendingInput(EMPTY_PENDING_INPUT),
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

    async listChatsForClient(clientId) {
      const rows = await db
        .select()
        .from(chats)
        .where(eq(chats.ownerClientId, clientId))
        .orderBy(asc(chats.createdAt), asc(chats.id));
      return rows.map(mapChat);
    },

    async getChatForClient(id, clientId) {
      const [row] = await db
        .select()
        .from(chats)
        .where(
          and(
            eq(chats.id, id),
            eq(chats.ownerClientId, clientId),
          ),
        )
        .limit(1);
      return row ? mapChat(row) : null;
    },

    async listChatsForIdentity(scope) {
      const rows = await db
        .select()
        .from(chats)
        .where(
          and(
            eq(chats.ownerIdentityPrincipalId, scope.principalId),
            eq(chats.ownerIdentityRealmId, scope.realmId),
            eq(chats.evelandProjectId, scope.projectId),
          ),
        )
        .orderBy(asc(chats.createdAt), asc(chats.id));
      return rows.map(mapChat);
    },

    async getChatForIdentity(id, scope) {
      const [row] = await db
        .select()
        .from(chats)
        .where(
          and(
            eq(chats.id, id),
            eq(chats.ownerIdentityPrincipalId, scope.principalId),
            eq(chats.ownerIdentityRealmId, scope.realmId),
            eq(chats.evelandProjectId, scope.projectId),
          ),
        )
        .limit(1);
      return row ? mapChat(row) : null;
    },

    async listChatsForAppIdentity(scope) {
      const rows = await db
        .select()
        .from(chats)
        .where(
          and(
            or(
              eq(chats.ownerIdentityIssuer, scope.issuer),
              isNull(chats.ownerIdentityIssuer),
            ),
            eq(chats.ownerIdentityPrincipalId, scope.principalId),
            eq(chats.ownerIdentityRealmId, scope.realmId),
          ),
        )
        .orderBy(asc(chats.createdAt), asc(chats.id));
      return rows.map(mapChat);
    },

    async getChatForAppIdentity(id, scope) {
      const [row] = await db
        .select()
        .from(chats)
        .where(
          and(
            eq(chats.id, id),
            or(
              eq(chats.ownerIdentityIssuer, scope.issuer),
              isNull(chats.ownerIdentityIssuer),
            ),
            eq(chats.ownerIdentityPrincipalId, scope.principalId),
            eq(chats.ownerIdentityRealmId, scope.realmId),
          ),
        )
        .limit(1);
      return row ? mapChat(row) : null;
    },

    async claimChatsForClient(clientId, scope) {
      const claimed = await db
        .update(chats)
        .set({
          ownerIdentityIssuer: scope.issuer,
          ownerIdentityPrincipalId: scope.principalId,
          ownerIdentityRealmId: scope.realmId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chats.ownerClientId, clientId),
            isNull(chats.ownerIdentityPrincipalId),
          ),
        )
        .returning({ id: chats.id });
      return claimed.length;
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

        if (input.pendingInput) {
          const [chatRow] = await tx
            .select({ pendingInputJson: chats.pendingInputJson })
            .from(chats)
            .where(eq(chats.id, input.chatId))
            .limit(1);
          const legacy = chatRow ? parsePendingInput(chatRow.pendingInputJson) === null : false;
          const transition = input.pendingInput;
          // A settle on a legacy chat keeps the NULL marker: the event just
          // stored feeds the one-shot derivation instead, which would miss
          // batches this write would wrongly declare empty.
          if (chatRow && !(legacy && "settle" in transition)) {
            const current = parsePendingInput(chatRow.pendingInputJson) ?? EMPTY_PENDING_INPUT;
            const next =
              "clear" in transition
                ? EMPTY_PENDING_INPUT
                : "clearTurn" in transition
                  ? clearPendingBatchesForTurn(current, transition.clearTurn)
                  : "settle" in transition
                    ? settleAnsweredRequests(current, transition.settle)
                    : openPendingBatch(current, {
                        eventIndex: created.eventIndex,
                        requests: transition.open,
                        ...(transition.turnId ? { turnId: transition.turnId } : {}),
                      });
            await tx
              .update(chats)
              .set({ pendingInputJson: serializePendingInput(next), updatedAt: new Date() })
              .where(eq(chats.id, input.chatId));
          }
        }

        if (input.sessionState) {
          await tx
            .update(chats)
            .set({
              sessionStateJson: JSON.stringify(input.sessionState.state),
              ...(input.sessionState.status
                ? { status: input.sessionState.status }
                : {}),
              updatedAt: new Date(),
            })
            .where(eq(chats.id, input.chatId));
        }

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

    async listMessageTailEvents(chatIds, perChatLimit) {
      const byChat = new Map<string, EveEvent[]>();
      if (chatIds.length === 0 || perChatLimit <= 0) return byChat;

      const ranked = db
        .select({
          ...eventColumns,
          tailRank:
            sql<number>`row_number() over (partition by ${events.chatId} order by ${events.eventIndex} desc, ${events.id} desc)`.as(
              "tail_rank",
            ),
        })
        .from(events)
        .where(
          and(
            inArray(events.chatId, chatIds),
            inArray(events.type, MESSAGE_TEXT_EVENT_TYPES),
          ),
        )
        .as("ranked");

      const rows = await db
        .select({
          id: ranked.id,
          chatId: ranked.chatId,
          eventIndex: ranked.eventIndex,
          sessionId: ranked.sessionId,
          streamIndex: ranked.streamIndex,
          type: ranked.type,
          payloadJson: ranked.payloadJson,
          createdAt: ranked.createdAt,
        })
        .from(ranked)
        .where(lte(ranked.tailRank, perChatLimit))
        .orderBy(asc(ranked.chatId), asc(ranked.eventIndex), asc(ranked.id));

      for (const row of rows) {
        const existing = byChat.get(row.chatId);
        if (existing) existing.push(mapEvent(row));
        else byChat.set(row.chatId, [mapEvent(row)]);
      }
      return byChat;
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

    async updatePendingInput(chatId, fn) {
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${chatId}))`);
        const [row] = await tx
          .select({ pendingInputJson: chats.pendingInputJson })
          .from(chats)
          .where(eq(chats.id, chatId))
          .limit(1);
        if (!row) {
          throw new Error(`Chat not found: ${chatId}`);
        }
        const current = parsePendingInput(row.pendingInputJson);
        const next = fn(current);
        if (next === null) {
          return current;
        }
        await tx
          .update(chats)
          .set({ pendingInputJson: serializePendingInput(next), updatedAt: new Date() })
          .where(eq(chats.id, chatId));
        return next;
      });
    },
  };
}
