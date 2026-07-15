import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const authTypes = ["none", "bearer", "header"] as const;
export const agentConnectionStatuses = ["unknown", "healthy", "unreachable"] as const;
export const credentialScopes = ["connection", "principal"] as const;
export const chatStatuses = ["active", "completed", "failed"] as const;
export const messageRoles = ["user", "assistant", "system"] as const;

export type AuthType = (typeof authTypes)[number];
export type AgentConnectionStatus = (typeof agentConnectionStatuses)[number];
export type CredentialScope = (typeof credentialScopes)[number];
export type ChatStatus = (typeof chatStatuses)[number];
export type MessageRole = (typeof messageRoles)[number];

export const agentConnections = pgTable(
  "agent_connections",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    baseUrl: text("base_url").notNull(),
    authType: text("auth_type", { enum: authTypes }).notNull(),
    authConfigEncrypted: text("auth_config_encrypted"),
    securityRevision: integer("security_revision").notNull().default(1),
    status: text("status", { enum: agentConnectionStatuses }).notNull().default("unknown"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    uniqueIndex("agent_connections_base_url_unique").on(table.baseUrl),
    check("agent_connections_security_revision_positive", sql`${table.securityRevision} > 0`),
  ],
);

export const agentCredentials = pgTable(
  "agent_credentials",
  {
    agentConnectionId: text("agent_connection_id")
      .notNull()
      .references(() => agentConnections.id, { onDelete: "cascade" }),
    securityRevision: integer("security_revision").notNull(),
    credentialScope: text("credential_scope", { enum: credentialScopes }).notNull(),
    scopeSubject: text("scope_subject").notNull(),
    authMethod: text("auth_method").notNull(),
    credentialKey: text("credential_key").notNull().default(""),
    payloadEncrypted: text("payload_encrypted").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    refreshOwner: text("refresh_owner"),
    refreshLeaseId: text("refresh_lease_id"),
    refreshLeaseUntil: timestamp("refresh_lease_until", { withTimezone: true, mode: "date" }),
    rotationSeq: integer("rotation_seq").notNull().default(0),
  },
  (table) => [
    uniqueIndex("agent_credentials_identity_unique").on(
      table.agentConnectionId,
      table.securityRevision,
      table.authMethod,
      table.credentialScope,
      table.scopeSubject,
      table.credentialKey,
    ),
    check(
      "agent_credentials_credential_scope_valid",
      sql`${table.credentialScope} in ('connection', 'principal')`,
    ),
    check(
      "agent_credentials_scope_subject_valid",
      sql`(${table.credentialScope} = 'connection' and ${table.scopeSubject} = '') or (${table.credentialScope} = 'principal' and ${table.scopeSubject} <> '')`,
    ),
    check("agent_credentials_security_revision_positive", sql`${table.securityRevision} > 0`),
    check("agent_credentials_rotation_seq_nonnegative", sql`${table.rotationSeq} >= 0`),
  ],
);

export const chats = pgTable("chats", {
  id: text("id").primaryKey(),
  agentConnectionId: text("agent_connection_id").notNull().references(() => agentConnections.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  sessionStateJson: text("session_state_json"),
  pendingUserMessage: text("pending_user_message"),
  status: text("status", { enum: chatStatuses }).notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
});

export const messages = pgTable("messages", {
  id: text("id").primaryKey(),
  chatId: text("chat_id").notNull().references(() => chats.id, { onDelete: "cascade" }),
  role: text("role", { enum: messageRoles }).notNull(),
  content: text("content").notNull(),
  eventIndex: integer("event_index"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
});

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
  ],
);

export const schema = { agentConnections, agentCredentials, chats, messages, events };
