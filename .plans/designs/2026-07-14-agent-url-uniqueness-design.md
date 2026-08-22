# Agent URL Uniqueness Design

Status: **Implemented.**
Status checked: 2026-08-22.

## Goal

Prevent more than one agent connection from being registered for the same normalized agent URL.

## Uniqueness Rule

`agent_connections.base_url` is the uniqueness key. The existing `normalizeAgentBaseUrl` function canonicalizes submitted URLs before persistence by trimming whitespace, accepting only HTTP(S), rejecting embedded credentials, removing query strings and fragments, and removing trailing slashes.

Consequently, URLs such as `https://agent.example.com`, `https://agent.example.com/`, and `https://agent.example.com?source=gateway` identify the same agent. Agent name, authentication type, and authentication credentials do not affect uniqueness.

## Storage Enforcement

Add a unique index on `agent_connections.base_url` in the Drizzle schema and generate a PostgreSQL migration for it. The database constraint is the source of truth so concurrent requests cannot create duplicate records.

The migration must not delete or merge existing duplicate rows because either action could silently discard authentication settings or cascade-delete associated chats. If duplicates already exist, migration failure intentionally requires an operator to resolve them before retrying.

## API Behavior

When `POST /api/agents` attempts to insert a duplicate normalized URL, return:

- HTTP status: `409 Conflict`
- JSON body: `{ "error": "Agent URL already registered" }`

The duplicate attempt must not run an Eve health or info check. Other database failures continue to return the existing generic `500` response.

The implementation should identify the named agent URL constraint rather than treating every PostgreSQL uniqueness error as an agent URL conflict.

## User Interface

When the manual agent connection form receives the duplicate URL response, show:

`An agent with this URL is already registered.`

Other unsuccessful responses keep the existing generic registration error. Gateway discovery already marks normalized URLs that are present in storage as connected; its behavior remains unchanged.

## Testing

- Repository/schema test: inserting two agent connections with the same `baseUrl` rejects the second insert and leaves one record.
- API test: submitting equivalent normalized forms of a URL returns `409`, returns the documented error body, stores one agent, and performs no second health check.
- UI test: the manual form displays the duplicate-specific message for a `409` response and does not navigate.
- Regression verification: run the focused tests, the full test suite, typechecking, and the production build.

## Scope

This change does not add update, merge, or deletion behavior for agent connections. It does not alter URL normalization rules or gateway discovery behavior.
