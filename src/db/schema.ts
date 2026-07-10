import { integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const authTypes = ["none", "bearer", "header"] as const;
export const agentConnectionStatuses = ["unknown", "healthy", "unreachable"] as const;
export const chatStatuses = ["active", "completed", "failed"] as const;
export const messageRoles = ["user", "assistant", "system"] as const;

export type AuthType = (typeof authTypes)[number];
export type AgentConnectionStatus = (typeof agentConnectionStatuses)[number];
export type ChatStatus = (typeof chatStatuses)[number];
export type MessageRole = (typeof messageRoles)[number];

export const agentConnections = pgTable("agent_connections", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  authType: text("auth_type", { enum: authTypes }).notNull(),
  authConfigEncrypted: text("auth_config_encrypted"),
  status: text("status", { enum: agentConnectionStatuses }).notNull().default("unknown"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
});

export const chats = pgTable("chats", {
  id: text("id").primaryKey(),
  agentConnectionId: text("agent_connection_id").notNull().references(() => agentConnections.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  sessionStateJson: text("session_state_json"),
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
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [uniqueIndex("events_chat_id_event_index_unique").on(table.chatId, table.eventIndex)],
);

export const schema = { agentConnections, chats, messages, events };
