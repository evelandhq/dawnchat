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
