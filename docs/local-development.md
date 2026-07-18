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
# Keep APP_ORIGIN aligned with the URL used to open EveChats.
corepack pnpm db:up
corepack pnpm db:migrate
corepack pnpm dev
```

`db:up` waits for the PostgreSQL health check. Open http://localhost:3010 after starting the app.

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

Register that base URL in the app, then create a chat against the registered agent. A chat turn creates or continues an Eve session, consumes the stream, persists user/assistant messages, and stores the session state (`sessionId`, `continuationToken`, and `streamIndex`) for follow-up messages.

Choose the Agent access method explicitly. `Local development` is accepted only for `localhost`, `*.localhost`, `127.0.0.0/8`, or `::1` URLs, matching Eve's `localDev()` identity. Credential-bearing methods use manual redirect handling so credentials cannot follow a cross-origin redirect.

For `OIDC Authorization Code`, register this redirect URI with the identity provider:

```text
http://localhost:3010/agent-auth/oidc/callback
```

Use the deployed EveChats origin instead of `http://localhost:3010` in production. EveChats performs Authorization Code with PKCE, validates the access token through OIDC UserInfo or Eve's OIDC JWT verifier, and refreshes expiring credentials on the server.
