# eve-chats

Standalone chat UI for connecting to open Eve agents by remote base URL.

## Core model

```text
AgentConnection -> Chat -> Eve Event Stream
```

The browser renders Eve's `defaultMessageReducer` projection with AI Elements and talks to a same-origin, per-chat Eve protocol proxy. The proxy selects the registered remote agent, adds its server-side credentials and continuation token, and persists the raw Eve event stream.

## What this MVP includes

- Register remote Eve agents by base URL.
- Optional agent auth via bearer token or custom header, stored encrypted server-side.
- Health-check registered agents.
- Start chats bound to one healthy agent.
- Stream and render text, reasoning, tool calls/results, HITL requests, authorization challenges, and files through AI Elements.
- Persist raw Eve events as the canonical chat history, with idempotent `(chat, session, stream index)` replay handling.
- Continue existing chats through `useEveAgent` while keeping remote auth and the real `continuationToken` server-side.
- PostgreSQL 16 persistence for agents, chats, raw events, and Eve session state.

## Development

See [`docs/local-development.md`](docs/local-development.md).

## Production deployment (single machine)

```bash
echo "AUTH_SECRET=$(openssl rand -base64 32)" >> .env  # once, on first deploy
docker compose -f compose.production.yaml up -d --build
```

This builds the app image, starts PostgreSQL, applies Drizzle migrations, and serves the app on port 3010. `AUTH_SECRET` encrypts agent credentials stored in Postgres and must stay the same across restarts. See the header of [`compose.production.yaml`](compose.production.yaml) for optional overrides (`POSTGRES_PASSWORD`, `APP_PORT`, `NPM_REGISTRY`).
