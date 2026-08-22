# Eve protocol integration

Dawn supports Eve Agents running versions 0.42.x through 0.44.x. This
window uses stream version 23, the same HTTP route family, and durable sessions
addressed by ID.

## Agent requirements

An Agent connection must expose the standard Eve HTTP API below its configured
base URL, including:

- `GET /eve/v1/health`
- `GET /eve/v1/info`
- `POST /eve/v1/session`
- continuation, streaming, input-response, and cancellation routes below
  `/eve/v1/session/:sessionId`

Eveland-managed Agents come from the Identity Catalog. The manual registration
form is for external Agents and supports no authentication, bearer
authentication, or a custom header.

## Session and stream flow

Each chat has a same-origin proxy rooted at
`/api/chats/:chatId/agent/eve/v1/session`. The proxy resolves the chat and Agent
server-side, applies only the authorized credential for that connection, and
forwards the Eve request. Browser callers never choose an arbitrary upstream
URL for an existing chat.

The first turn creates a durable Eve session. Later turns continue it using the
stored `sessionId` and `streamIndex`; obsolete stored tokens are ignored. If the
remote durable session is deleted, locally persisted display events do not
reconstruct its model context.

Every message is sent with `turnPolicy: "queue"`. This avoids Eve's supported
window default of steering, where a message arriving during a turn cancels and
replaces that turn. Stop is the deliberate interruption mechanism: Dawn
waits for the target `turn.started`, calls Eve's durable cancellation route,
and stays attached until the turn settles.

## Event persistence and projection

The proxy persists canonical Eve events with idempotency on
`(chat, session, stream index)`. Channel-local waiting capabilities are
redacted before browser delivery. The UI uses Eve's `defaultMessageReducer`
projection to render text, reasoning, tools, files, and input requests.

Transient stream deltas are not retained as permanent history. For older
databases, [`scripts/cleanup-stream-deltas.ts`](../scripts/cleanup-stream-deltas.ts)
can remove superseded deltas while preserving the projected chat response.

Human-in-the-loop state has additional proxy-side rules documented in
[Human-in-the-loop handling](human-in-the-loop.md).
