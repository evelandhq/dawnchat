# Deployment

`compose.production.yaml` provides a single-machine deployment with PostgreSQL
16, a one-shot Drizzle migration service, and the standalone Next.js server.

## Configure

Create a `.env` beside the Compose file. At minimum, set:

```dotenv
AUTH_SECRET=<stable-random-secret>
EVELAND_IDENTITY_URL=https://identity.example.com
EVELAND_IDENTITY_ISSUER=https://identity.example.com
EVELAND_IDENTITY_JWKS_URL=https://identity.example.com/.well-known/jwks.json
```

Generate `AUTH_SECRET` once with `openssl rand -base64 32`. Keep it unchanged
across restarts: changing it invalidates browser sessions and makes stored
external-Agent credentials unreadable.

Optional values include `POSTGRES_PASSWORD`, `APP_PORT`,
`EVELAND_IDENTITY_RETURN_TARGET`, and `NPM_REGISTRY`. The default application
port is 3010.

## Start or update

```sh
docker compose -f compose.production.yaml up -d --build
```

Compose waits for PostgreSQL, applies pending migrations, and starts EveChats
only after the migration service succeeds.

Register the exact public EveChats origin under Eveland System > Identity and
add it to Eveland's allowed Identity origins. The public Identity URL is baked
into the browser bundle at image-build time. `EVELAND_IDENTITY_URL` may point to
`host.docker.internal` when the container needs a different server-reachable
route to the same Identity service.

## Network and cookie requirements

Serve EveChats over HTTPS. Eveland Identity and EveChats should share one
schemeful site, for example `identity.example.com` and `chat.example.com`, so
the Identity cookie works with the same-origin rewrite and provider login
flow. Keep PostgreSQL private; the production Compose file does not publish its
port.

Back up the `postgres-data` volume and `.env` together. Database backups
without the matching `AUTH_SECRET` cannot recover encrypted external-Agent
credentials.
