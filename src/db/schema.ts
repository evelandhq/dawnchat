import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const authTypes = ["none", "bearer", "header"] as const;
export const agentConnectionStatuses = ["unknown", "healthy", "unreachable"] as const;
export const chatStatuses = ["active", "completed", "failed"] as const;
export const messageRoles = ["user", "assistant", "system"] as const;

export type AuthType = (typeof authTypes)[number];
export type AgentConnectionStatus = (typeof agentConnectionStatuses)[number];
export type ChatStatus = (typeof chatStatuses)[number];
export type MessageRole = (typeof messageRoles)[number];

export const agentConnections = sqliteTable("agent_connections", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  authType: text("auth_type", { enum: authTypes }).notNull(),
  authConfigEncrypted: text("auth_config_encrypted"),
  status: text("status", { enum: agentConnectionStatuses }).notNull().default("unknown"),
  lastCheckedAt: integer("last_checked_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const chats = sqliteTable("chats", {
  id: text("id").primaryKey(),
  agentConnectionId: text("agent_connection_id")
    .notNull()
    .references(() => agentConnections.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  sessionStateJson: text("session_state_json"),
  status: text("status", { enum: chatStatuses }).notNull().default("active"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  chatId: text("chat_id")
    .notNull()
    .references(() => chats.id, { onDelete: "cascade" }),
  role: text("role", { enum: messageRoles }).notNull(),
  content: text("content").notNull(),
  eventIndex: integer("event_index"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    eventIndex: integer("event_index").notNull(),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("events_chat_id_event_index_unique").on(table.chatId, table.eventIndex)],
);

export const schema = {
  agentConnections,
  chats,
  messages,
  events,
};
