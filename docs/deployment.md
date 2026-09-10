# Deployment

`compose.production.yaml` provides a single-machine deployment with PostgreSQL
16, a one-shot Drizzle migration service, and the standalone Next.js server.

## Configure

Create a `.env` beside the Compose file. At minimum, set:

```dotenv
AUTH_SECRET=<stable-random-secret>
EVELAND_PUBLIC_ORIGIN=https://eveland.example.com
EVELAND_IDENTITY_RETURN_TARGET=eve-chats
```

Generate `AUTH_SECRET` once with `openssl rand -base64 32`. Keep it unchanged
across restarts: changing it invalidates browser sessions and makes stored
external-Agent credentials unreadable.

Optional values include `POSTGRES_PASSWORD`, `APP_PORT`,
`EVELAND_INTERNAL_ORIGIN`, `EVELAND_IDENTITY_ISSUER`,
`EVELAND_IDENTITY_JWKS_URL`, and `NPM_REGISTRY`. The default application port
is 3010.

## Start or update

```sh
docker compose -f compose.production.yaml up -d --build
```

Compose waits for PostgreSQL, applies pending migrations, and starts Dawn
only after the migration service succeeds.

Register the exact public Dawn origin under Eveland System > Identity and
add it explicitly to Eveland's `EVELAND_IDENTITY_ALLOWED_ORIGINS`. Dawn uses
Eveland's single public frontdoor for browser login and Catalog discovery. When
the box cannot reach that host itself — a load balancer that only answers from
outside, for instance — set `EVELAND_INTERNAL_ORIGIN` to a reachable frontdoor
such as `http://host.docker.internal:17300`. The server then reads
`/api/identity/*`, `/api/agent-catalog`, and JWKS over that route while the
browser keeps the public one.

New Eveland installs use the public origin as their token issuer, so no issuer
or JWKS override is needed. If an existing Eveland deployment keeps its old
`EVELAND_IDENTITY_ISSUER` during the frontdoor migration, copy that exact value
into Dawn; existing managed chats remain attached to the same issuer and need
no database migration. Set `EVELAND_IDENTITY_JWKS_URL` only when the default
`<internal-origin>/.well-known/jwks.json` is not reachable.

For an upgrade from Eveland's older split-port layout, rebuild and promote
managed Agents with Eveland SDK 0.6 or newer so their authentication challenge
uses `/api/identity/login`, then rebuild Dawn so its Next.js rewrite captures
the new frontdoor. Re-register Dawn's return URL and allowed origin before
switching traffic.

## Network and cookie requirements

Serve Dawn over HTTPS. Eveland Identity and Dawn should share one
schemeful site, for example `identity.example.com` and `chat.example.com`, so
the Identity cookie works with the same-origin rewrite and provider login
flow. Keep PostgreSQL private; the production Compose file does not publish its
port.

Back up the `postgres-data` volume and `.env` together. Database backups
without the matching `AUTH_SECRET` cannot recover encrypted external-Agent
credentials.
