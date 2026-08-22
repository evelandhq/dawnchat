# Eve Chats Initial Implementation Plan

> Status: **Completed — historical; later work supersedes parts of this plan.**
> Status checked: 2026-08-22.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone local `eve-chats` repo that can register arbitrary open Eve agents by base URL, verify them, and provide a unified chat UI with persisted conversations.

**Architecture:** Create a single Next.js application with server-side Eve connectivity. The browser talks only to the `eve-chats` backend; the backend uses official `eve/client` against each remote Eve agent's default `eveChannel` API, persists `AgentConnection -> Chat -> Message/Event`, and streams normalized updates to the UI. Each chat is strongly bound to exactly one `AgentConnection` and stores Eve `SessionState` (`sessionId`, `continuationToken`, `streamIndex`) separately from display history.

**Tech Stack:** Node >= 24, pnpm via Corepack, Next.js App Router, React, TypeScript, assistant-ui React components, `eve/client`, Drizzle ORM, SQLite for the initial local release, Vitest, Testing Library, Playwright optional for browser smoke.

## Global Constraints

- Local path: `/Users/batigol/Projects/eve-chats`.
- Use strict TDD for behavior code: write failing test, verify RED, implement minimal GREEN, then refactor.
- Use small verified commits after each independently working slice.
- Do not print or commit secrets. Auth tokens are stored encrypted or redacted; `.env.local` stays gitignored.
- Browser must not call remote Eve agents directly; all Eve calls go through the local server-side connector.
- Use official `eve/client` for Eve session lifecycle where possible; raw fetch is only acceptable for tests/fake server support or endpoints not covered by the SDK.
- The initial release supports `authType: none | bearer | header` but only `none` and `bearer` need end-to-end UI in the first pass; `header` can be modelled and covered by unit tests.
- Eve routes expected on remote agents: `GET /eve/v1/health`, `GET /eve/v1/info`, `POST /eve/v1/session`, `POST /eve/v1/session/:sessionId`, `GET /eve/v1/session/:sessionId/stream`.
- Persist Eve `SessionState` as a cursor; persist UI messages/events separately because `SessionState` is not a transcript.

---

## File Structure

```text
/Users/batigol/Projects/eve-chats/
├── .plans/2026-07-09-eve-chats-initial-implementation.md
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── next.config.ts
├── vitest.config.ts
├── .gitignore
├── .env.example
├── drizzle.config.ts
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx
│   │   ├── agents/page.tsx
│   │   ├── agents/new/page.tsx
│   │   ├── chats/page.tsx
│   │   ├── chats/[chatId]/page.tsx
│   │   └── api/
│   │       ├── agents/route.ts
│   │       ├── agents/[agentId]/check/route.ts
│   │       ├── chats/route.ts
│   │       └── chats/[chatId]/messages/route.ts
│   ├── components/
│   │   ├── app-shell.tsx
│   │   ├── agent-connection-form.tsx
│   │   ├── agent-list.tsx
│   │   ├── chat-list.tsx
│   │   └── chat-thread.tsx
│   ├── db/
│   │   ├── schema.ts
│   │   ├── client.ts
│   │   ├── migrations/0000_initial.sql
│   │   └── repository.ts
│   ├── eve/
│   │   ├── auth.ts
│   │   ├── client.ts
│   │   ├── events.ts
│   │   └── fake-eve-server.test-helper.ts
│   ├── lib/
│   │   ├── crypto.ts
│   │   ├── env.ts
│   │   ├── ids.ts
│   │   └── validation.ts
│   └── test/
│       ├── setup.ts
│       └── db.ts
└── tests/
    ├── eve-client.test.ts
    ├── repository.test.ts
    ├── api-agents.test.ts
    ├── api-chats.test.ts
    └── chat-flow.test.ts
```

---

### Task 1: Initialize Local Repo and Tooling

**Files:**
- Create: `/Users/batigol/Projects/eve-chats/package.json`
- Create: `/Users/batigol/Projects/eve-chats/tsconfig.json`
- Create: `/Users/batigol/Projects/eve-chats/next.config.ts`
- Create: `/Users/batigol/Projects/eve-chats/vitest.config.ts`
- Create: `/Users/batigol/Projects/eve-chats/src/test/setup.ts`
- Create: `/Users/batigol/Projects/eve-chats/.gitignore`
- Create: `/Users/batigol/Projects/eve-chats/.env.example`

**Interfaces:**
- Produces: executable project scripts `dev`, `build`, `typecheck`, `test`, `test:watch`, `db:migrate`.
- Produces: baseline Next.js app that future tasks can extend.

- [ ] **Step 1: Create project directory and initialize git**

Run:

```bash
cd /Users/batigol/Projects
mkdir -p eve-chats
cd eve-chats
git init
git config user.name "Oscar Jiang"
git config user.email "pengj0520@gmail.com"
```

Expected:

```text
Initialized empty Git repository in /Users/batigol/Projects/eve-chats/.git/
```

- [ ] **Step 2: Write `package.json`**

Create `/Users/batigol/Projects/eve-chats/package.json`:

```json
{
  "name": "eve-chats",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.7.0",
  "engines": {
    "node": ">=24.0.0"
  },
  "scripts": {
    "dev": "next dev -p 3010",
    "build": "next build",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:migrate": "drizzle-kit migrate"
  },
  "dependencies": {
    "@assistant-ui/react": "latest",
    "@ai-sdk/react": "latest",
    "better-sqlite3": "latest",
    "drizzle-orm": "latest",
    "eve": "latest",
    "lucide-react": "latest",
    "next": "latest",
    "react": "latest",
    "react-dom": "latest",
    "zod": "latest"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "latest",
    "@testing-library/react": "latest",
    "@types/better-sqlite3": "latest",
    "@types/node": "latest",
    "@types/react": "latest",
    "@types/react-dom": "latest",
    "drizzle-kit": "latest",
    "jsdom": "latest",
    "typescript": "latest",
    "vitest": "latest"
  }
}
```

- [ ] **Step 3: Add TypeScript and Vitest config**

Create `/Users/batigol/Projects/eve-chats/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "es2022"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

Create `/Users/batigol/Projects/eve-chats/next.config.ts`:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typedRoutes: true,
};

export default nextConfig;
```

Create `/Users/batigol/Projects/eve-chats/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
});
```

Create `/Users/batigol/Projects/eve-chats/src/test/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 4: Add env and ignore files**

Create `/Users/batigol/Projects/eve-chats/.gitignore`:

```gitignore
node_modules
.next
.env
.env.local
*.sqlite
*.sqlite-shm
*.sqlite-wal
.DS_Store
```

Create `/Users/batigol/Projects/eve-chats/.env.example`:

```bash
DATABASE_URL=file:./eve-chats.sqlite
AUTH_SECRET=replace-with-local-dev-secret
```

- [ ] **Step 5: Install dependencies and verify toolchain**

Run:

```bash
cd /Users/batigol/Projects/eve-chats
node -v
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test
```

Expected:

```text
v26.x.x
No test files found, exiting with code 1
```

If Vitest exits `1` because there are no tests yet, accept that only for this setup task. Later tasks must have tests.

- [ ] **Step 6: Commit setup**

```bash
git add package.json pnpm-lock.yaml tsconfig.json next.config.ts vitest.config.ts src/test/setup.ts .gitignore .env.example
git commit -m "chore: initialize eve chats app"
```

---

### Task 2: Add Domain Types and Validation

**Files:**
- Create: `/Users/batigol/Projects/eve-chats/src/lib/validation.ts`
- Create: `/Users/batigol/Projects/eve-chats/src/lib/ids.ts`
- Create: `/Users/batigol/Projects/eve-chats/tests/domain-validation.test.ts`

**Interfaces:**
- Produces: `normalizeAgentBaseUrl(input: string): string`.
- Produces: `agentAuthSchema`, `createAgentConnectionSchema`, `createChatSchema`, `sendMessageSchema`.
- Produces: `createId(prefix: string): string`.

- [ ] **Step 1: Write failing validation tests**

Create `/Users/batigol/Projects/eve-chats/tests/domain-validation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  createAgentConnectionSchema,
  normalizeAgentBaseUrl,
  sendMessageSchema,
} from "@/lib/validation";

it("normalizes Eve agent base URLs without trailing slash", () => {
  expect(normalizeAgentBaseUrl("https://agent.example.com/")).toBe("https://agent.example.com");
});

it("rejects non-http Eve agent URLs", () => {
  expect(() => normalizeAgentBaseUrl("file:///tmp/agent")).toThrow("Agent URL must use http or https");
});

it("accepts bearer auth config without exposing token in validation output", () => {
  const parsed = createAgentConnectionSchema.parse({
    name: "Support Agent",
    baseUrl: "https://support.example.com",
    authType: "bearer",
    bearerToken: "secret-token",
  });

  expect(parsed.authType).toBe("bearer");
  expect(parsed.bearerToken).toBe("secret-token");
});

it("rejects empty chat messages", () => {
  expect(() => sendMessageSchema.parse({ message: "   " })).toThrow();
});
```

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
corepack pnpm test -- tests/domain-validation.test.ts
```

Expected: FAIL because `@/lib/validation` does not exist.

- [ ] **Step 3: Implement validation utilities**

Create `/Users/batigol/Projects/eve-chats/src/lib/validation.ts`:

```ts
import { z } from "zod";

export const authTypeSchema = z.enum(["none", "bearer", "header"]);

export function normalizeAgentBaseUrl(input: string): string {
  const trimmed = input.trim();
  let url: URL;

  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Agent URL must be a valid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Agent URL must use http or https");
  }

  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";

  return url.toString().replace(/\/$/, "");
}

export const createAgentConnectionSchema = z
  .object({
    name: z.string().trim().min(1),
    baseUrl: z.string().transform(normalizeAgentBaseUrl),
    authType: authTypeSchema.default("none"),
    bearerToken: z.string().optional(),
    headerName: z.string().optional(),
    headerValue: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.authType === "bearer" && !value.bearerToken?.trim()) {
      ctx.addIssue({ code: "custom", message: "Bearer token is required", path: ["bearerToken"] });
    }
    if (value.authType === "header" && (!value.headerName?.trim() || !value.headerValue?.trim())) {
      ctx.addIssue({ code: "custom", message: "Header name and value are required", path: ["headerName"] });
    }
  });

export const createChatSchema = z.object({
  agentId: z.string().min(1),
  message: z.string().trim().min(1),
});

export const sendMessageSchema = z.object({
  message: z.string().trim().min(1),
});
```

Create `/Users/batigol/Projects/eve-chats/src/lib/ids.ts`:

```ts
import { randomUUID } from "node:crypto";

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}
```

- [ ] **Step 4: Run test to verify GREEN**

Run:

```bash
corepack pnpm test -- tests/domain-validation.test.ts
corepack pnpm typecheck
```

Expected: tests pass and typecheck passes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/validation.ts src/lib/ids.ts tests/domain-validation.test.ts
git commit -m "feat: add agent connection validation"
```

---

### Task 3: Add SQLite Schema and Repository

**Files:**
- Create: `/Users/batigol/Projects/eve-chats/src/db/schema.ts`
- Create: `/Users/batigol/Projects/eve-chats/src/db/client.ts`
- Create: `/Users/batigol/Projects/eve-chats/src/db/repository.ts`
- Create: `/Users/batigol/Projects/eve-chats/src/test/db.ts`
- Create: `/Users/batigol/Projects/eve-chats/tests/repository.test.ts`
- Create: `/Users/batigol/Projects/eve-chats/drizzle.config.ts`

**Interfaces:**
- Produces: `createRepository(db): Repository`.
- Produces: repository methods `createAgentConnection`, `listAgentConnections`, `getAgentConnection`, `updateAgentHealth`, `createChat`, `getChat`, `appendMessage`, `listMessages`, `updateChatSessionState`.
- Produces tables: `agent_connections`, `chats`, `messages`, `events`.

- [ ] **Step 1: Write failing repository tests**

Create `/Users/batigol/Projects/eve-chats/tests/repository.test.ts` with tests for:

```ts
import { describe, expect, it } from "vitest";
import { createTestDb } from "@/test/db";
import { createRepository } from "@/db/repository";

it("creates and lists agent connections", async () => {
  const db = createTestDb();
  const repo = createRepository(db);

  const agent = await repo.createAgentConnection({
    name: "Support Agent",
    baseUrl: "https://support.example.com",
    authType: "none",
    authConfigEncrypted: null,
  });

  await expect(repo.listAgentConnections()).resolves.toMatchObject([
    { id: agent.id, name: "Support Agent", baseUrl: "https://support.example.com", status: "unknown" },
  ]);
});

it("stores chat session state separately from message history", async () => {
  const db = createTestDb();
  const repo = createRepository(db);
  const agent = await repo.createAgentConnection({
    name: "Support Agent",
    baseUrl: "https://support.example.com",
    authType: "none",
    authConfigEncrypted: null,
  });

  const chat = await repo.createChat({ agentConnectionId: agent.id, title: "Hello" });
  await repo.updateChatSessionState(chat.id, { sessionId: "ses_1", continuationToken: "eve:1", streamIndex: 3 });
  await repo.appendMessage({ chatId: chat.id, role: "user", content: "Hello", eventIndex: 0 });

  await expect(repo.getChat(chat.id)).resolves.toMatchObject({
    id: chat.id,
    sessionState: { sessionId: "ses_1", continuationToken: "eve:1", streamIndex: 3 },
  });
  await expect(repo.listMessages(chat.id)).resolves.toMatchObject([
    { role: "user", content: "Hello", eventIndex: 0 },
  ]);
});
```

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
corepack pnpm test -- tests/repository.test.ts
```

Expected: FAIL because DB modules do not exist.

- [ ] **Step 3: Implement Drizzle schema and repository**

Create schema with these tables:

```ts
// src/db/schema.ts
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const agentConnections = sqliteTable("agent_connections", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  authType: text("auth_type", { enum: ["none", "bearer", "header"] }).notNull(),
  authConfigEncrypted: text("auth_config_encrypted"),
  status: text("status", { enum: ["unknown", "healthy", "unreachable"] }).notNull().default("unknown"),
  lastCheckedAt: text("last_checked_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const chats = sqliteTable("chats", {
  id: text("id").primaryKey(),
  agentConnectionId: text("agent_connection_id").notNull().references(() => agentConnections.id),
  title: text("title").notNull(),
  sessionStateJson: text("session_state_json"),
  status: text("status", { enum: ["active", "completed", "failed"] }).notNull().default("active"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  chatId: text("chat_id").notNull().references(() => chats.id),
  role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
  content: text("content").notNull(),
  eventIndex: integer("event_index"),
  createdAt: text("created_at").notNull(),
});

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  chatId: text("chat_id").notNull().references(() => chats.id),
  eventIndex: integer("event_index").notNull(),
  type: text("type").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull(),
});
```

Implement repository methods using `drizzle-orm/better-sqlite3`, `eq`, and `asc`.

- [ ] **Step 4: Run tests and typecheck**

Run:

```bash
corepack pnpm test -- tests/repository.test.ts
corepack pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Generate initial migration**

Run:

```bash
corepack pnpm exec drizzle-kit generate
```

Expected: a migration under `src/db/migrations` or configured migration path.

- [ ] **Step 6: Commit**

```bash
git add drizzle.config.ts src/db src/test/db.ts tests/repository.test.ts
git commit -m "feat: persist agent chats locally"
```

---

### Task 4: Add Eve Client Connector

**Files:**
- Create: `/Users/batigol/Projects/eve-chats/src/eve/auth.ts`
- Create: `/Users/batigol/Projects/eve-chats/src/eve/client.ts`
- Create: `/Users/batigol/Projects/eve-chats/src/eve/events.ts`
- Create: `/Users/batigol/Projects/eve-chats/src/eve/fake-eve-server.test-helper.ts`
- Create: `/Users/batigol/Projects/eve-chats/tests/eve-client.test.ts`

**Interfaces:**
- Produces: `createEveClientForConnection(connection): Client`.
- Produces: `checkEveAgent(connection): Promise<{ status: "healthy" | "unreachable"; info?: unknown; error?: string }>`.
- Produces: `sendEveTurn(connection, sessionState, message): AsyncIterable<EveTurnUpdate>`.
- Produces: normalized event helpers for `message.appended`, `message.completed`, `session.waiting`, `session.completed`, `session.failed`, `input.requested`, `authorization.required`.

- [ ] **Step 1: Write failing Eve connector tests**

Create `/Users/batigol/Projects/eve-chats/tests/eve-client.test.ts` with a fake Eve HTTP server that returns:

```json
{"status":"ok"}
```

from `/eve/v1/health`, returns `{ "ok": true, "sessionId": "ses_1", "continuationToken": "eve:1" }` from `/eve/v1/session`, and streams NDJSON:

```json
{"type":"message.appended","data":{"messageDelta":"Hello","message":"Hello"}}
{"type":"message.completed","data":{"message":"Hello","finishReason":"stop"}}
{"type":"session.waiting","data":{}}
```

Tests:

```ts
it("checks remote Eve health", async () => { ... });
it("streams a first turn and returns updated session state", async () => { ... });
it("sends bearer auth to the remote Eve agent", async () => { ... });
```

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
corepack pnpm test -- tests/eve-client.test.ts
```

Expected: FAIL because `src/eve/client.ts` does not exist.

- [ ] **Step 3: Implement server-side Eve connector**

Use official SDK:

```ts
import { Client, type SessionState } from "eve/client";
```

Map auth:

```ts
export function buildEveAuth(connection: AgentConnection) {
  if (connection.authType === "bearer") {
    return { bearer: async () => decryptBearerToken(connection.authConfigEncrypted) };
  }
  return undefined;
}
```

Implement:

```ts
export async function checkEveAgent(connection: AgentConnection) {
  const client = createEveClientForConnection(connection);
  try {
    const health = await client.health();
    let info: unknown = null;
    try {
      info = await client.info();
    } catch {
      info = null;
    }
    return { status: "healthy" as const, health, info };
  } catch (error) {
    return { status: "unreachable" as const, error: error instanceof Error ? error.message : String(error) };
  }
}
```

Implement streaming via `client.session(savedState).send(message)` and yield normalized updates.

- [ ] **Step 4: Run tests and typecheck**

Run:

```bash
corepack pnpm test -- tests/eve-client.test.ts
corepack pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/eve tests/eve-client.test.ts
git commit -m "feat: connect to remote eve agents"
```

---

### Task 5: Add Agent Connection API

**Files:**
- Create: `/Users/batigol/Projects/eve-chats/src/app/api/agents/route.ts`
- Create: `/Users/batigol/Projects/eve-chats/src/app/api/agents/[agentId]/check/route.ts`
- Create: `/Users/batigol/Projects/eve-chats/tests/api-agents.test.ts`

**Interfaces:**
- Produces: `GET /api/agents` returning `{ agents: AgentConnection[] }` with redacted auth.
- Produces: `POST /api/agents` accepting `{ name, baseUrl, authType, bearerToken?, headerName?, headerValue? }`.
- Produces: `POST /api/agents/:agentId/check` that verifies health/info and updates status.

- [ ] **Step 1: Write failing API tests**

Create tests for:

```ts
it("creates an agent connection without returning bearer token", async () => { ... });
it("lists created agent connections", async () => { ... });
it("checks agent health and persists healthy status", async () => { ... });
```

Use the fake Eve server from Task 4.

- [ ] **Step 2: Verify RED**

Run:

```bash
corepack pnpm test -- tests/api-agents.test.ts
```

Expected: FAIL because API routes do not exist.

- [ ] **Step 3: Implement API routes**

`POST /api/agents` flow:

```text
parse request with createAgentConnectionSchema
normalize URL
encrypt auth config if present
create DB record with status unknown
call checkEveAgent
update status/lastCheckedAt
return redacted agent
```

Redacted agent shape:

```ts
{
  id: string;
  name: string;
  baseUrl: string;
  authType: "none" | "bearer" | "header";
  hasAuth: boolean;
  status: "unknown" | "healthy" | "unreachable";
  lastCheckedAt: string | null;
}
```

- [ ] **Step 4: Run tests and typecheck**

```bash
corepack pnpm test -- tests/api-agents.test.ts
corepack pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/agents tests/api-agents.test.ts
git commit -m "feat: add agent connection api"
```

---

### Task 6: Add Chat API and Streaming Turn Persistence

**Files:**
- Create: `/Users/batigol/Projects/eve-chats/src/app/api/chats/route.ts`
- Create: `/Users/batigol/Projects/eve-chats/src/app/api/chats/[chatId]/messages/route.ts`
- Create: `/Users/batigol/Projects/eve-chats/tests/api-chats.test.ts`

**Interfaces:**
- Produces: `GET /api/chats` returning chat summaries.
- Produces: `POST /api/chats` creating a chat bound to one agent and sending first message.
- Produces: `POST /api/chats/:chatId/messages` sending follow-up message using saved Eve `SessionState`.
- Produces: persisted user/assistant messages and raw Eve events.

- [ ] **Step 1: Write failing chat API tests**

Tests:

```ts
it("creates a chat bound to one agent and stores session state", async () => { ... });
it("continues a chat using saved continuation token", async () => { ... });
it("stores assistant message from message.completed", async () => { ... });
it("rejects chat creation for unreachable agent", async () => { ... });
```

- [ ] **Step 2: Verify RED**

Run:

```bash
corepack pnpm test -- tests/api-chats.test.ts
```

Expected: FAIL because chat routes do not exist.

- [ ] **Step 3: Implement `POST /api/chats`**

Flow:

```text
parse { agentId, message }
load agent connection
reject if missing or status unreachable
create chat title from first 80 chars of message
append user message
send Eve turn via connector
persist each raw event with eventIndex
upsert assistant message from message.completed
update chat sessionState from Eve client session state
return { chat, messages }
```

- [ ] **Step 4: Implement `POST /api/chats/:chatId/messages`**

Flow:

```text
load chat + agent connection + sessionState
append user message
send follow-up with saved sessionState
persist events/messages
update sessionState
return { chat, messages }
```

- [ ] **Step 5: Run tests and typecheck**

```bash
corepack pnpm test -- tests/api-chats.test.ts
corepack pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/chats tests/api-chats.test.ts
git commit -m "feat: add bound eve chat api"
```

---

### Task 7: Add Agent Management UI

**Files:**
- Create: `/Users/batigol/Projects/eve-chats/src/app/layout.tsx`
- Create: `/Users/batigol/Projects/eve-chats/src/app/page.tsx`
- Create: `/Users/batigol/Projects/eve-chats/src/app/agents/page.tsx`
- Create: `/Users/batigol/Projects/eve-chats/src/app/agents/new/page.tsx`
- Create: `/Users/batigol/Projects/eve-chats/src/components/app-shell.tsx`
- Create: `/Users/batigol/Projects/eve-chats/src/components/agent-connection-form.tsx`
- Create: `/Users/batigol/Projects/eve-chats/src/components/agent-list.tsx`

**Interfaces:**
- Produces: `/agents` list page.
- Produces: `/agents/new` form that can register and verify an Eve agent.

- [ ] **Step 1: Write failing component tests**

Create tests that render `AgentConnectionForm` and verify:

```ts
it("submits a remote Eve base URL", async () => { ... });
it("shows validation errors for invalid URLs", async () => { ... });
```

- [ ] **Step 2: Verify RED**

Run:

```bash
corepack pnpm test -- tests/agent-ui.test.tsx
```

Expected: FAIL because components do not exist.

- [ ] **Step 3: Implement shell and pages**

Implement simple navigation:

```text
Eve Chats
Agents | Chats
```

`/agents/new` form fields:

```text
Name
Base URL
Auth Type: None | Bearer Token | Custom Header
Bearer Token conditional input
Header Name/Header Value conditional inputs
```

Submit to `POST /api/agents`, then navigate to `/agents`.

- [ ] **Step 4: Run tests and build checks**

```bash
corepack pnpm test -- tests/agent-ui.test.tsx
corepack pnpm typecheck
corepack pnpm build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app src/components tests/agent-ui.test.tsx
git commit -m "feat: add agent connection ui"
```

---

### Task 8: Add Chat History and Thread UI

**Files:**
- Create: `/Users/batigol/Projects/eve-chats/src/app/chats/page.tsx`
- Create: `/Users/batigol/Projects/eve-chats/src/app/chats/[chatId]/page.tsx`
- Create: `/Users/batigol/Projects/eve-chats/src/components/chat-list.tsx`
- Create: `/Users/batigol/Projects/eve-chats/src/components/chat-thread.tsx`
- Create: `/Users/batigol/Projects/eve-chats/tests/chat-ui.test.tsx`

**Interfaces:**
- Produces: `/chats` showing chat summaries and start-chat entrypoint.
- Produces: `/chats/:chatId` showing a thread bound to one agent.
- Uses assistant-ui React components where they fit; if assistant-ui custom runtime integration is too large for the initial release, use a local wrapper component and keep the data contract compatible with assistant-ui thread messages.

- [ ] **Step 1: Write failing UI tests**

Tests:

```ts
it("renders chat history with bound agent names", async () => { ... });
it("renders a chat thread and sends a follow-up", async () => { ... });
it("does not allow changing the agent inside an existing chat", async () => { ... });
```

- [ ] **Step 2: Verify RED**

```bash
corepack pnpm test -- tests/chat-ui.test.tsx
```

Expected: FAIL because chat UI does not exist.

- [ ] **Step 3: Implement chat pages**

`/chats`:

```text
Start a new chat
- Select healthy AgentConnection
- First message textarea
- Submit creates chat via POST /api/chats
```

`/chats/:chatId`:

```text
Header: chat title, bound agent name, status
Thread: user and assistant messages
Composer: sends POST /api/chats/:chatId/messages
```

- [ ] **Step 4: Run tests, typecheck, build**

```bash
corepack pnpm test -- tests/chat-ui.test.tsx
corepack pnpm typecheck
corepack pnpm build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/chats src/components/chat-list.tsx src/components/chat-thread.tsx tests/chat-ui.test.tsx
git commit -m "feat: add unified eve chat ui"
```

---

### Task 9: Add End-to-End Local Smoke with Fake Eve Agent

**Files:**
- Create: `/Users/batigol/Projects/eve-chats/tests/chat-flow.test.ts`
- Modify: `/Users/batigol/Projects/eve-chats/src/eve/fake-eve-server.test-helper.ts`
- Create: `/Users/batigol/Projects/eve-chats/docs/development.md`

**Interfaces:**
- Produces: a repeatable fake Eve server smoke proving register-agent -> create-chat -> send-follow-up.
- Produces: local development docs with exact commands.

- [ ] **Step 1: Write failing integration smoke**

Create test covering:

```text
start fake Eve server
POST /api/agents with fake server URL
POST /api/chats first message
POST /api/chats/:chatId/messages follow-up
assert persisted messages include user and assistant replies
assert chat sessionState has sessionId, continuationToken, streamIndex
```

- [ ] **Step 2: Verify RED**

Run:

```bash
corepack pnpm test -- tests/chat-flow.test.ts
```

Expected: FAIL until helper/API wiring handles complete flow.

- [ ] **Step 3: Implement missing integration wiring**

Fix only the missing pieces discovered by the smoke test. Do not add new features outside the smoke path.

- [ ] **Step 4: Write local docs**

Create `/Users/batigol/Projects/eve-chats/docs/development.md`:

```md
# Local Development

## Requirements

- Node >= 24
- pnpm via Corepack

## Setup

```bash
corepack pnpm install
cp .env.example .env.local
corepack pnpm db:migrate
corepack pnpm dev
```

Open http://localhost:3010.

## Test

```bash
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
```

## Connecting an Eve Agent

A remote Eve agent should expose:

- GET /eve/v1/health
- GET /eve/v1/info
- POST /eve/v1/session
- POST /eve/v1/session/:sessionId
- GET /eve/v1/session/:sessionId/stream
```

- [ ] **Step 5: Run full verification**

```bash
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add tests/chat-flow.test.ts src/eve/fake-eve-server.test-helper.ts docs/development.md
git commit -m "test: add eve chat smoke flow"
```

---

### Task 10: Final Review, Cleanup, and Optional GitHub Repo Prep

**Files:**
- Modify only files with lint/type/build issues.
- Optional create: `/Users/batigol/Projects/eve-chats/README.md`

**Interfaces:**
- Produces: clean git history and a local repo ready to push to `evelandhq/eve-chats` if Oscar approves.

- [ ] **Step 1: Run final verification**

```bash
cd /Users/batigol/Projects/eve-chats
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
git status --short
git log --oneline --decorate -10
```

Expected:

```text
test passes
typecheck passes
build passes
git status --short is empty
```

- [ ] **Step 2: Add README**

Create `/Users/batigol/Projects/eve-chats/README.md`:

```md
# eve-chats

Standalone chat UI for connecting to open Eve agents by remote base URL.

## Core model

```text
AgentConnection -> Chat -> Message/Event
```

The browser talks to eve-chats. eve-chats talks server-side to remote Eve agents using `eve/client` and the default Eve HTTP API.

## Development

See `docs/development.md`.
```

- [ ] **Step 3: Commit README and cleanup**

```bash
git add README.md
git commit -m "docs: document eve chats"
```

- [ ] **Step 4: Stop before remote side effects**

Do not create the GitHub repo or push until Oscar explicitly approves the local result and target organization/name.

---

## Risks and Tradeoffs

- **assistant-ui integration depth:** assistant-ui has Eve runtime support, but a remote multi-agent registry still needs our server-side proxy and persistence. The initial release may use assistant-ui components without adopting its whole runtime until the connector contract is stable.
- **Eve preview API changes:** Eve is preview; pinning `eve` to a tested version after the initial install may be safer than `latest` before publishing.
- **Auth design:** Bearer/custom header support is enough for the initial release, but real multi-user sharing will require per-user secrets, encryption key rotation, and access control.
- **Streaming UX:** Full token-level streaming through our backend to assistant-ui may require an additional custom runtime adapter. The initial release can persist and render final assistant messages first, then enhance to live deltas.
- **SQLite local persistence:** Suitable for the initial local release; production needs Postgres or another durable DB.

## Open Questions for Review

1. Should the first version require live token streaming in UI, or is final-message streaming/persistence acceptable for the initial release?
2. Should we pin `eve` to the current verified version (`0.22.1`) instead of `latest`?
3. Should `eve-chats` be purely local-first SQLite initially, or should we start with Postgres to match future hosted deployment?
4. Should we include an optional `/.well-known/eve-agent.json` discovery attempt in the initial release, or defer until direct base URL works end-to-end?
5. Should the GitHub remote be `evelandhq/eve-chats`, and should it be created only after the initial local release passes?

## Execution Options After Review

1. **Subagent-Driven (recommended):** execute one task per fresh subagent, with review/checkpoint after each task and verified commits.
2. **Inline Execution:** I execute the tasks directly in this session with strict RED-GREEN-REFACTOR and commit after each slice.

My default recommendation: approve Task 1-4 first as the foundation slice, then review the connector API before building the UI.
