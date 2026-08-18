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
3. save `http://localhost:3010` as the `eve-chats` return target.

Deploy a Greeter source revision that uses the standard
`agent/channels/eve.ts` `eveChannel`, and make that running Deployment the
Project's Stable route. EveChats then displays Greeter automatically at
`/agents`; no Gateway URL, manual Project ID, or login is required to browse the
Catalog. `/` opens the most recent Chat visible to the current browser/Identity
scope and falls back to `/agents` when there is no history. Clicking a Catalog
Agent lazily creates the local connection keyed by Eveland issuer and Project
ID.

The browser enters Eveland through `/identity/login`; it never reads Better
Auth or selects Internal/OIDC itself. App Tokens and Caller Tokens stay in
memory and are refreshed before expiry. Opening any page runs the app-level
identity gate: without an Eveland Identity Session the browser is redirected
to Eveland login and returned to the page it opened. A signed, HttpOnly
EveChats browser-session cookie still identifies the browser; the first
authenticated load claims that cookie's identity-less chats into the
signed-in identity via `POST /api/chats/claim`. App Tokens scope history and
mutations to the identity without being forwarded upstream. If the Agent
advertises Eveland Identity in its `WWW-Authenticate` challenge, EveChats
follows the Agent-provided continuation, obtains a Project Caller Token, and
retries the original request. Catalog membership alone never causes a Caller
Token to be requested or forwarded, and an Agent that requests no Eveland
Identity receives no Eveland credential.

Because local Eveland Identity and EveChats share the `localhost` hostname,
cookie-bearing Identity session, App Token, Caller Token, and logout requests
use EveChats' same-origin `/identity/*` path, which Next proxies to the
configured Eveland Identity origin. Top-level login and Agent-provided
continuation navigation still go directly to Eveland. This prevents Safari
from losing the Identity cookie on a cross-port credentialed request and
restarting the login flow. Deployments with different hostnames retain direct
Identity requests and must preserve one HTTPS schemeful site; an unrelated
EveChats site requires an explicit authorization-code handoff that is outside
this phase.

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

Use the manual form only for an external Agent and configure its own bearer or
header authentication when needed. Eveland-managed Agents come from the
Identity Catalog instead. History list/detail requests require either the
signed browser-session cookie that owns an anonymous chat or an App Token whose
issuer, principal, and Realm match an identity-owned chat. Neither credential
is forwarded upstream. After an Eveland challenge, a Caller Token for the exact
Project is accepted and forwarded only to the signed Catalog endpoint.
External turns forward only the external Agent's stored authentication. A turn
creates or continues an Eve session, consumes the stream, persists canonical
events, and stores `sessionId`, `streamIndex`, and — for a session opened
against an Eve 0.29/0.30 Agent — a server-only `continuationToken` for
follow-up messages. Every Agent in the supported window (0.38.x and 0.39.x)
addresses the session by ID, so no token is stored and none is sent.
