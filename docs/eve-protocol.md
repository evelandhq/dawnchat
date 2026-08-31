# Eve protocol integration

Dawn supports Eve Agents running version 0.47.x. This window uses stream
version 24 and durable sessions addressed by ID.

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

## Ambiguous session creation

Eve persists a session's workflow before it waits for the Agent's command
hook, so a create can answer with a generic 500 — or never answer at all —
while the queued workflow still runs. Dawn treats a 5xx, a request timeout,
and a broken connection as an unknown outcome rather than proof that no
session exists. The chat is marked unconfirmed before the request leaves, so
even a handler that dies mid-flight leaves the mark behind, and it keeps its
initial message. Nothing resends that message on its own: a mount, a React
StrictMode remount, and a refresh all leave the composer closed behind an
explicit **Retry message**.

Only a refusal the Agent issued itself — any 4xx other than 401 — clears the
mark, and the chat then reads as an ordinary failed send with its composer
open again. A 401 is the Eveland challenge described in
[Authentication and identity](authentication.md); it creates nothing and
settles nothing until the Caller Token retry.

One create at a time per chat. Resolving the chat, finding it has no session,
and recording the attempt are separate reads, so the mark is written as a
conditional claim naming its holder: a request that meets a live claim is
refused with 409 rather than reaching the Agent, and only the holder named by
a claim can release it. Each attempt is abandoned after `EVE_CREATE_TIMEOUT_MS`
(45s by default, past Eve's own 30s wait), and a claim is takeable only at
twice that age — so a claim that looks stale always belongs to a handler that
is gone rather than one still working, and no attempt outlives its own claim.
The unconfirmed mark an abandoned attempt leaves behind is what keeps the chat
safe until a retry settles it.

A chat that already holds a session creates no other, whatever its status: a
turn that failed on the transport leaves the session it failed on running. Only
a session Eve's own stream reported as ended — a stored `session.failed` or
`session.completed` — may be replaced, and the create that replaces it must
name exactly that session, so a racing request cannot replace a session
neither of them examined.

Every create for one chat carries the same operation ID, derived server-side
from the chat ID and never taken from the browser. Eve answers a repeat of an
operation it already committed with that session's ID, which Dawn adopts,
persists at stream index 0, and resumes from the start of the stream. Eve
honours an operation ID only for an authenticated principal, and any Agent
credential may authenticate one — a custom header is opaque to Dawn but not to
the Agent's auth function — so every credentialed connection names its
operation. A create Eve refuses for want of a principal is retried once
without the field, since that refusal precedes any session work. Only a chat
that reaches Eve on the browser session alone sends no operation ID and has no
idempotency to fall back on, which is why a retry is always the user's
decision.

## Event persistence and projection

The proxy persists canonical Eve events with idempotency on
`(chat, session, stream index)`. Channel-local waiting capabilities are
redacted before browser delivery. The UI uses Eve's `defaultMessageReducer`
projection to render text, reasoning, tools, files, and input requests.

Transient text, reasoning, and tool-input stream deltas are not retained as
permanent history. For older databases,
[`scripts/cleanup-stream-deltas.ts`](../scripts/cleanup-stream-deltas.ts) can
remove superseded text and reasoning deltas while preserving the projected chat
response.

Human-in-the-loop state has additional proxy-side rules documented in
[Human-in-the-loop handling](human-in-the-loop.md).
