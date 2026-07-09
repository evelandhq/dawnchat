# eve-chats

Standalone chat UI for connecting to open Eve agents by remote base URL.

## Core model

```text
AgentConnection -> Chat -> Message/Event
```

The browser talks to eve-chats. eve-chats talks server-side to remote Eve agents using `eve/client` and the default Eve HTTP API.

## What this MVP includes

- Register remote Eve agents by base URL.
- Optional agent auth via bearer token or custom header, stored encrypted server-side.
- Health-check registered agents.
- Start chats bound to one healthy agent.
- Persist user messages, assistant messages, raw Eve events, and Eve session state.
- Continue existing chats using the saved Eve `sessionId`, `continuationToken`, and `streamIndex`.
- Local-first SQLite persistence for the MVP.

## Development

See [`docs/local-development.md`](docs/local-development.md).
