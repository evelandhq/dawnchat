# Architecture

Dawn is a Next.js application that sits between the browser, Eveland, Eve
Agents, and PostgreSQL.

```text
Browser
  ├── Eveland Identity: login, Realm selection, App and Caller Tokens
  └── Dawn
        ├── Eveland Agent Catalog
        ├── per-chat Eve protocol proxy ──> Eve Agent
        └── PostgreSQL
```

## Responsibilities

- **Eveland** owns provider login, the Identity Session, Realm membership, the
  Agent Catalog, and short-lived App and Caller Tokens.
- **Dawn** owns Agent connections, chat ownership, event persistence,
  browser rendering, and the same-origin Eve proxy.
- **Eve Agents** own model context, durable Eve sessions, tools, and input
  requests. Dawn does not recreate an Agent session from display history.
- **PostgreSQL** stores Agent connections, chats, canonical protocol events,
  the Eve session cursor, and the pending-input ledger.

## Domain model

```text
AgentConnection 1 ── * Chat 1 ── * EveEvent
                         │
                         ├── Eve session ID + stream index
                         └── pending-input ledger
```

An Agent connection is either:

- **managed**: lazily upserted from the Eveland Agent Catalog and keyed by
  `(Identity issuer, Project ID)`; or
- **external**: manually registered by normalized base URL, with optional
  bearer or custom-header authentication.

A chat is permanently bound to one Agent. Managed Agents that leave the
Catalog remain attached to historical chats but cannot start new turns until
they become available again.

Eve protocol events are the canonical transcript. Stream deltas are projected
for the browser but are not retained after their durable replacement arrives.
The chat row stores only the ID-addressed Eve session cursor needed to continue
the remote session.

## Application flow

1. The app checks the Eveland Identity Session. An authenticated deployment
   obtains an App Token; an open-access deployment uses the signed browser
   session instead.
2. `/` opens the most recent visible chat, or `/agents` when there is no
   history.
3. `/agents` combines the Eveland Agent Catalog with manually registered
   external Agents.
4. Selecting a Catalog Agent causes the server to re-fetch the authoritative
   Catalog entry before upserting its managed connection.
5. Sending the first message creates a local chat. The browser then talks only
   to the chat-specific same-origin Eve proxy.
6. The proxy creates or continues the remote Eve session, persists canonical
   events, updates the session cursor and pending-input ledger, and streams
   browser-safe events back to the UI.

Route pages do not query PostgreSQL directly. Browser-facing components load
their data through the application API, while API handlers and the proxy use a
shared repository layer.
