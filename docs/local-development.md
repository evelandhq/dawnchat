# Local Development

## Requirements

- Node >=24
- pnpm via Corepack

## Setup

```sh
corepack pnpm install
cp .env.example .env.local
# Edit .env.local and replace AUTH_SECRET=replace-with-local-dev-secret with a real local secret.
corepack pnpm db:migrate
corepack pnpm dev
```

Open http://localhost:3010.

## Tests and verification

```sh
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
```

## Connecting an Eve Agent

A local Eve Agent connection must expose the Eve HTTP routes under its configured base URL:

- `GET /eve/v1/health`
- `GET /eve/v1/info`
- `POST /eve/v1/session`
- `POST /eve/v1/session/:sessionId`
- `GET /eve/v1/session/:sessionId/stream`

Register that base URL in the app, then create a chat against the registered agent. A chat turn creates or continues an Eve session, consumes the stream, persists user/assistant messages, and stores the session state (`sessionId`, `continuationToken`, and `streamIndex`) for follow-up messages.
