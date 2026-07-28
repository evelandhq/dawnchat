# eve-chats

Standalone chat UI with a public Eveland Agent Catalog and identity-scoped
history.

`/` opens the most recent Chat visible to the current browser/Identity scope
and falls back to `/agents` when there is no history. The public Eveland Agent
Catalog lives at `/agents`. Chat history is ordered newest first.

## Core model

```text
AgentConnection -> Chat -> Eve Event Stream
```

The browser renders Eve's `defaultMessageReducer` projection with AI Elements and talks to a same-origin, per-chat Eve protocol proxy. Eveland owns provider login, the Identity Session, and the public Agent Catalog. Opening a Catalog Agent and chatting with an Agent that does not request Eveland Identity never starts login. EveChats uses a signed, HttpOnly browser-session cookie for local anonymous chat ownership and uses an app-scoped token only when an Eveland Identity Session already exists or the user chooses an explicitly authenticated EveChats action. If the Agent responds with an Eveland authentication challenge, the browser obtains a project-scoped Caller Token and automatically retries that request. The proxy verifies App and Caller Tokens against Eveland JWKS, never infers route auth from Catalog membership, preserves configured auth for external Agents, and keeps the real continuation token server-side.

Before upserting a managed connection, the EveChats server re-fetches the
authoritative Catalog entry from Eveland. Caller Tokens carry Eveland's signed
`agent_url`, which the proxy checks before forwarding one, so browser-supplied
metadata cannot redirect a credential to another host.

## What this MVP includes

- Automatically show Eveland's routable, chat-enabled Catalog Agents.
- Lazily upsert a managed connection on click using `(Identity issuer, Project ID)` as its stable identity; endpoint changes do not create duplicates.
- Register external Eve Agents manually by base URL with optional bearer/header auth.
- Health-check registered agents.
- Start chats bound to one healthy agent.
- Stream and render text, reasoning, tool calls/results, HITL requests, authorization challenges, and files through AI Elements.
- Persist Eve events as the canonical chat history, with continuation tokens redacted and idempotent `(chat, session, stream index)` replay handling.
- Continue existing chats through `useEveAgent` while keeping remote auth and the real `continuationToken` server-side.
- Connect to Eve agents running either 0.24.x or 0.25.x.
- PostgreSQL 16 persistence for agents, chats, protocol events, and Eve session state.
- Provider-neutral Eveland login, identity-scope switching, and pre-expiry App/Caller Token refresh.
- Preserve historical chats after a managed Agent leaves the Catalog, while marking that Agent unavailable for new turns.

The former Gateway URL discovery flow and `/.well-known/eve/agents.json`
directory protocol are not supported.

## Development

See [`docs/local-development.md`](docs/local-development.md).

## Production deployment (single machine)

```bash
echo "AUTH_SECRET=$(openssl rand -base64 32)" >> .env  # once, on first deploy
docker compose -f compose.production.yaml up -d --build
```

This builds the app image, starts PostgreSQL, applies Drizzle migrations, and serves the app on port 3010. Configure `EVELAND_IDENTITY_URL`, `EVELAND_IDENTITY_ISSUER`, and an Agent-reachable `EVELAND_IDENTITY_JWKS_URL`; register the exact EveChats origin under Eveland System > Identity and add it to `EVELAND_IDENTITY_ALLOWED_ORIGINS`. `AUTH_SECRET` remains required only for decrypting any legacy Agent credentials.

When Eveland Identity and EveChats use the same hostname (such as local
`localhost` services on different ports), EveChats proxies cookie-bearing
`/identity/*` browser requests to the configured Identity origin. Provider
login and Agent-provided continuation URLs still navigate directly to Eveland.
Different hostnames retain direct Identity requests, so existing shared-site
production deployments are unchanged. Production should use one HTTPS
schemeful site (for example, `identity.example.com` and `chat.example.com`);
unrelated sites require an explicit authorization-code handoff.
