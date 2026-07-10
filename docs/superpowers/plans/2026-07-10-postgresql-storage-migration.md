# PostgreSQL Storage Migration Implementation Plan

> **For Hermes:** Use subagent-driven-development to implement this plan with strict RED-GREEN-REFACTOR and parent verification.

**Goal:** Remove SQLite/better-sqlite3 completely and run eve-chats on PostgreSQL 16 in development, tests, and production runtime.

**Architecture:** Use `pg` Pool with `drizzle-orm/node-postgres`. Define the schema with `pgTable` and timezone-aware timestamps. Local development uses a repository-owned PostgreSQL Docker Compose service on host port 55433 because 55432 is already occupied by another local project. Tests use the same real PostgreSQL server but create a unique schema per test database handle, apply the generated PostgreSQL migration inside that schema, and drop it during cleanup.

**Tech Stack:** PostgreSQL 16, pg, Drizzle ORM/Kit, Vitest, Docker Compose, Next.js.

---

### Task 1: Add a PostgreSQL test tracer bullet

**Files:**
- Create: `tests/postgres-storage.test.ts`
- Modify: `src/test/db.ts`

1. Write a failing test that imports `createPostgresTestDbHandle`, connects to PostgreSQL, and verifies `version()` reports PostgreSQL.
2. Run the targeted test and capture RED because the PostgreSQL helper does not exist.
3. Implement the minimal async PostgreSQL test handle using a unique schema.
4. Run the targeted test and capture GREEN.

### Task 2: Migrate schema and runtime database client

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/client.ts`
- Modify: `src/db/provider.ts` only if lifecycle/types require it
- Modify: `src/db/repository.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

1. Replace SQLite schema imports/tables with PostgreSQL equivalents.
2. Replace integer millisecond timestamps with timezone-aware PostgreSQL timestamps in Date mode.
3. Replace better-sqlite3 client types with node-postgres Drizzle types.
4. Convert SQLite-specific `.get()` / `.run()` calls to PostgreSQL returning-array semantics.
5. Remove `better-sqlite3` and `@types/better-sqlite3`; add `pg` and `@types/pg`.
6. Preserve repository API behavior, error messages, ordering, redaction, and runtime JSON validation.

### Task 3: Replace migrations with PostgreSQL migration

**Files:**
- Modify: `drizzle.config.ts`
- Remove: SQLite migration and metadata under `src/db/migrations/`
- Generate: PostgreSQL migration and metadata under `src/db/migrations/`

1. Change Drizzle dialect to PostgreSQL and require a PostgreSQL `DATABASE_URL`.
2. Regenerate a clean initial PostgreSQL migration.
3. Verify generated SQL contains PostgreSQL tables, FK cascades, timezone-aware timestamps, and the event unique index.
4. Ensure test DB setup applies the generated migration rather than a hand-maintained schema copy.

### Task 4: Convert all tests to real PostgreSQL isolation

**Files:**
- Modify: `src/test/db.ts`
- Modify: every test using `createTestDbHandle`
- Modify/Create: `tests/postgres-storage.test.ts`

1. Make test setup/cleanup async.
2. Create one unique PostgreSQL schema per test handle.
3. Configure every pool connection with that schema as `search_path`.
4. Apply the generated migration in the schema.
5. Drop the schema with cascade and close pools after each test.
6. Preserve corrupt-JSON tests by issuing PostgreSQL-compatible updates.
7. Run repository, API, UI, and smoke suites against PostgreSQL.

### Task 5: Add local PostgreSQL operations and documentation

**Files:**
- Create: `compose.yaml`
- Modify: `.env.example`
- Modify: `.gitignore`
- Modify: `docs/local-development.md`
- Modify: `README.md` if SQLite is mentioned
- Modify: local ignored `.env.local`

1. Add PostgreSQL 16 service with persistent volume, health check, and host port 55433.
2. Document `docker compose up -d postgres`, readiness, migration, dev, test, and shutdown commands.
3. Change example/local URLs to `postgresql://...@127.0.0.1:55433/eve_chats`.
4. Remove SQLite-specific ignore entries and wording.
5. Never print auth secrets.

### Task 6: Full verification and browser E2E

1. Start PostgreSQL 16 via Compose and wait for healthy.
2. Run `corepack pnpm db:migrate` against the development database.
3. Run targeted PostgreSQL/repository tests.
4. Run `corepack pnpm test` and confirm every test uses PostgreSQL.
5. Run `corepack pnpm typecheck`.
6. Run `corepack pnpm build`.
7. Start fake Eve + local app and perform browser E2E: register agent, create chat, follow-up.
8. Query PostgreSQL to verify agent/chat/messages/events/session state persistence.
9. Run spec and code-quality reviews, fix blocking findings, and commit locally without pushing unless Oscar confirms.

## Risks and decisions

- Existing local SQLite data is disposable E2E data and will not be imported.
- Tests require Docker/PostgreSQL. Failure messages must clearly state how to start the test database.
- Use per-test schemas instead of per-test databases to support parallel Vitest workers efficiently.
- Do not introduce Prisma, an additional repository abstraction, or JSONB migration unless required by existing behavior.
