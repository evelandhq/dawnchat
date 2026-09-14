# Eve protocol integration

Dawn supports Eve Agents running version 0.49.x, 0.50.x, or 0.51.x. Version
0.49.x uses stream version 24; versions 0.50.x and 0.51.x use stream version
25. All three generations use durable sessions addressed by ID. Versions
0.48.x and earlier are not part of Dawn's tested compatibility window.

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

### Expired sessions and replacement

An Eve session on Eveland is pinned to the Deployment that created it, and
Eveland stops routing to it once its idle TTL passes (24 hours for the
Playground, 7 days for API callers such as Dawn): a follow-up then answers
`410 session_expired`. Dawn does not fail the chat. The proxy records
`expiredAt` on the stored session state and forwards the 410; the browser
remounts the thread without a session and retries the message, which reaches
the create route. Because the chat now holds an expired session, the proxy
starts a replacement Eve session and carries the earlier conversation into its
first message as a leading text part fenced by `[dawn:handoff]` /
`[/dawn:handoff]` (newest 20 turns within 12,000 characters; see
`src/eve/session-handoff.ts`). Eve keeps that part in the session's durable
history, so later turns still see it; the proxy strips it from the echoed
`message.received` before persisting or forwarding, so the transcript shows
only what the user typed. `clientContext` is not used for this because it is
one-turn context and never enters durable history.

A `409 session_not_active` that outlives the retries below is still treated as
a failure: it can also mean a session that is merely slow to activate, and a
duplicate session would silently lose the conversation.

Supported Eve generations can briefly reject a normal follow-up with
`session_not_active` while the session becomes ready. Dawn retries that message
three times with the same 250/500/1000 ms backoff as Eve's client. HITL
responses are not retried because replaying an answer can change its meaning
after Eve has begun processing it.

Every message is sent with `turnPolicy: "queue"`. This avoids Eve's supported
window default of steering, where a message arriving during a turn cancels and
replaces that turn. Stop is the deliberate interruption mechanism: Dawn
waits for the target `turn.started`, calls Eve's durable cancellation route,
and stays attached until the turn settles. Stop cancels the active turn only;
Eve 0.51 background tasks continue independently.

## Event persistence and projection

The proxy persists canonical Eve events with idempotency on
`(chat, session, stream index)`. Channel-local waiting capabilities are
redacted before browser delivery. The UI uses Eve's `defaultMessageReducer`
projection to render text, reasoning, tools, files, and input requests.

The Eve 0.51 client normalizes upstream version 24 and 25 streams to the
version 25 event shape. Dawn's same-origin proxy therefore always declares
stream version 25 to browser clients. Historical version 24 cumulative text
and reasoning snapshots are converted into equivalent version 25 deltas while
they are read; native version 25 deltas remain additive and are never collapsed.

Eve 0.51 workflow-backed tools use `workflow-tool-call` action requests. The
client reducer projects them through the same dynamic-tool UI as ordinary tool
calls, so their inputs, progress, and results remain part of the canonical
transcript.

Transient text, reasoning, and tool-input stream deltas are not retained as
permanent history. For older databases,
[`scripts/cleanup-stream-deltas.ts`](../scripts/cleanup-stream-deltas.ts) can
remove superseded text and reasoning deltas while preserving the projected chat
response.

Human-in-the-loop state has additional proxy-side rules documented in
[Human-in-the-loop handling](human-in-the-loop.md).
