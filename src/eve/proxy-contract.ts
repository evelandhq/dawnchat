import {
  isInputResponse,
  type ClientInputRespondedEvent,
  type InputResponse,
  type MessageStreamEvent,
} from "eve/client";

/**
 * One event as EveChats stores it and replays it into the browser.
 *
 * Eve emits no stream event when a question batch is answered, or when an
 * unauthenticated responder answers an approval — an answered `ask_question`
 * part stays `approval-requested` in the stored stream forever — so the proxy
 * records the answers it forwards as `client.input.responded`, the reducer
 * event Eve's own client uses for them. From 0.35 an *authenticated*
 * responder's approval answer does emit a durable `approval.settled`, which
 * the ledger consumes; everything else is still upstream gap
 * https://github.com/vercel/eve/issues/1095.
 */
export type ChatEvent = MessageStreamEvent | ClientInputRespondedEvent;

/** Reads the HITL answers out of a turn request body, dropping malformed ones. */
export function readInputResponses(body: Record<string, unknown>): InputResponse[] {
  const responses = body.inputResponses;
  return Array.isArray(responses) ? responses.filter(isInputResponse) : [];
}

/**
 * The pending-input ledger: which `input.requested` batches Eve is still
 * parked on, recorded by the proxy because Eve exposes that state through no
 * event and no query (design: docs/plans/2026-08-10-hitl-root-cause-and-fix.md).
 *
 * A batch opens when its `input.requested` event is first persisted, collects
 * `answered` request IDs from turn bodies Eve accepted, and closes under Eve's
 * own resolution rule. Several batches can be open at once: subagent-proxied
 * requests park independently of the harness's own batch.
 */
export type PendingInputRequest = {
  requestId: string;
  /** Eve's request kind, kept verbatim; only two kinds are required. */
  kind: string;
};

export type PendingInputBatch = {
  /** Identity: the chat event_index of the `input.requested` event. */
  eventIndex: number;
  requests: PendingInputRequest[];
  /** Request IDs Eve has accepted answers for so far. */
  answered: string[];
  /**
   * The turn that raised this batch, from the `input.requested` payload.
   * Cancelling a turn only tears down the parks that turn owns, so a batch
   * that predates this field (or an event without one) survives every cancel
   * and settles through an answer or a terminal session event instead.
   */
  turnId?: string;
};

export type PendingInputState = { batches: PendingInputBatch[] };

export const EMPTY_PENDING_INPUT: PendingInputState = { batches: [] };

/** Mirrors Eve's `classifyInputRequest`: only these two kinds park a turn hard. */
export function isRequiredKind(kind: string): boolean {
  return kind === "tool-approval" || kind === "session-limit";
}

/**
 * The Eve version serving this chat, as `session.started` reports it. The last
 * one wins: a replaced session reports the version the Agent runs now, and a
 * child session's events arrive wrapped in `subagent.event` rather than as a
 * bare `session.started`.
 */
export function agentEveVersion(events: readonly unknown[]): string | undefined {
  let version: string | undefined;
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if ((event as { type?: unknown }).type !== "session.started") continue;
    const data = (event as { data?: unknown }).data;
    if (!data || typeof data !== "object") continue;
    const runtime = (data as { runtime?: unknown }).runtime;
    if (!runtime || typeof runtime !== "object") continue;
    const candidate = (runtime as { eveVersion?: unknown }).eveVersion;
    if (typeof candidate === "string" && candidate.length > 0) {
      version = candidate;
    }
  }
  return version;
}

/**
 * Whether an unrelated message sent while a request is open would be held
 * rather than run.
 *
 * Up to Eve 0.31 an ordinary message stalled behind an open tool approval or
 * an interactive authorization challenge: Eve kept it until the request was
 * answered, so a UI that let it through looked wedged. Eve 0.32 stopped
 * deferring behind authorization challenges and 0.33.1 behind tool approvals —
 * the message runs as its own turn, the request stays open, and a later
 * structured answer still resolves the original tool call.
 *
 * An unreadable or missing version answers `true`: locking the composer is
 * visible and recoverable, while a silently deferred message is neither.
 */
export function holdsMessagesForPendingInput(version: string | undefined): boolean {
  if (version === undefined) return true;
  const match = /^(\d+)\.(\d+)\./.exec(version.trim());
  if (!match) return true;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major > 0) return false;
  return minor < 32;
}

export function hasUnansweredRequiredRequest(state: PendingInputState): boolean {
  return state.batches.some((batch) => unansweredRequired(batch).length > 0);
}

function unansweredRequired(batch: PendingInputBatch): PendingInputRequest[] {
  const answered = new Set(batch.answered);
  return batch.requests.filter(
    (request) => isRequiredKind(request.kind) && !answered.has(request.requestId),
  );
}

/**
 * `null` marks a chat from before the ledger existed; its state must be
 * derived from stored events instead (`derivePendingInput`). An unreadable
 * value degrades to the same path rather than wedging the chat.
 */
export function parsePendingInput(json: string | null): PendingInputState | null {
  if (json === null) {
    return null;
  }
  try {
    const value = JSON.parse(json) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const batches = (value as { batches?: unknown }).batches;
    if (!Array.isArray(batches)) return null;
    const parsed: PendingInputBatch[] = [];
    for (const batch of batches) {
      const candidate = parsePendingBatch(batch);
      if (!candidate) return null;
      parsed.push(candidate);
    }
    return { batches: parsed };
  } catch {
    return null;
  }
}

function parsePendingBatch(value: unknown): PendingInputBatch | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const batch = value as Record<string, unknown>;
  if (typeof batch.eventIndex !== "number") return null;
  if (!Array.isArray(batch.requests) || !Array.isArray(batch.answered)) return null;
  const requests: PendingInputRequest[] = [];
  for (const request of batch.requests) {
    if (!request || typeof request !== "object") return null;
    const { requestId, kind } = request as Record<string, unknown>;
    if (typeof requestId !== "string" || typeof kind !== "string") return null;
    requests.push({ requestId, kind });
  }
  if (!batch.answered.every((id) => typeof id === "string")) return null;
  return {
    eventIndex: batch.eventIndex,
    requests,
    answered: batch.answered as string[],
    ...(typeof batch.turnId === "string" ? { turnId: batch.turnId } : {}),
  };
}

export function serializePendingInput(state: PendingInputState): string {
  return JSON.stringify(state);
}

/** The requests carried by an `input.requested` payload, or null when it has none. */
export function pendingRequestsFromEvent(payload: unknown): PendingInputRequest[] | null {
  const requests = derivedRequestsFromEvent(payload);
  return requests
    ? requests.map(({ requestId, kind }) => ({ requestId, kind }))
    : null;
}

/**
 * The approval request an `approval.settled` event resolves. Emitted from Eve
 * 0.35 (stream version 22) when an authenticated responder answers a tool
 * approval, whichever channel carried the answer; either outcome — approved
 * or cancelled — settles the request. Unauthenticated answers emit nothing,
 * so this narrows the foreign-answer gap rather than closing it.
 */
export function settledApprovalRequestId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  if ((payload as { type?: unknown }).type !== "approval.settled") return undefined;
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const requestId = (data as { requestId?: unknown }).requestId;
  return typeof requestId === "string" && requestId.length > 0 ? requestId : undefined;
}

/** The turn a stream event belongs to, for events that name one. */
export function turnIdFromEvent(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const turnId = (data as { turnId?: unknown }).turnId;
  return typeof turnId === "string" && turnId.length > 0 ? turnId : undefined;
}

/** Opens a batch, replacing any earlier record of the same event. */
export function openPendingBatch(
  state: PendingInputState,
  batch: { eventIndex: number; requests: PendingInputRequest[]; turnId?: string },
): PendingInputState {
  return {
    batches: [
      ...state.batches.filter((existing) => existing.eventIndex !== batch.eventIndex),
      {
        eventIndex: batch.eventIndex,
        requests: batch.requests,
        answered: [],
        ...(batch.turnId ? { turnId: batch.turnId } : {}),
      },
    ].sort((left, right) => left.eventIndex - right.eventIndex),
  };
}

/**
 * Drops the parks one cancelled turn owned.
 *
 * From Eve 0.33 a plain message sent while a turn runs *steers* by default:
 * Eve cancels that turn and starts the replacement under a new turn ID, while
 * every batch parked by an earlier turn stays open and answerable. A blanket
 * clear on `turn.cancelled` would therefore hide live approval controls, and
 * the tool call behind them can only come back if the model asks again. Only
 * the cancelled turn's own parks are gone.
 *
 * A batch with no recorded `turnId` is kept: erring open costs controls that
 * linger until the next reconcile, and a late answer to a batch Eve really did
 * tear down degrades to Eve's stale-response conversion, while erring closed
 * strands a required request with no way back.
 */
export function clearPendingBatchesForTurn(
  state: PendingInputState,
  turnId: string,
): PendingInputState {
  return { batches: state.batches.filter((batch) => batch.turnId !== turnId) };
}

/**
 * Applies the answers of one turn Eve accepted — a mirror of Eve's own batch
 * resolution (`resolveApprovalInputBatches`/`resolveQuestionOnlyInputBatches`,
 * unchanged through eve@0.39.0; `resolvePendingInput` before 0.33 restructured
 * it into an ordered collection of batches, with the same two rules). A batch closes once
 * it has been addressed and no required request is unanswered: Eve resolves a
 * question batch on any one answer and an approval batch only once every
 * approval in it has one, carrying the leftovers forward. An
 * addressed-but-incomplete required batch therefore stays open here too.
 * A message-only turn (no responses) closes nothing: Eve does dismiss its own
 * all-dismissable batch on one, but a lone open batch may equally be a
 * subagent-proxied park the message never reaches, and wrongly closing that
 * would strand the child.
 */
export function settlePendingInput(
  state: PendingInputState,
  responses: readonly InputResponse[],
): PendingInputState {
  return settleAnsweredRequests(
    state,
    responses.map((response) => response.requestId),
  );
}

/**
 * Marks request IDs answered, whatever carried the answer. Turn bodies this
 * proxy forwarded arrive via `settlePendingInput`; an `approval.settled`
 * stream event (Eve ≥ 0.35) reports an approval an authenticated responder
 * resolved through *any* surface — another channel, another tab — and is the
 * one durable settlement signal Eve emits, so the tap feeds it through here
 * too. Batch closure follows Eve's own rule either way.
 */
export function settleAnsweredRequests(
  state: PendingInputState,
  requestIds: readonly string[],
): PendingInputState {
  if (requestIds.length === 0) {
    return state;
  }
  const responded = new Set(requestIds);
  const batches: PendingInputBatch[] = [];
  for (const batch of state.batches) {
    const addressed = batch.requests.some((request) => responded.has(request.requestId));
    const answered = [
      ...new Set([
        ...batch.answered,
        ...batch.requests
          .map((request) => request.requestId)
          .filter((requestId) => responded.has(requestId)),
      ]),
    ];
    const next = { ...batch, answered };
    if (addressed && unansweredRequired(next).length === 0) {
      continue;
    }
    batches.push(next);
  }
  return { batches };
}

/**
 * One-shot derivation for chats that predate the ledger, from their stored
 * events. Each rule picks the recoverable error direction: a batch wrongly
 * derived open costs lingering controls (a late answer degrades to Eve's
 * stale-response conversion), while a genuinely parked batch wrongly derived
 * closed costs the chat — silent deferral for a required batch, a stranded
 * subagent for a proxied one.
 */
export function derivePendingInput(input: {
  events: readonly StoredChatEvent[];
  sessionId: string | null | undefined;
  active: boolean;
}): PendingInputState {
  if (!input.active || !input.sessionId) {
    return EMPTY_PENDING_INPUT;
  }

  let boundary = -1;
  for (const event of input.events) {
    if (
      event.type === "session.completed" ||
      event.type === "session.failed" ||
      event.type === "turn.cancelled"
    ) {
      boundary = event.eventIndex;
    }
  }

  const answeredIds = new Set<string>();
  const settledCallIds = new Set<string>();
  for (const event of input.events) {
    if (event.type === "client.input.responded") {
      for (const requestId of respondedRequestIds(event.payload)) {
        answeredIds.add(requestId);
      }
    }
    if (event.type === "approval.settled") {
      const requestId = settledApprovalRequestId(event.payload);
      if (requestId) answeredIds.add(requestId);
    }
    if (event.type === "action.result") {
      for (const id of actionResultIds(event.payload)) {
        settledCallIds.add(id);
      }
    }
  }

  const batches: PendingInputBatch[] = [];
  for (const event of input.events) {
    if (
      event.type !== "input.requested" ||
      event.sessionId !== input.sessionId ||
      event.eventIndex <= boundary
    ) {
      continue;
    }
    const requests = derivedRequestsFromEvent(event.payload);
    if (!requests) continue;

    const answered = requests
      .filter(
        (request) =>
          answeredIds.has(request.requestId) ||
          (request.callId !== undefined && settledCallIds.has(request.callId)) ||
          settledCallIds.has(request.requestId),
      )
      .map((request) => request.requestId);
    const answeredSet = new Set(answered);
    const requiredOpen = requests.some(
      (request) => isRequiredKind(request.kind) && !answeredSet.has(request.requestId),
    );
    const hasRequired = requests.some((request) => isRequiredKind(request.kind));

    const turnId = turnIdFromEvent(event.payload);
    if (requiredOpen) {
      batches.push({
        eventIndex: event.eventIndex,
        requests: requests.map(({ requestId, kind }) => ({ requestId, kind })),
        answered,
        ...(turnId ? { turnId } : {}),
      });
      continue;
    }
    if (hasRequired) {
      continue;
    }
    // All-dismissable: a later turn moving in this session means Eve went past
    // it. Another batch's `input.requested` proves nothing — proxied parks
    // stack without boundaries.
    const followedByActivity = input.events.some(
      (later) =>
        later.eventIndex > event.eventIndex &&
        later.sessionId === input.sessionId &&
        (later.type === "message.received" || later.type === "turn.started"),
    );
    if (answered.length === 0 && !followedByActivity) {
      batches.push({
        eventIndex: event.eventIndex,
        requests: requests.map(({ requestId, kind }) => ({ requestId, kind })),
        answered,
        ...(turnId ? { turnId } : {}),
      });
    }
  }
  return { batches };
}

export type StoredChatEvent = {
  eventIndex: number;
  sessionId: string | null;
  type: string;
  payload: unknown;
};

function respondedRequestIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== "object") return [];
  const responses = (data as { responses?: unknown }).responses;
  if (!Array.isArray(responses)) return [];
  return responses
    .map((response) =>
      response && typeof response === "object"
        ? (response as { requestId?: unknown }).requestId
        : undefined,
    )
    .filter((requestId): requestId is string => typeof requestId === "string");
}

/** The call ID an `action.result` settles, plus the approval's request ID if present. */
function actionResultIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== "object") return [];
  const result = (data as { result?: unknown }).result;
  if (!result || typeof result !== "object") return [];
  const ids: string[] = [];
  const callId = (result as { callId?: unknown }).callId;
  if (typeof callId === "string") ids.push(callId);
  const output = (result as { output?: unknown }).output;
  if (output && typeof output === "object") {
    const approval = (output as { approval?: unknown }).approval;
    if (approval && typeof approval === "object") {
      const requestId = (approval as { requestId?: unknown }).requestId;
      if (typeof requestId === "string") ids.push(requestId);
    }
  }
  return ids;
}

type DerivedRequest = PendingInputRequest & { callId?: string };

function derivedRequestsFromEvent(payload: unknown): DerivedRequest[] | null {
  if (!payload || typeof payload !== "object") return null;
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const requests = (data as { requests?: unknown }).requests;
  if (!Array.isArray(requests)) return null;
  const parsed: DerivedRequest[] = [];
  for (const request of requests) {
    if (!request || typeof request !== "object") continue;
    const fields = request as Record<string, unknown>;
    const { requestId, kind, action } = fields;
    if (typeof requestId !== "string") continue;
    const callId =
      action && typeof action === "object"
        ? (action as { callId?: unknown }).callId
        : undefined;
    parsed.push({
      requestId,
      kind: typeof kind === "string" ? kind : fallbackRequestKind(fields),
      ...(typeof callId === "string" ? { callId } : {}),
    });
  }
  return parsed.length > 0 ? parsed : null;
}

/**
 * Requests predating `kind` (Eve < 0.28) are told apart by shape, the way
 * their emitters built them: approvals render a confirmation with
 * approve/deny options, questions a select/text prompt. (Eve 0.32 renamed the
 * negative option to `cancel`; no request this path sees is that new.) Both
 * carry an `action.callId`, so the action's presence distinguishes nothing. The
 * unrecognisable rest defaults to required — a wrongly locked composer is
 * answerable on screen, a wrongly dismissed approval silently defers every
 * later message.
 */
function fallbackRequestKind(request: Record<string, unknown>): string {
  const display = typeof request.display === "string" ? request.display : undefined;
  if (display === "confirmation") return "tool-approval";
  const options = Array.isArray(request.options) ? request.options : [];
  const optionIds = new Set(
    options.map((option) =>
      option && typeof option === "object"
        ? (option as { id?: unknown }).id
        : undefined,
    ),
  );
  if (optionIds.has("approve") || optionIds.has("deny")) return "tool-approval";
  if (
    display === "select" ||
    display === "text" ||
    request.allowFreeform === true ||
    options.length > 0
  ) {
    return "question";
  }
  const toolName =
    request.action && typeof request.action === "object"
      ? (request.action as { toolName?: unknown }).toolName
      : undefined;
  return toolName === "ask_question" ? "question" : "tool-approval";
}

export function inputRespondedEvent(
  responses: readonly InputResponse[],
  createdAt: number,
): ClientInputRespondedEvent {
  return { type: "client.input.responded", data: { createdAt, responses } };
}

/**
 * Eve 0.29/0.30 agents address a session by continuation token; Eve 0.31
 * addresses it by session ID alone. EveChats keeps the real token server-side
 * for both generations, so it is dropped from every browser-facing payload
 * before it leaves the per-chat proxy.
 */
export function withoutContinuationToken<T extends Record<string, unknown>>(
  payload: T,
): Omit<T, "continuationToken"> {
  const { continuationToken: _redacted, ...rest } = payload;
  return rest;
}
