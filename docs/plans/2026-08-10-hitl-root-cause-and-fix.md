# HITL: root cause and fix

Supersedes `2026-08-10-hitl-pending-batch-model.md`. That design tried to
reconstruct Eve's pending-input state inside the browser; its review showed the
reconstruction is impossible in principle (its central invariant F1 is false).
This document restarts from the root cause and moves the decision to the one
component that can observe the truth: the per-chat proxy.

Revision 4 — final. Revision 2 incorporated the first design review (the
ledger architecture was confirmed sound; the message-only and cancel
transition rules were inverted to conservative-open, reconcile triggers were
completed, and the session-replacement and legacy-chat lifecycles were added).
Revision 3 removed the failed-marking Clear (it wiped live parks on transient
errors) and rekeyed the legacy dismissable derivation on stream position.
This revision drops `input.requested` from the derivation's activity list
(another batch's request proves nothing about an earlier one, R4). The design
review signed off on this text as written.

All Eve claims are pinned to `eve@0.31.1` and cite the file in
`node_modules/eve/dist/src/` they were read from.

## Part 1 — Root cause

### 1.1 Protocol facts

| # | Fact | Source |
|---|---|---|
| R1 | HITL is **batch-scoped**. `input.requested` carries a batch. Any turn carrying ≥1 response (or a plain message) triggers resolution of the harness's own batch; it resolves unless a *required* request (`tool-approval`, `session-limit`) is still unanswered; on resolution every unanswered request is reported to the model as `{status:"ignored"}`. | `harness/input-requests.js` (`resolvePendingInput`, `hasUnansweredRequiredRequest`, `buildToolResponsePartsForRequest`), `harness/input-request-class.js` |
| R2 | Partial answers to a required batch keep it parked; the answers are held and **concatenated** (`queueDeferredStepInput`, `coalesceInputResponses`). The turn still emits `turn.started` / `turn.completed` / `session.waiting` with **no** new `input.requested`. | `harness/input-requests.js`, `harness/messages.js`, `harness/tool-loop.js` |
| R3 | **Resolution of questions and session-limit prompts is invisible** — no stream event ever records their answers; their parts stay `approval-requested` in the durable stream forever. Approvals differ: denied/ignored ones emit `action.result` (`rejected: true`) immediately at resolution, approved ones emit it when the tool later runs. Upstream [#1095](https://github.com/vercel/eve/issues/1095). | `harness/input-requests.js`, `harness/tool-loop.js` |
| R4 | A session can be parked on **several batches over one turn window**. The harness's own batch is a single record (`PENDING_INPUT_BATCH_KEY`); subagent-proxied requests live in a *map* keyed by requestId (`eve.runtime.proxyInputRequests`); `routeDeliverPayload` splits incoming responses per child and forwards each group independently. Proxied parks emit no `turn.started` (no step input → no preamble). On 0.31.1's turn-inbox driver (`runTurnOwnedWorkflow`) an *own* batch and proxied entries cannot coexist (the parent cannot complete a step while `waitForRuntimeActionResults` blocks); the legacy driver path may allow coexistence, and nothing outside Eve can tell which kind a lone batch is either way. No rule below depends on the distinction. | `harness/proxy-input-requests.js`, `execution/subagent-hitl-proxy.js`, `execution/turn-workflow.js`, `harness/emission.js` |
| R5 | A plain message with no `inputResponses` resolves the harness's **own** all-dismissable batch (all requests ignored). It never reaches proxied child batches — `routeDeliverPayload` keeps the message in `forSelf`, and while a child is parked the parent buffers it (`waitForRuntimeActionResults` → `bufferedDeliveries`). Text that happens to match a request's options can also be *converted into* responses (`resolveTextToResponses`). | `harness/input-requests.js`, `execution/subagent-hitl-proxy.js`, `execution/turn-workflow.js` |
| R6 | The client store lies about acceptance: it projects `client.input.responded` into message parts **before** posting and never rolls back. `respond()` never rejects — transport failure surfaces via `onError`, and a local abort surfaces nowhere (`isAbortError` branch skips `onError`). | `client/eve-agent-store.js` |
| R7 | Whether Eve is waiting, and on which requests, exists **only in server-side session state** (`PENDING_INPUT_BATCH_KEY` + `proxyInputRequests`); no event and no query API exposes it. The single exception: the cancel endpoint's response says whether a turn was actually cancelled (`accepted` vs `no_active_turn`) — one bit this design exploits. | `harness/input-requests.js`, `harness/proxy-input-requests.js`, `protocol/routes.js`, `client/session-controls.js` |

### 1.2 The two reported bugs

- **Bug 1 — answering one question immediately resumed the agent.** The UI
  (like Eve's own scaffold template and its Discord/Telegram/Teams/Linear
  channels) treated the protocol as request-scoped and called `respond()` per
  click. By R1 the first response settled the whole dismissable batch; the
  second question was handed to the model as `ignored` and could never be
  answered. Eve's ACP adapter is the only in-repo consumer that batches
  correctly.
- **Bug 2 — composer permanently disabled after reload.** The composer lock was
  derived from projected part state. By R3 an answered question part looks
  `approval-requested` forever in a replay, so the lock never released.

### 1.3 Why two fix passes kept failing

Both passes tried to reconstruct R7's server-side state in the browser from the
two signals the browser has — and both signals lie:

- **Part state** lies in both directions: R3 leaves answered questions looking
  open; R6 makes unsent answers look settled.
- **The event stream** lies too: R2 emits turn boundaries without resolving
  anything; our lazy persistence can drop boundaries the browser never pulled;
  R4 puts several independent batches inside one turn window, so no
  window-based scan can group them.

Every defect the two reviews found (D1–D9, S1–S7) is a case where those lies
disagree with reality. At least one case is undecidable client-side in
principle: a turn Eve accepted whose stream broke before delivering a single
event is indistinguishable from a turn that never arrived.

The component that *can* observe the truth is our per-chat proxy
(`src/app/api/chats/eve-proxy.ts`):

1. every `input.requested` flows through its stream-persistence tap;
2. it alone sees which turn POSTs Eve accepted (the 2xx) — exactly the
   acceptance signal R6 denies the client;
3. it owns the cancel endpoint, i.e. the park-teardown path, including Eve's
   `accepted`/`no_active_turn` answer.

**Fix: record pending-input state at the proxy, keyed per batch, and serve it
to the client as authority.** The client stops inferring and starts reading.

## Part 2 — The pending-input ledger

### 2.1 Data

One new nullable column, `chats.pending_input_json` (one Drizzle migration):

```ts
type PendingInputRequestKind = "tool-approval" | "question" | "session-limit";

type PendingInputBatch = {
  /** Identity: the chat event_index of the input.requested event. */
  eventIndex: number;
  requests: { requestId: string; kind: PendingInputRequestKind }[];
  /** RequestIds Eve has accepted answers for (partial required batches). */
  answered: string[];
};

type PendingInputState = { batches: PendingInputBatch[] };
```

`batches` is a list because of R4. Identity is the `input.requested` event, not
a turn window — turn windows are meaningless under R4.

`NULL` means *legacy, not yet derived* and is distinct from an empty state
(`{"batches":[]}`); see §2.6.

**Why not fold this into `sessionStateJson`:** that blob is rebuilt wholesale
at three sites (`proxyTurnRequest`'s `nextSession`, `persistEvent`'s
`currentSession`, and every `updateChatSessionState` caller). A missed
carry-over would silently wipe the ledger — the same silent-lie failure class
this design exists to eliminate. A dedicated column has a single, explicit
writer discipline.

### 2.2 Transitions — all inside the proxy

**Open** — when the stream tap persists an `input.requested` event, add
`{eventIndex, requests, answered: []}`. Open runs **inside `appendEvent`'s own
transaction** — the one place that already holds
`pg_advisory_xact_lock(hashtext(chatId))` (`src/db/repository.ts`) — and fires
**only when the event row is newly inserted**: a replayed event (client
re-attaching from an older cursor hits the `(chatId, sessionId, streamIndex)`
unique index) must not reopen a settled batch. The insert-or-conflict outcome
is detectable inside that transaction, and the same lock means two tabs
streaming concurrently produce exactly one Open. Settle/Clear writes take the
same advisory lock so the two paths are serialized per chat.

**Settle** — in `proxyTurnRequest`, after Eve returns 2xx (where
`recordInputResponses` already runs), with `R` = the accepted
`inputResponses`:

1. For each open batch `B`: `B.answered ∪= ids(R) ∩ ids(B.requests)`.
2. Close every batch that was addressed by ≥1 response in this POST **and**
   has no unanswered required request left — a direct mirror of
   `hasUnansweredRequiredRequest`. A required batch addressed but incomplete
   stays open (matches Eve's deferral, R2); a dismissable batch addressed at
   all closes (R1). A batch not addressed at all stays open — correct for both
   an own batch (Eve leaves it `unresolved`) and a proxied one (responses route
   to another child).
3. A message-only POST (`R` empty) **closes nothing.** Eve does dismiss an
   *own* all-dismissable batch on a plain message (R5), but a lone open batch
   is just as likely a proxied one — their `input.requested` events are not
   reliably distinguishable (turnIds differ but can collide) — and closing a
   proxied batch here would permanently strand the child's question: the
   message is buffered until the child completes, which then never happens.
   The ledger errs conservative-open; the cost is bounded (§2.7 first bullet),
   the alternative is unbounded.

**Clear** —
- the cancel endpoint completes with Eve reporting `status: "accepted"` →
  clear all batches. Eve's `settleCancelledTurnStep` clears `proxyInputRequests`
  unconditionally and the own batch's session-limit form
  (`clearPendingSessionLimitPrompt`); a non-session-limit own batch only exists
  between turns, where cancel is a no-op. So: `accepted` ⇒ Eve's parks are
  gone. **`no_active_turn` (and any error, and the 502 fallback for 0.29/0.30
  agents without a cancel route) clears nothing** — Eve's batch survived, and
  clearing the ledger anyway would recreate the silent-deferral hang this
  design exists to prevent. This is a behavioral change to
  `proxyCancelEveTurn`: it must parse Eve's cancel result instead of
  discarding it.
- the stream tap persists `turn.cancelled` (a cancel we didn't issue) → clear
  all. Note the converse does not hold: when an `accepted` cancel tears down a
  proxied park, Eve suppresses the `turn.cancelled` emission
  (`settleCancelledTurnStep`'s between-turns branch), so the endpoint-response
  clear above is the *only* trigger for that case.
- the stream tap persists `session.completed` or `session.failed` → clear all.
- `proxyTurnRequest` adopts a `resolvedSessionId` different from the current
  session (`isContinuing === false`) → clear all before recording the new
  session. Batches belong to a session; none survive its replacement.

The proxy paths that mark the chat `failed` (Eve unreachable, non-401 error,
bad payload) deliberately do **not** clear. A transient 5xx on a `respond()`
POST leaves the Eve session and its park fully alive, and the chat remains
continuable on the same session — the next successful event flips it back to
`active`. Clearing there would erase a live park on a network blip and turn it
into the silent-deferral hang (R2). The residual — a *permanently* dead agent
leaves a stale required batch locking a failed chat's composer — is accepted:
that chat is unusable regardless, and recreating its session fires the
replacement clear above.

**Recovery** — if the browser died before pulling an `input.requested`, no
ledger entry exists, but nothing is lost: on the next load the store
re-attaches from the stored `streamIndex` (`sessions.attach` via
`initialSession`), the proxy persists the missed event then, and the ledger
opens (assumption A2, §2.8).

### 2.3 Serving it

- The chat payload (`getChatWithEvents`, fetched client-side by
  `authenticated-chat-thread.tsx`) gains `pendingInput`; the client treats it
  as the authoritative initial state. This alone fixes Bug 2: a reloaded chat
  with no open batch gets an enabled composer, regardless of what part states
  claim.
- A small `GET .../pending-input` route (auth via `resolveProxyContext`, like
  its siblings) returns the current state for reconciliation.

**Reconcile triggers.** The client view is: initial ledger + live
`input.requested` events + optimistic closes on `respond()`. It refetches
`pending-input` and replaces the local view:

- in `onError` (transport failure, Eve 4xx/5xx, stream broke after 2xx — the
  previously undecidable case is decided by whichever state the ledger
  recorded at the 2xx boundary);
- in `onFinish` (covers `stop()`/abort, which by R6 produce **no** `onError`);
- after the cancel POST resolves (whatever its outcome);
- on receiving `turn.started` or `turn.cancelled` while the local view holds
  an open batch — the signature of another tab having acted.

S2 (answering a batch Eve already settled) is thereby **narrowed to the race
window between another actor's settle and the next reconcile trigger**, not
eliminated; inside that window a click degrades to Eve's stale-response
conversion (`convertStaleResponsesToUserMessage` runs before
`resolvePendingInput` in `tool-loop.js`). After any reconcile, a settled batch
offers no controls.

### 2.4 Client rules — what replaces the scan

`pending` = the unanswered requests of open batches, **per batch**.

- **Submit (Bug 1 fix, retained):** drafts are held per batch; a batch is sent
  when every *unanswered* request in that batch has a draft, and the payload is
  exactly that batch's answers. No cross-batch union — a stale batch can never
  block a live one, and R4's concurrent batches are each independently
  answerable.
- **Drafts survive failure:** drafts are keyed by requestId and are dropped
  only when their batch is no longer open in the reconciled view. A `respond()`
  that never reached Eve therefore reopens the batch (refetch) with every
  answer still in place. This includes the 401 → re-auth → remount path: the
  remounted session seeds from the captured state and refetches
  `pending-input` on mount, so no send path depends on in-flight bookkeeping.
- **Composer:** disabled iff some open batch has an unanswered *required*
  request. A dismissable-only park leaves the composer enabled; sending a
  plain message is Eve's own "dismiss" gesture for an own batch (R5). The
  ledger deliberately does not record that dismissal (settle rule 3), and
  reconciliation cannot remove what the ledger still holds open: the displayed
  controls linger until the batch is addressed by a later click (which Eve
  stale-converts, closing it) or a Clear transition fires — see §2.7.
- **Display:** unanswered request of an open batch → Awaiting Approval, with
  controls and the drafted option highlighted. RequestId in `answered` or in a
  stored `client.input.responded` → Responded, showing the stored answer.
  Otherwise, a part still `approval-requested` → Dismissed.
- **Freeform text commits on blur** as well as Enter/Continue.

Deleted outright: `unresolvedInputRequestIds` (the backwards event scan), the
draft in-flight register/discard/restore lifecycle, `submittedDraftsRef`, and
every turn-window heuristic.

### 2.5 How the known defects fall out

| Prior finding | Outcome |
|---|---|
| D1 retry path loses drafts | Gone — no in-flight registry to miss; errors refetch, drafts persist until the batch is confirmed closed (§2.4). |
| D2 accepted-vs-failed ambiguity | Gone — acceptance is recorded at the 2xx, server-side; every failure path ends in a refetch of that record. |
| D3 `session-limit` not treated as required | Kinds are stored in the ledger from the event; one `isRequiredKind` helper mirrors R1. |
| D4 cross-batch union blocks sends | Gone by construction — per-batch state, per-batch submit. |
| D5 freeform edits dropped | Blur commit. |
| D6 two-tab race | Narrowed: pending-correctness no longer depends on event persistence order (settle happens at POST time), and cross-tab settles reconcile at the next trigger (§2.3). A stale tab can still act inside the race window — degrades to Eve's stale-response conversion, then self-corrects at reconcile. Stored display-record ordering remains a display-only residue. |
| D7 duplicate stored responses | `answered` is a set keyed by requestId; duplicate POSTs are idempotent. |
| D8 `stop()` skips restore | Gone — the client keeps no state that needs restoring; cancel clears the ledger only when Eve confirms `accepted` (a `no_active_turn` cancel leaves batch, controls, and composer lock exactly as they were), and `onFinish` reconciles the abort itself. |
| D9 scan cost claim | The scan itself is deleted. |
| S1 multiple concurrent batches | Modeled directly (R4); each batch independently answerable. |
| S2 answering a dead batch | Narrowed to the reconcile race window (§2.3), with bounded degradation instead of a hang; not fully eliminated — that needs upstream [#1095](https://github.com/vercel/eve/issues/1095). |

### 2.6 Legacy chats — deriving the first ledger

Existing chats have `pending_input_json = NULL`. On first proxy/load touch,
derive an initial state from the stored events, then persist it:

- Consider only `input.requested` events belonging to the **current**
  `sessionState.sessionId` (legacy data can hold a replaced session's requests
  with no terminal boundary; a dead session's batch must not derive open) and
  after the last stored `session.completed` / `session.failed` /
  `turn.cancelled`. Nothing derives open if the chat is not `active`.
- A request counts as **answered** if a stored `client.input.responded` covers
  it **or** (approvals) a stored `action.result` references its action — R3's
  immediate `rejected` emission makes denied/ignored approvals visible even in
  legacy data.
- A batch with an unanswered *required* request derives **open**. Later stored
  turn activity does not settle it — R2's re-parks emit boundaries without
  resolving anything.
- An all-dismissable batch derives **closed** when any of its requests is
  answered or when *later stored turn activity* follows it
  (`message.received` / `turn.started` — **not** `input.requested`: proxied
  parks stack inside one window without boundaries (R4), so another batch's
  request proves nothing about this one). A dismissable batch at the stream
  tail, or followed only by other `input.requested` events, derives **open**:
  it may be a genuinely parked own batch *or a proxied one*, and deriving a
  proxied park closed would strand the subagent permanently (R5 — a plain
  message is buffered, never dismissing it). One accepted residue: a
  legacy-driver session can run a parent turn mid-proxied-park, so a stored
  `turn.started` there can wrongly close a parked proxied batch — tolerable
  for a one-shot derivation.

Each rule picks the recoverable error direction. A settled batch wrongly
derived open re-offers controls; re-answering degrades to Eve's
stale-response conversion, closing it. A genuinely parked required batch
wrongly derived closed would instead produce the unrecoverable
silent-deferral hang (R2), and a parked proxied batch wrongly derived closed
would strand its child — both are the failure directions the rules avoid.
Wrongly-open costs lingering controls (the §2.7 residue, since open
dismissable batches never lock the composer); wrongly-closed costs the chat.
New chats initialize to the empty state at creation.

### 2.7 Deliberately not covered

- **Message-dismissed own batches keep their controls** (settle rule 3): after
  a plain message dismisses an own all-dismissable batch server-side, the
  ledger still shows it open. Cost: stale controls on screen; a later click
  sends answers Eve converts to a synthetic user message, after which the
  batch is addressed and closes. Chosen over the converse failure — closing a
  proxied batch a message did *not* dismiss would strand the subagent's
  question permanently. An upstream event for park teardown (part of
  [#1095](https://github.com/vercel/eve/issues/1095)) is the real fix.
- **A cancel racing park emission**: a cancel accepted in the window between
  Eve emitting `input.requested` and finishing the turn workflow can leave a
  just-set own batch alive after the ledger cleared (this race also emits
  `turn.cancelled`, so the stream trigger fires the same clear). A dismissable
  survivor recovers — the next message dismisses it server-side (R5). A
  *required* survivor does not: with the ledger cleared there are no controls
  to answer it and every message is silently deferred (R2). Accepted as an
  ultra-narrow residual; recovery is session replacement.
- **Foreign cancels** that bypass `proxyCancelEveTurn` during a proxied park:
  Eve suppresses `turn.cancelled` there, so neither Clear trigger fires.
  Unmodeled; requires a second client talking to Eve directly.
- **Ledger write failure after Eve's 2xx**: logged loudly; the batch re-offers
  and a re-answer degrades to Eve's stale-response handling. Same narrow
  window `recordInputResponses` already accepts.
- **Text-matched answers show as Dismissed**: a batch Eve resolved via
  `resolveTextToResponses` (the message text matched an option) recorded no
  `client.input.responded`, so its requests render Dismissed although Eve
  stored answers. Cosmetic; noted so it is not re-reported as a bug.
- Upstream gaps remain upstream: [#1095](https://github.com/vercel/eve/issues/1095)
  (durable `input.responded`), [#1578](https://github.com/vercel/eve/pull/1578)
  (contract only, no runtime change yet), [#1507](https://github.com/vercel/eve/issues/1507).
- `retrySentRef` never re-arming (pre-existing on `main`).

### 2.8 Assumptions to verify during development

- **A2** — a reloaded client re-attaches the stream from the stored cursor and
  a missed `input.requested` is re-delivered. Mechanism confirmed in dist
  (`sessions.attach` with `initialSession.streamIndex`; the stored cursor is
  the persistence high-water mark). Remaining end-to-end check: the Eve
  *server* serves its durable stream from an arbitrary `startIndex` on both
  0.31 and 0.29/0.30 agents.
- **A3** — every `input.requested` reaches the browser only through
  `proxyEveSessionStream`'s tap. Confirmed for the current routes (turn POST
  responses are JSON-only in all supported generations). Any future proxied
  route — `reset` in particular, which mints a new sessionId — must revisit
  both A3 and the session-replacement Clear.

(The former A1 — what cancel actually clears — was resolved during review and
is folded into §2.2's Clear rules.)

### 2.9 Changes by file

| File | Change |
|---|---|
| `src/db/schema.ts` + migration | `chats.pending_input_json` (nullable; NULL = legacy) |
| `src/db/repository.ts` | `appendEvent` gains an in-transaction Open hook (insert-or-conflict outcome exposed); `readPendingInput` / `updatePendingInput(chatId, fn)` under the same advisory lock |
| `src/eve/proxy-contract.ts` | `PendingInputState` types, parse/serialize, rule helpers (`isRequiredKind`, `applyResponses`, `clearReason`), legacy derivation |
| `src/app/api/chats/eve-proxy.ts` | Open on persist; settle on 2xx; Clear on accepted-cancel / `turn.cancelled` / terminal events / session replacement; `proxyCancelEveTurn` parses Eve's cancel result |
| chat payload route + new `pending-input` route | Serve the ledger (auth via `resolveProxyContext`) |
| `src/components/authenticated-chat-thread.tsx` | `ChatPayload` carries `pendingInput`; remount state threads it |
| `src/components/chat-thread.tsx` | Delete the scan and draft-lifecycle machinery; pending from ledger + live events; per-batch submit; reconcile triggers; composer rule |
| `src/components/eve-message.tsx` | Display from ledger + stored responses; blur commit |
| `tests/eve-proxy.test.ts` | Ledger transitions: open, replay no-reopen, partial required across POSTs, close, message-only no-close, cancel accepted vs `no_active_turn`, terminal, failed-marking does *not* clear, session replacement, idempotent duplicates, legacy derivation (incl. session scoping and tail-vs-followed dismissable) |
| `tests/chat-ui.test.tsx` | Per-batch submit, composer rule, reload authority, refetch reconciliation (error / finish / cancel / foreign `turn.started`), draft survival |
| `README.md` | Rewrite the HITL-gaps section around the ledger |

### 2.10 Version risk

The rules mirror Eve internals that are not public contract — wider than the
three obvious functions: `resolvePendingInput` + `hasUnansweredRequiredRequest`
(settle), `routeDeliverPayload` and `waitForRuntimeActionResults`' message
buffering (rule 3's rationale), `convertStaleResponsesToUserMessage` and its
ordering before `resolvePendingInput` (the degradation path),
`coalesceInputResponses`' concatenation (partial-required accumulation), and
the cancel chain (`waitForNextSessionAction`'s cancel skip,
`settleCancelledTurnStep`'s selective clears, `CancelTurnResponseSchema`). All
of it is read from 0.31.1; the proxy also serves 0.29/0.30 agents, whose HITL
internals were not audited — the rules err conservative-open, so a semantic
difference there degrades to lingering controls rather than a lost park. The
proxy tests pin each mirrored behaviour, so an Eve upgrade that changes them
turns tests red instead of shipping a silent mislabel — the failure mode of
the previous two passes.

### 2.11 Addendum — re-audited against Eve 0.32 and 0.33

Eveland's support window moved to 0.31.x/0.32.x/0.33.x, and 0.33 rewrote the
harness internals §2.10 mirrors: pending input became an ordered collection of
batches (`harness/pending-input-batches.js`) resolved by
`resolveApprovalInputBatches` / `resolveQuestionOnlyInputBatches` /
`resolveSessionLimitInput` instead of a single `resolvePendingInput`. Re-read
against 0.33.2:

- **Settle rules survive.** A question batch still resolves on any one answer,
  with the rest reaching the model as `{ status: "ignored" }`
  (`findAnsweredQuestionBatches`); an approval batch still resolves only once
  every approval request in it is answered, and leftover answers are carried
  forward as deferred input rather than dropped. §2.1's `answered` accumulation
  and the required-open rule are unchanged.
- **No new signal.** 0.33.2 emits the same stream event types as 0.31, so
  nothing replaces the ledger and #1095 remains the blocking upstream gap.
- **`turn.cancelled` is no longer a teardown signal by itself.** From 0.33 a
  message sent while a turn runs steers by default: Eve cancels that turn,
  emits `turn.cancelled` + `session.waiting`, and starts the replacement under
  a new turn ID — while batches parked by *earlier* turns stay open and
  answerable. §2.2's blanket clear would have hidden live approval controls, so
  a batch now records the `turnId` from its `input.requested` and a cancel
  clears only that turn's batches. A batch with no recorded turn (stored before
  this change, or an event without one) is kept: conservative-open, as
  everywhere else. The Stop button names the turn it stopped so the cancel
  route can apply the same scoping, since the browser drops its stream before
  cancelling and the tap may never see the event.
- **Deferral is gone upstream, so the composer lock is version-gated.** 0.32
  stopped holding ordinary messages behind an open authorization challenge and
  0.33.1 behind an open tool approval (both now run as their own turn, with a
  later structured answer still resolving the original call). §2.4's lock is
  the local workaround for that deferral and now applies only to Agents below
  0.32, read from `session.started`'s `runtime.eveVersion`; an unknown version
  keeps the lock.
- **Sends ask for `turnPolicy: "queue"`** so steering never applies to this
  chat's own turns. Agents before 0.33 parse request fields individually and
  ignore the key.

§2.10's bet only half held. The settle rules are pinned by tests, so a change
there would have gone red — but the steering change would not have: the fake
Agent replays scripted events and never steers, so the whole suite stayed green
on 0.33.2 and only a re-read of the changelog and harness found it. Behaviour
that lives in Eve's session driver rather than in a response the proxy parses
needs a scripted stream to pin it, which is what
`tests/eve-proxy.test.ts`'s steer case now does.

### 2.12 Addendum — re-audited against Eve 0.38 and 0.39

Eveland's support window moved to 0.38.x/0.39.x. On the wire that is stream
version 22 and agent-info schema v2, both bumped in 0.35; routes and session
addressing are unchanged, and Eve's client parses stream events without a
version gate, so sessions opened against 0.29–0.33 agents continue exactly as
before. Re-read against 0.39.0:

- **Settle rules survive again.** `resolveApprovalInputBatches` /
  `resolveQuestionOnlyInputBatches` and `classifyInputRequest` carry the same
  two rules; §2.1's `answered` accumulation and required-open rule stand.
- **A first durable settlement signal exists.** 0.35 added
  `approval.candidate`/`approval.settled` (`harness/approval-candidates`).
  `approval.settled` is emitted when an *authenticated* responder resolves a
  tool approval — `settleDirectApprovalResponse` runs only when the answer
  carries a session auth context, so an anonymous answer still emits nothing,
  and question batches never emit anything. The tap now feeds the named
  request through `settleAnsweredRequests`, and the legacy derivation counts
  the stored event as answered; a settle on a legacy `NULL` chat leaves the
  marker so derivation still runs. #1095 remains the gap for everything else.
- **The re-park emits its batch again.** From 0.35 a model step that requests
  an approval and a subagent call in the same response parks on both: the
  approval surfaces immediately, and when the delegation result arrives the
  turn re-parks on the still-pending approval, emitting `input.requested`
  again with the same request IDs. The ledger holds each copy as its own
  batch; one answer settles every copy (`settleAnsweredRequests` closes all
  batches containing the answered request), and the client keys rendered
  batches by first request ID so duplicates never stack on screen.
- **Stop is Eve's own cancel now.** 0.38 replaced the frontend binding's
  local-abort `stop()` with `cancel()`: `MessageResponse.cancel()` waits for
  the in-flight turn's `turn.started`, POSTs `{ turnId }` to the session
  cancel route — this app's per-chat proxy, which applies §2.11's turn-scoped
  ledger clear — and keeps the stream attached until the turn settles, so the
  tap also sees the `turn.cancelled`. The hand-rolled cancel fetch and the
  history-seeded turn naming are deleted, and with them the residue of an
  unattributable Stop clearing every park: a cancel can no longer be accepted
  before the turn it tears down is named.
- **Steer is still the default** (`DEFAULT_TURN_POLICY = "steer"` in 0.39.0);
  sends keep asking for `"queue"`.

The compile cost of the upgrade was one line — `stop()` no longer exists —
which is what §2.11 predicted for behaviour that lives in the client binding
rather than the wire. The behaviour that would *not* have turned tests red is
again the part found only by reading: `approval.settled`'s
authenticated-responder precondition, and the re-park's duplicate
`input.requested`. Both are now pinned by scripted streams in
`tests/eve-proxy.test.ts` and `tests/pending-input.test.ts`.

### 2.13 Addendum — re-audited against Eve 0.42 through 0.44

Eveland's support window is now 0.42.x–0.44.x. These releases share stream
version 23, the same routes, ID-addressed sessions, the `"steer"` default, and
the resolution rules above. The material protocol change arrived in 0.39.1:
`input.resolved` now records every server-accepted terminal HITL outcome and
includes the response when one exists.

EveChats consumes that event in all three places that need it: the proxy's live
pending-input transition, the one-shot derivation for chats predating the
ledger, and the browser's live pending controls. `client.input.responded` still
records acceptance before the matching stream event is necessarily read. The
fake Agent models only 0.42, 0.43, and 0.44 as stream version 23; old
continuation-token sessions and pre-v23 settlement events are no longer
supported.
