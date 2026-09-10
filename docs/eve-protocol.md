# Eve protocol integration

Dawn uses Eve's **0.52.5** client and requires Agent deployments running
**Eve 0.52.3 or newer**, with protocol regression fixtures covering 0.52.3
and 0.52.5. Both use stream version 25 and durable sessions addressed by ID.
Older stored transcripts,
including version 24 snapshots, remain readable; that does not make an older
live deployment compatible with the current client.

Eveland's platform support window is broader than its Playground or Dawn chat
support. An accepted deployment on 0.50.x, 0.51.x, or 0.52.0–0.52.2 must be
rebuilt with a current Eve version before continuing chats with this client.

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

Eve can briefly reject a normal follow-up with
`session_not_active` while the session becomes ready. Dawn retries that message
three times with the same 250/500/1000 ms backoff as Eve's client. HITL
responses are not retried because replaying an answer can change its meaning
after Eve has begun processing it.

Ordinary messages use `turnPolicy: "queue"`. A queued message's **Steer** action
explicitly selects `turnPolicy: "steer"`, cancelling and replacing the active
turn. Stop is the other deliberate interruption mechanism: Dawn
waits for the target `turn.started`, calls Eve's durable cancellation route,
and stays attached until the turn settles. Stop cancels the active turn only;
Eve background tasks continue independently.

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
refused with 409 rather than reaching the Agent. Each attempt is abandoned
after `EVE_CREATE_TIMEOUT_MS` (45s by default, past Eve's own 30s wait), and
the claim it takes runs for twice that — a deadline the claimant writes and a
contender only reads, both by the database's clock. Neither an instance
configured for longer attempts nor a skewed clock can therefore make one
process judge another's claim over: a claim that has expired always belongs to
a handler that is gone, and no attempt outlives its own claim.

The claim is also a fence, because a deadline alone cannot stop a process that
resumes after one. Every write a create ends with names the token — the
session it committed, the failed status it records, the clearing of the mark
on a refusal — so a handler whose claim was taken over stores nothing and
answers 409 rather than overwriting the request that replaced it, and cannot
leave a successor's session reading as failed. Its own session is not lost:
the next create for that chat names the same operation and Eve answers with
it. Continuations hold no claim and never touch these columns. The unconfirmed
mark an abandoned attempt leaves behind is what keeps the chat safe until a
retry settles it.

A browser refused with 409 waits rather than retrying into the conflict. Its
composer stays closed with no retry offered while the chat reports a create in
progress, and it re-reads the chat until that claim is gone — the winner
persists its session partway through its own attempt, and nothing tells the
loser when. Whether a claim is still live is decided in the database on every
read, never by comparing the stored deadline to an app server's clock, so a
reader and a takeover cannot disagree about the same row. A re-read that
brings back a session this view never had remounts the Eve store on it, since
the store reads its session once, at mount. The new store seeds its history
and pending input from that same server snapshot. A Caller Token acquired
earlier stays usable, but the old authentication retry and its captured
events belong to the previous snapshot: adopting the winner must not resend
the initial message as a continuation.

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

The client normalizes historical version 24 streams to the version 25 event
shape. Dawn's same-origin proxy declares stream version 25 to browser clients.
Historical version 24 cumulative text and reasoning snapshots are converted to
equivalent version 25 deltas while read; native version 25 deltas remain additive.
Workflow-backed tools continue to project through the dynamic-tool UI.

### Delivery identity and deployment upgrades

A continuation carrying a message must return a non-empty `deliveryId`. The
client matches it against stream events' `meta.deliveryIds`, skipping older or
unrelated turns even when the saved cursor is behind. The proxy preserves both
the acknowledgment and event metadata, including through waiting-token redaction
and persistence. Initial session creation and input-only replies do not require
a delivery ID in their response.

If a continuation is accepted without a delivery ID, the proxy first retains the
session association and clears any accepted pending message, then returns
`409 unsupported_eve_version` with `accepted: true`. The UI explains that the
message may still be running and disables further submissions in that mounted
chat. Do not resend the message: this is an accepted operation with an
incompatible response, not a rejected operation. The check is based on the actual
response; health checks establish reachability, not chat compatibility.

Upgrade and rebuild the Agent deployment, then start a new chat. Existing
sessions may remain pinned to an older deployment even after the project's
Stable route changes. Reading their local history remains supported; Dawn does
not reconstruct or migrate their remote model context.

Dawn seeds the UI from locally persisted events and does not currently invoke
Eve's explicit `resume()` / bounded snapshot API. Before adding that API, the
proxy must handle `includeTailIndex` and `x-eve-stream-tail-index`; it currently
provides the live stream path only.

Transient text, reasoning, and tool-input stream deltas are not retained as
permanent history. For older databases,
[`scripts/cleanup-stream-deltas.ts`](../scripts/cleanup-stream-deltas.ts) can
remove superseded text and reasoning deltas while preserving the projected chat
response.

Human-in-the-loop state has additional proxy-side rules documented in
[Human-in-the-loop handling](human-in-the-loop.md).
