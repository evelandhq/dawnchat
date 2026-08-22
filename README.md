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

The browser renders Eve's `defaultMessageReducer` projection with AI Elements and talks to a same-origin, per-chat Eve protocol proxy. Eveland owns provider login, the Identity Session, and the Agent Catalog. Opening any EveChats page requires an Eveland Identity Session: an app-level gate redirects unauthenticated visitors to Eveland login and returns them to the page they opened, so the sidebar lists the identity's chat history — across every Agent, from any browser — without entering an Agent first. The gate is a UI policy only; it changes nothing about Agent credentials. Chatting with an Agent that does not request Eveland Identity still sends that Agent no Eveland token, and externally registered Agents keep their configured auth. If the Agent responds with an Eveland authentication challenge, the browser obtains a project-scoped Caller Token and automatically retries that request. The proxy verifies App and Caller Tokens against Eveland JWKS, never infers route auth from Catalog membership, and redacts channel-local waiting capabilities from browser payloads.

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
- Persist Eve events as the canonical chat history, with channel-local waiting
  capabilities redacted and idempotent `(chat, session, stream index)` replay handling.
- Continue supported chats through `useEveAgent` with an ID-addressed session cursor.
- Connect to Eve agents running 0.42.x through 0.44.x — the same support
  window Eveland hosts. All three use stream version 23, the same routes, and
  sessions addressed by ID. Chats created under an older Eve version continue
  by their stored `sessionId` once the Agent runs 0.42–0.44; obsolete stored
  tokens are ignored. If the Eve-side durable session itself has been deleted,
  local display history alone does not reconstruct its model context.
- Send every message with `turnPolicy: "queue"`. Eve defaults message sends to
  `"steer"` in the supported window — a message arriving mid-turn cancels that
  turn and replaces it — and this chat offers Stop as the deliberate way to interrupt.
- Stop uses Eve's durable `cancel()`: the binding waits for the turn's
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
currently parked on still lives only in Eve's server-side state: no query
exposes that snapshot. Stream version 23's `input.resolved` records every server-accepted terminal
outcome (`answered`, `approved`, `denied`, `ignored`, or `invalid`) and carries
the response when one exists. Eve 0.42–0.44 and the matching client project
those events on replay. The local ledger remains useful because the proxy sees
a successful response POST before a browser necessarily consumes its stream,
and it gives every tab an immediate authoritative pending-state snapshot.

**The proxy keeps a pending-input ledger** (`chats.pending_input_json`), being
the one component that observes the truth: every `input.requested` passes
through its stream tap (opening a batch under the turn that raised it), it
alone sees which turn POSTs Eve accepted (settling the answered batch under
Eve's own resolution rule — one answer resolves a question batch, an approval
batch needs every approval answered, and partial answers stay parked and
accumulate), and the tap settles every request named by `input.resolved`,
including answers from another tab or channel. The proxy also owns teardown
paths (terminal session events and session replacement clear all parks; a
cancelled turn clears only the parks that turn raised, because a steered
message cancels the running turn while other batches stay open and
answerable; a `no_active_turn` cancel and transient turn failures deliberately
clear nothing, because Eve's park survived). Several batches can be open at
once — subagent-proxied requests park independently, and one request may be
re-emitted in more than one recorded batch. The client seeds from the ledger,
applies live `input.resolved` events immediately, closes optimistically on its
own response, cancels through Eve's `cancel()`, and refetches on every failure
or foreign turn boundary. Accepted local answers are also stored as
`client.input.responded` so they remain visible even if that tab never reads
the matching stream event. Chats from before the ledger derive their state
from stored v23 events, erring conservative-open. The full
analysis and historical rules live in
[`docs/plans/2026-08-10-hitl-root-cause-and-fix.md`](docs/plans/2026-08-10-hitl-root-cause-and-fix.md).

**One answer settles the whole batch.** Eve classifies `ask_question` as
dismissable, so the first response resolves every request in the batch and the
rest reach the model as `{ status: "ignored" }`. The thread collects an answer for every still-open request
in a batch before it responds, the way Eve's own ACP adapter does — per batch,
never a union across batches — and a draft stays revisable until its batch goes
out. A plain message is Eve's own dismiss gesture for a question-only park.
Eve's scaffold web template and its Discord/Telegram/Teams/Linear channels
still submit one answer per click.

**The composer remains available while input is pending.** In Eve 0.42–0.44 an
unrelated message runs as its own queued turn while the request remains open
and answerable, so pending controls do not lock the composer.

**Known residues:** another tab can submit an answer in the small window before
its `input.resolved` reaches this tab; Eve treats that stale response as a
normal user message instead of reapplying it. A park whose `input.requested`
named no turn is never cleared by a cancel, only by a resolution or terminal
session event, because clearing it speculatively could strand a live subagent.
Eve's `cancel()` waits to name the exact turn, so Stop cannot outrun the park
it tears down.

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
