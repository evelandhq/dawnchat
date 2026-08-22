# Development

## Requirements

- Node.js 24 or newer
- pnpm through Corepack
- Docker with Compose support
- For end-to-end browser use, a local Eveland API/Web/Worker stack

## Setup

The repository provides PostgreSQL 16 on `127.0.0.1:55433`. The local role,
password, and database are all `eve_chats` and are intended only for loopback
development.

```sh
corepack pnpm install
cp .env.example .env.local
corepack pnpm db:up
corepack pnpm db:migrate
corepack pnpm dev
```

Replace the `AUTH_SECRET` placeholder in `.env.local` with a stable local
secret. Update the Eveland Identity URLs if Eveland is not running at
`http://localhost:4000`. Open [http://localhost:3010](http://localhost:3010).

For a login-enabled Eveland instance, configure Eveland System > Identity:

1. enable an Identity Provider and its exact Realm;
2. register `http://localhost:3010` as the `eve-chats` return target; and
3. deploy a chat-enabled Project with the standard Eve channel on its Stable
   route.

The Project then appears automatically on `/agents`. An Eveland instance that
explicitly uses open access has no login session; EveChats falls back to its
signed browser session for chat ownership.

## Verification

Tests use the same PostgreSQL server. Each database handle creates a unique
schema, applies all Drizzle migrations, and drops the schema during teardown,
so Vitest workers can run in parallel.

```sh
corepack pnpm db:up
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
```

Set `TEST_DATABASE_URL` to use another disposable PostgreSQL 16 server. The
configured role must be allowed to create and drop schemas.

Stop local services without deleting the PostgreSQL volume:

```sh
corepack pnpm db:down
```

## Database changes

After an intentional schema change, generate and apply a migration:

```sh
corepack pnpm db:generate
corepack pnpm db:migrate
```

Review generated SQL and migration metadata before committing them. For the
historical stream-delta cleanup procedure, see
[Eve protocol integration](eve-protocol.md#event-persistence-and-projection).

## External Eve Agents

Use **Add external Agent** on `/agents` for an Agent outside the Eveland
Catalog. Configure its base URL and, if required, bearer or custom-header
authentication. EveChats normalizes external base URLs and permits only one
active connection for each normalized URL.

The Agent must implement the routes described in
[Eve protocol integration](eve-protocol.md). Health checks call the Agent
server-side; secrets are encrypted at rest and never returned to the browser.
