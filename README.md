# eve-chats

Standalone chat UI with the Eveland Agent Catalog and identity-scoped
history. Using the app requires an Eveland Identity Session.

`/` opens the most recent Chat visible to the current browser/Identity scope
and falls back to `/agents` when there is no history. The public Eveland Agent
Catalog lives at `/agents`. Chat history is ordered newest first.

## Core model

```text
AgentConnection -> Chat -> Eve Event Stream
```

The browser renders Eve's `defaultMessageReducer` projection with AI Elements and talks to a same-origin, per-chat Eve protocol proxy. Eveland owns provider login, the Identity Session, and the Agent Catalog. Opening any EveChats page requires an Eveland Identity Session: an app-level gate redirects unauthenticated visitors to Eveland login and returns them to the page they opened, so the sidebar lists the identity's chat history — across every Agent, from any browser — without entering an Agent first. The gate is a UI policy only; it changes nothing about Agent credentials. Chatting with an Agent that does not request Eveland Identity still sends that Agent no Eveland token, and externally registered Agents keep their configured auth. If the Agent responds with an Eveland authentication challenge, the browser obtains a project-scoped Caller Token and automatically retries that request. The proxy verifies App and Caller Tokens against Eveland JWKS, never infers route auth from Catalog membership, and keeps the real continuation token server-side.

EveChats still sets a signed, HttpOnly browser-session cookie. Chats created before the login requirement existed are owned only by that cookie; on the first authenticated load the browser calls `POST /api/chats/claim`, which adopts this browser's identity-less chats into the signed-in identity so they follow the user to other devices. Claiming is idempotent and never re-owns a chat that already belongs to an identity.

Before upserting a managed connection, the EveChats server re-fetches the
authoritative Catalog entry from Eveland. Caller Tokens carry Eveland's signed
`agent_url`, which the proxy checks before forwarding one, so browser-supplied
metadata cannot redirect a credential to another host.

## What this MVP includes

- Automatically show Eveland's routable, chat-enabled Catalog Agents.
- Lazily upsert a managed connection on click using `(Identity issuer, Project ID)` as its stable identity; endpoint changes do not create duplicates.
- Register external Eve Agents manually by base URL with optional bearer/header auth.
- Health-check registered agents.
- Start chats bound to one healthy agent.
- Stream and render text, reasoning, tool calls/results, HITL requests, authorization challenges, and files through AI Elements.
- Persist Eve events as the canonical chat history, with continuation tokens redacted and idempotent `(chat, session, stream index)` replay handling.
- Continue existing chats through `useEveAgent` while keeping remote auth and the real `continuationToken` server-side.
- Connect to Eve agents running 0.38.x or 0.39.x — the same support window
  Eveland hosts. Both are identical on the wire: stream version 22 (bumped in
  0.35 alongside the durable `approval.candidate`/`approval.settled` events),
  the same routes, and a session addressed by ID. Eve's client parses stream
  events without a version gate, so sessions this app opened against
  0.31–0.33 Agents continue by ID and 0.29/0.30 sessions by continuation
  token, which never leaves the server — an Agent that upgrades mid-session
  does not strand its chats.
- Send every message with `turnPolicy: "queue"`. Eve defaults message sends to
  `"steer"` from 0.33 through 0.39 — a message arriving mid-turn cancels that
  turn and replaces it — and this chat offers Stop as the deliberate way to
  interrupt instead.
- Stop is Eve 0.38's durable `cancel()`: the binding waits for the turn's
  `turn.started`, cancels exactly that turn through the per-chat proxy's
  cancel route, and stays attached to the stream until the turn settles, so
  the proxy observes the `turn.cancelled` it caused.
- PostgreSQL 16 persistence for agents, chats, protocol events, and Eve session state.
- Provider-neutral Eveland login, identity-scope switching, and pre-expiry App/Caller Token refresh.
- Require an Eveland Identity Session to use the app; the sidebar shows the
  signed-in principal with sign-out and identity-scope switching, and the
  first authenticated load claims this browser's pre-login chats.
- Preserve historical chats after a managed Agent leaves the Catalog, while marking that Agent unavailable for new turns.

The former Gateway URL discovery flow and `/.well-known/eve/agents.json`
directory protocol are not supported.

## Eve HITL gaps handled here

Eve parks a turn on a batch of input requests, but which batches a session is
parked on lives only in Eve's server-side state — no stream event and no query
exposes it, and no event records that a batch was answered *by this channel*.
Both signals a browser could fall back on lie: an answered `ask_question` part
stays `approval-requested` in the durable stream forever, while Eve's client
store projects an answer as settled *before* posting it and never rolls that
back. Upstream: [vercel/eve#1095](https://github.com/vercel/eve/issues/1095)
proposes a durable `input.responded` event;
[vercel/eve#1578](https://github.com/vercel/eve/pull/1578) drafts the contract
but ships no runtime change; related
[vercel/eve#1507](https://github.com/vercel/eve/issues/1507). Eve 0.39 still
emits nothing for a question answer or an unauthenticated approval answer, so
the ledger below remains the record of a park. What 0.35 did add is
`approval.settled`: a durable event for a tool approval an *authenticated*
responder resolved, whichever channel carried the answer — the one settlement
the stream now reports, and the ledger consumes it (below).

**The proxy keeps a pending-input ledger** (`chats.pending_input_json`), being
the one component that observes the truth: every `input.requested` passes
through its stream tap (opening a batch under the turn that raised it), it
alone sees which turn POSTs Eve accepted (settling the answered batch under
Eve's own resolution rule — one answer resolves a question batch, an approval
batch needs every approval answered, and partial answers stay parked and
accumulate), the tap also settles the request an `approval.settled` event
names (an answer that never passes through this proxy's turn route), and it
owns the teardown paths (terminal session events and session replacement clear
all parks; a cancelled turn clears only the parks that turn raised, because
from 0.33 a steered message cancels the running turn while older batches stay
open and answerable; a `no_active_turn` cancel and transient turn failures
deliberately clear nothing, because Eve's park survived). Several batches can
be open at once — subagent-proxied requests park independently, and from 0.35
a turn that parked on an approval beside a subagent call re-parks on the same
still-pending approval when the delegation result arrives, so one answer may
settle several recorded copies of the batch. The client seeds from the ledger,
closes optimistically on respond, cancels through Eve's own `cancel()` so a
Stop names the exact turn and tears down no more than that turn's parks, and
refetches to reconcile on every failure or foreign turn boundary. Answers
themselves are also stored as `client.input.responded` events so replays show
what was picked. Chats from before the ledger derive their state from stored
events on first read (counting `approval.settled` as answered), erring
conservative-open. The full analysis and rules live in
[`docs/plans/2026-08-10-hitl-root-cause-and-fix.md`](docs/plans/2026-08-10-hitl-root-cause-and-fix.md).

**One answer settles the whole batch.** Eve classifies `ask_question` as
dismissable, so the first response resolves every request in the batch and the
rest reach the model as `{ status: "ignored" }` — still true in 0.39, whose
`resolveQuestionOnlyInputBatches`/`resolveApprovalInputBatches` carry the same
two rules 0.33 introduced. The thread collects an answer for every still-open request
in a batch before it responds, the way Eve's own ACP adapter does — per batch,
never a union across batches — and a draft stays revisable until its batch goes
out. A plain message is Eve's own dismiss gesture for a question-only park.
Eve's scaffold web template and its Discord/Telegram/Teams/Linear channels
still submit one answer per click.

**The composer locks only for an Agent that would hold the message.** Through
0.31 an unrelated message sent while a tool approval or an interactive
authorization challenge was open never ran: Eve held it until the request was
answered, so a UI that accepted it looked wedged. Eve 0.32 stopped deferring
behind authorization challenges and 0.33.1 behind tool approvals — the message
runs as its own turn, the request stays open, and a later structured answer
still resolves the original tool call. The thread reads the Agent's version off
`session.started` and locks only below 0.32; an unknown version locks, because
a visible lock is recoverable and a silently deferred message is not.

**Known residues** (each chosen over a worse alternative): a question batch a
plain message dismissed keeps its controls on screen until clicked or the
session moves on — the ledger cannot tell Eve's own batch from a
subagent-proxied one a message never reaches, and wrongly closing a proxied
park would strand the subagent (from 0.33 Eve itself declines to guess once
more than one batch is open, and dismisses nothing); a second tab can answer a
batch inside the window before its next reconcile, which Eve degrades to a
synthetic user message — `approval.settled` narrows this to question answers
and unauthenticated approval answers, the cases Eve still emits nothing for; a
batch Eve resolved by text-matching a plain message renders Dismissed although
Eve recorded answers; and a park whose `input.requested` named no turn is
never cleared by a cancel, only by an answer or a terminal session event. The
previous residue of an unattributable Stop clearing every park is gone: Eve
0.38's `cancel()` waits to name the exact turn, so a cancel can no longer
outrun the park it tears down.

## Development

See [`docs/local-development.md`](docs/local-development.md).

## Production deployment (single machine)

```bash
echo "AUTH_SECRET=$(openssl rand -base64 32)" >> .env  # once, on first deploy
docker compose -f compose.production.yaml up -d --build
```

This builds the app image, starts PostgreSQL, applies Drizzle migrations, and serves the app on port 3010. Configure `EVELAND_IDENTITY_URL`, `EVELAND_IDENTITY_ISSUER`, and an Agent-reachable `EVELAND_IDENTITY_JWKS_URL`; register the exact EveChats origin under Eveland System > Identity and add it to `EVELAND_IDENTITY_ALLOWED_ORIGINS`. `AUTH_SECRET` remains required only for decrypting any legacy Agent credentials.

When Eveland Identity and EveChats use the same hostname (such as local
`localhost` services on different ports), EveChats proxies cookie-bearing
`/identity/*` browser requests to the configured Identity origin. Provider
login and Agent-provided continuation URLs still navigate directly to Eveland.
Different hostnames retain direct Identity requests, so existing shared-site
production deployments are unchanged. Production should use one HTTPS
schemeful site (for example, `identity.example.com` and `chat.example.com`);
unrelated sites require an explicit authorization-code handoff.
