# Local Development

## Requirements

- Node >=24
- pnpm via Corepack
- Docker with Compose support

## Setup

The repository provides PostgreSQL 16 on `127.0.0.1:55433`; it avoids both the conventional host port 5432 and port 55432, which may already be used by another local project. The example database role and password are both `eve_chats` and are intended only for loopback local development.

```sh
corepack pnpm install
cp .env.example .env.local
# Edit .env.local and replace the AUTH_SECRET placeholder with a real local secret.
corepack pnpm db:up
corepack pnpm db:migrate
corepack pnpm dev
```

`db:up` waits for the PostgreSQL health check. Open http://localhost:3010 after starting the app.

Start Eveland API/Web/Worker as well, then in Eveland System > Identity:

1. create and enable the Internal Provider;
2. create its exact allowed Internal Realm;
3. save `http://localhost:3010` as the `eve-chats` return target;
4. grant that Realm to the Greeter Project.

Register the Greeter Agent here with `authType=none` and its Eveland Project ID. The
browser enters Eveland through `/identity/login`; it never reads Better Auth or selects
Internal/OIDC itself. Caller Tokens stay in memory and are refreshed before expiry.

Localhost ports are the same schemeful site, so the `SameSite=Lax` Identity
cookie is available to credentialed browser requests. Production deployments
must preserve that topology under one HTTPS site; an unrelated EveChats site
requires an explicit authorization-code handoff that is outside this phase.

## Tests and verification

Tests require the real PostgreSQL server above. Every test database handle creates a unique schema, applies the generated Drizzle migration, and drops the schema during teardown, so Vitest workers can run in parallel safely.

```sh
corepack pnpm db:up
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
```

Use `TEST_DATABASE_URL` to point tests at another disposable PostgreSQL 16 server when necessary. The configured role must be able to create and drop schemas. To stop local services without deleting PostgreSQL data:

```sh
corepack pnpm db:down
```

Generate a migration after intentional schema changes, then apply it:

```sh
corepack pnpm db:generate
corepack pnpm db:migrate
```

## Connecting an Eve Agent

A local Eve Agent connection must expose the Eve HTTP routes under its configured base URL:

- `GET /eve/v1/health`
- `GET /eve/v1/info`
- `POST /eve/v1/session`
- `POST /eve/v1/session/:sessionId`
- `GET /eve/v1/session/:sessionId/stream`

Register that base URL and its Eveland Project ID in the app, then create a chat against
the registered agent. Every list/detail/create/continue/stream request requires a valid
Caller Token whose principal, Realm, and project match the chat. A chat turn creates or
continues an Eve session, consumes the stream, persists canonical events, and stores
`sessionId`, server-only `continuationToken`, and `streamIndex` for follow-up messages.
