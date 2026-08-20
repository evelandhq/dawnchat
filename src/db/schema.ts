import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const authTypes = ["none", "bearer", "header"] as const;
export const agentConnectionStatuses = ["unknown", "healthy", "unreachable"] as const;
export const agentConnectionSources = ["external", "managed"] as const;
export const chatStatuses = ["active", "completed", "failed"] as const;

export type AuthType = (typeof authTypes)[number];
export type AgentConnectionStatus = (typeof agentConnectionStatuses)[number];
export type AgentConnectionSource = (typeof agentConnectionSources)[number];
export type ChatStatus = (typeof chatStatuses)[number];

export const agentConnections = pgTable(
  "agent_connections",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    baseUrl: text("base_url").notNull(),
    source: text("source", { enum: agentConnectionSources }).notNull().default("external"),
    authType: text("auth_type", { enum: authTypes }).notNull(),
    authConfigEncrypted: text("auth_config_encrypted"),
    identityIssuer: text("identity_issuer"),
    evelandProjectId: text("eveland_project_id"),
    catalogLastSeenAt: timestamp("catalog_last_seen_at", { withTimezone: true, mode: "date" }),
    status: text("status", { enum: agentConnectionStatuses }).notNull().default("unknown"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    uniqueIndex("agent_connections_external_base_url_unique")
      .on(table.baseUrl)
      .where(sql`${table.source} = 'external'`),
    uniqueIndex("agent_connections_managed_identity_unique")
      .on(table.identityIssuer, table.evelandProjectId)
      .where(sql`${table.source} = 'managed'`),
  ],
);

export const chats = pgTable(
  "chats",
  {
    id: text("id").primaryKey(),
    agentConnectionId: text("agent_connection_id").notNull().references(() => agentConnections.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    ownerClientId: text("owner_client_id"),
    ownerIdentityIssuer: text("owner_identity_issuer"),
    ownerIdentityPrincipalId: text("owner_identity_principal_id"),
    ownerIdentityRealmId: text("owner_identity_realm_id"),
    evelandProjectId: text("eveland_project_id"),
    sessionStateJson: text("session_state_json"),
    // NULL marks a chat from before the pending-input ledger; its open batches
    // are derived from stored events on first touch and written back.
    pendingInputJson: text("pending_input_json"),
    pendingUserMessage: text("pending_user_message"),
    status: text("status", { enum: chatStatuses }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    index("chats_owner_client_id_created_at_idx").on(
      table.ownerClientId,
      table.createdAt.desc(),
    ),
    index("chats_owner_identity_created_at_idx").on(
      table.ownerIdentityPrincipalId,
      table.ownerIdentityRealmId,
      table.createdAt.desc(),
    ),
  ],
);

export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id").notNull().references(() => chats.id, { onDelete: "cascade" }),
    eventIndex: integer("event_index").notNull(),
    sessionId: text("session_id"),
    streamIndex: integer("stream_index"),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    uniqueIndex("events_chat_id_event_index_unique").on(table.chatId, table.eventIndex),
    uniqueIndex("events_chat_id_session_id_stream_index_unique").on(
      table.chatId,
      table.sessionId,
      table.streamIndex,
    ),
    // Serves the per-chat tail read behind chat previews.
    index("events_chat_id_type_event_index_idx").on(
      table.chatId,
      table.type,
      table.eventIndex.desc(),
    ),
  ],
);

export const schema = { agentConnections, chats, events };
