# eve-chats

Standalone authenticated chat UI for Eveland-managed Eve agents.

## Core model

```text
AgentConnection -> Chat -> Eve Event Stream
```

The browser renders Eve's `defaultMessageReducer` projection with AI Elements and talks to a same-origin, per-chat Eve protocol proxy. Eveland owns provider login and the Identity Session. This app keeps only a short-lived, project-bound Caller Token in browser memory; the proxy verifies it against Eveland JWKS, enforces chat owner/Realm/project isolation, forwards that same token as Agent `Authorization`, and keeps the real continuation token server-side.

## What this MVP includes

- Register remote Eve agents by base URL.
- Register the non-secret Eveland Project ID for each managed Agent. Legacy bearer/header auth cannot be combined with that identity.
- Health-check registered agents.
- Start chats bound to one healthy agent.
- Stream and render text, reasoning, tool calls/results, HITL requests, authorization challenges, and files through AI Elements.
- Persist Eve events as the canonical chat history, with continuation tokens redacted and idempotent `(chat, session, stream index)` replay handling.
- Continue existing chats through `useEveAgent` while keeping remote auth and the real `continuationToken` server-side.
- Connect to Eve agents running either 0.24.x or 0.25.x.
- PostgreSQL 16 persistence for agents, chats, protocol events, and Eve session state.
- Provider-neutral Eveland login, explicit 403 scope-denial UI, identity-scope switching, and pre-expiry Caller Token refresh.

## Development

See [`docs/local-development.md`](docs/local-development.md).

## Production deployment (single machine)

```bash
echo "AUTH_SECRET=$(openssl rand -base64 32)" >> .env  # once, on first deploy
docker compose -f compose.production.yaml up -d --build
```

This builds the app image, starts PostgreSQL, applies Drizzle migrations, and serves the app on port 3010. Configure `EVELAND_IDENTITY_URL`, `EVELAND_IDENTITY_ISSUER`, and an Agent-reachable `EVELAND_IDENTITY_JWKS_URL`; register the exact EveChats origin under Eveland System > Identity and add it to `EVELAND_IDENTITY_ALLOWED_ORIGINS`. `AUTH_SECRET` remains required only for decrypting any legacy Agent credentials.

Eveland Identity and EveChats must use the same schemeful site (for example,
`identity.example.com` and `chat.example.com`, both over HTTPS). The
`eveland_identity` cookie is intentionally `SameSite=Lax`; exact CORS origin
configuration does not make that cookie available across unrelated sites.
