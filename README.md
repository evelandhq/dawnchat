# eve-chats

Standalone chat UI for connecting to open Eve agents by remote base URL.

## Core model

```text
AgentConnection -> Chat -> Eve Event Stream
```

The browser renders Eve's `defaultMessageReducer` projection with AI Elements and talks to a same-origin, per-chat Eve protocol proxy. The proxy selects the registered remote agent, adds its server-side credentials and continuation token, and persists the raw Eve event stream.

EveChats currently has no application login and deliberately uses one local operator identity for principal-scoped Agent credentials. Deploy it only as a private, single-user service. A shared or public deployment requires an application identity boundary before per-user OIDC credentials can be isolated safely.

## What this MVP includes

- Register remote Eve agents by base URL.
- All standard Eve Agent access methods: local development, no authentication, HTTP Basic, Bearer token, Vercel OIDC, custom headers, and OIDC Authorization Code with PKCE.
- Connection credentials and OIDC tokens are encrypted server-side; credential-bearing checks and chat requests never follow redirects.
- OIDC provider discovery, access-token verification, refresh, single-use callback state, and one-time recovery after a rejected credential.
- Health-check registered agents.
- Start chats bound to one healthy agent.
- Stream and render text, reasoning, tool calls/results, HITL requests, authorization challenges, and files through AI Elements.
- Persist Eve events as the canonical chat history, with continuation tokens redacted and idempotent `(chat, session, stream index)` replay handling.
- Continue existing chats through `useEveAgent` while keeping remote auth and the real `continuationToken` server-side.
- Connect to Eve agents running either 0.24.x or 0.25.x.
- PostgreSQL 16 persistence for agents, chats, protocol events, and Eve session state.

## Development

See [`docs/local-development.md`](docs/local-development.md).

## Production deployment (single machine)

```bash
echo "AUTH_SECRET=$(openssl rand -base64 32)" >> .env  # once, on first deploy
echo "APP_ORIGIN=https://chats.example.com" >> .env
docker compose -f compose.production.yaml up -d --build
```

This builds the app image, starts PostgreSQL, applies Drizzle migrations, and serves the app on port 3010. `AUTH_SECRET` encrypts agent credentials stored in Postgres and must stay the same across restarts. `APP_ORIGIN` is the canonical public origin used for OIDC callbacks; request `Host` headers are never trusted for this value. See the header of [`compose.production.yaml`](compose.production.yaml) for optional overrides (`POSTGRES_PASSWORD`, `APP_PORT`, `NPM_REGISTRY`).
