# Human-in-the-loop handling

Eve can park a session on one or more batches of input requests, but it does
not expose a query for the complete set of batches on which a session is
currently parked. Dawn therefore maintains a proxy-side pending-input
ledger in `chats.pending_input_json`.

## Why the proxy owns the ledger

The per-chat proxy is the only component that observes both sides of the
protocol:

- `input.requested` events opening a batch;
- input-response POSTs accepted by Eve;
- durable `input.resolved` outcomes;
- turn cancellation and terminal session events; and
- session replacement.

The browser cannot reconstruct this state reliably from the transcript alone,
especially after another tab answers a request or a response succeeds before
that browser consumes the resulting stream event.

## Ledger rules

- Each persisted `input.requested` opens a batch keyed by its event index and,
  when available, the turn that raised it.
- Accepted answers accumulate in that batch. A dismissable question batch is
  settled by one response; required approval batches remain parked until all
  required requests have answers.
- Every request named by `input.resolved` is settled, including answers from
  another tab or channel.
- Terminal session events and session replacement clear all open batches.
- A cancelled turn clears only the batches raised by that turn. A
  `no_active_turn` response and transient failures clear nothing because the
  remote park may still exist.
- More than one batch can be open at once, including independently parked
  subagent requests.

Chats created before the ledger was introduced derive it once from stored
stream-version-23 events, using conservative-open rules, and then persist the
result.

## Browser behavior

The client seeds its state from the ledger, applies live `input.resolved`
events, closes its own accepted response optimistically, and refetches the
ledger after failures or foreign turn boundaries. Accepted local answers are
also stored as `client.input.responded`, so they remain visible even if that
tab misses the matching stream event.

The UI collects answers for every still-open request in one question batch and
sends them together. Drafts remain editable until the batch is submitted. The
composer stays available while input is pending because unrelated messages can
run as queued turns without dismissing required requests.

## Known limits

- Two tabs can submit during the short interval before a resolution reaches
  the second tab. Eve may treat the stale response as a normal user message.
- A batch whose `input.requested` event has no turn ID cannot be safely cleared
  by cancellation; it waits for resolution or a terminal session event.
- Stop must wait until Eve identifies the exact running turn, so it cannot
  cancel a park before the corresponding `turn.started` is known.

The historical root-cause analysis and compatibility audits are preserved in
[`../.plans/2026-08-10-hitl-root-cause-and-fix.md`](../.plans/2026-08-10-hitl-root-cause-and-fix.md).
