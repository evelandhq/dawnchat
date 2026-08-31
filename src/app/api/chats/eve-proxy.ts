import { createHash } from "node:crypto";

import type { MessageStreamEvent } from "eve/client";

import { resolveAppBrowserSession } from "@/app-session";
import {
  createRepository,
  type Chat,
  type Repository,
  type SessionState,
} from "@/db/repository";
import { getDbClient } from "@/db/provider";
import { createEveClientForConnection } from "@/eve/client";
import {
  formatEveErrorMessage,
  readEveErrorId,
  sessionFailureErrorId,
} from "@/eve/error-observability";
import {
  clearPendingBatchesForTurn,
  EMPTY_PENDING_INPUT,
  inputRespondedEvent,
  pendingRequestsFromEvent,
  readInputResponses,
  resolvedInputRequestIds,
  settlePendingInput,
  turnIdFromEvent,
  withoutContinuationToken,
  type PendingInputRequest,
} from "@/eve/proxy-contract";
import {
  CallerTokenError,
  callerTokenErrorResponse,
  getCallerTokenVerifier,
} from "@/identity/server";

const NDJSON_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";

/**
 * How long a create claim stays valid without being released. Eve's command
 * hook wait means a create can legitimately take 30s before it answers, so
 * this only has to outlast a real attempt: past it, the claim belongs to a
 * handler that never came back.
 */
const CREATE_CLAIM_LEASE_MS = 90_000;

/** Forwarded to the browser but never persisted; see `persistEvent`. */
const STREAM_DELTA_EVENT_TYPES = new Set([
  "action.input.appended",
  "message.appended",
  "reasoning.appended",
]);

type ProxyContext = {
  chat: Chat;
  repository: Repository;
  client: ReturnType<typeof createEveClientForConnection>;
  /**
   * Present when a credential Dawn holds could authenticate a principal for
   * this connection, which is the condition Eve requires before it will
   * honour an `operationId` at all.
   */
  sessionCreateOperationId?: string;
};

export async function proxyCreateEveSession(request: Request, chatId: string): Promise<Response> {
  const resolved = await resolveProxyContext(request, chatId);
  if (resolved instanceof Response) {
    return resolved;
  }

  if (resolved.chat.status === "completed") {
    return errorResponse("Chat is completed", 409);
  }
  if (resolved.chat.status === "active" && resolved.chat.sessionState?.sessionId) {
    return errorResponse("Chat already has an Eve session", 409);
  }

  return proxyTurnRequest(request, resolved);
}

export async function proxyContinueEveSession(
  request: Request,
  chatId: string,
  sessionId: string,
): Promise<Response> {
  const resolved = await resolveProxyContext(request, chatId);
  if (resolved instanceof Response) {
    return resolved;
  }

  if (resolved.chat.status === "completed") {
    return errorResponse("Chat is completed", 409);
  }
  if (resolved.chat.sessionState?.sessionId !== sessionId) {
    return errorResponse("Eve session does not belong to this chat", 409);
  }

  return proxyTurnRequest(request, resolved, sessionId);
}

export async function proxyCancelEveTurn(
  request: Request,
  chatId: string,
  sessionId: string,
): Promise<Response> {
  const resolved = await resolveProxyContext(request, chatId);
  if (resolved instanceof Response) {
    return resolved;
  }

  const session = resolved.chat.sessionState;
  if (session?.sessionId !== sessionId) {
    return errorResponse("Eve session does not belong to this chat", 409);
  }

  const input = await readOptionalObjectBody(request);
  if (input instanceof Response) {
    return input;
  }
  const turnId = stringValue(input.turnId);

  try {
    const result = await resolved.client.sessions
      .attach(sessionId, { streamIndex: session.streamIndex ?? 0 })
      .cancel(turnId ? { turnId } : undefined);
    // Only `accepted` proves Eve tore anything down. A `no_active_turn` cancel
    // (the session was parked between turns) leaves Eve's batch alive, and
    // clearing the ledger for it would hide the controls while every later
    // message is silently deferred.
    //
    // A caller that named the turn it was stopping gets the same turn-scoped
    // clear the stream tap applies. Eve steering may also race before the
    // client knows that id and issue an unattributed accepted cancel; clearing
    // every batch in that case would hide unrelated parks. The attached stream
    // remains authoritative and its `turn.cancelled` event clears the exact
    // turn when it arrives.
    if (turnId && cancelWasAccepted(result)) {
      await resolved.repository
        .updatePendingInput(resolved.chat.id, (current) =>
          current && clearPendingBatchesForTurn(current, turnId),
        )
        .catch((error: unknown) => {
          console.error(`Failed to clear pending input for ${resolved.chat.id}:`, error);
        });
    }
    return Response.json(result, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return errorResponse("Unable to cancel the Eve turn", 502);
  }
}

function cancelWasAccepted(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { status?: unknown }).status === "accepted"
  );
}

export async function proxyEveSessionStream(
  request: Request,
  chatId: string,
  sessionId: string,
): Promise<Response> {
  const resolved = await resolveProxyContext(request, chatId);
  if (resolved instanceof Response) {
    return resolved;
  }

  const session = resolved.chat.sessionState;
  if (session?.sessionId !== sessionId) {
    return errorResponse("Eve session does not belong to this chat", 409);
  }

  const requestUrl = new URL(request.url);
  const parsedStartIndex = parseStartIndex(requestUrl.searchParams.get("startIndex"));
  if (parsedStartIndex === null) {
    return errorResponse("Invalid stream startIndex", 400);
  }

  const abort = new AbortController();
  if (request.signal.aborted) {
    abort.abort();
  } else {
    request.signal.addEventListener("abort", () => abort.abort(), { once: true });
  }
  const iterator = resolved.client.sessions
    .attach(sessionId, { streamIndex: parsedStartIndex })
    .stream({ startIndex: parsedStartIndex, signal: abort.signal })
    [Symbol.asyncIterator]();
  let first: IteratorResult<MessageStreamEvent>;
  try {
    first = await iterator.next();
  } catch {
    return errorResponse("Unable to reach Eve agent", 502);
  }

  const persisted = createPersistedEventStream({
    abort,
    chat: resolved.chat,
    first,
    iterator,
    repository: resolved.repository,
    session,
    sessionId,
    startIndex: parsedStartIndex,
  });
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": NDJSON_CONTENT_TYPE,
  });

  return new Response(persisted, { status: 200, headers });
}

async function proxyTurnRequest(
  request: Request,
  context: ProxyContext,
  sessionId?: string,
): Promise<Response> {
  const input = await readObjectBody(request);
  if (input instanceof Response) {
    return input;
  }

  const body = withoutContinuationToken({ ...input });
  // The browser never names the operation: a caller-chosen id could make one
  // chat's create adopt the session another chat committed.
  delete body.operationId;
  if (sessionId !== undefined) {
    return forwardTurn(request, context, sessionId, body);
  }

  if (context.sessionCreateOperationId) {
    body.operationId = context.sessionCreateOperationId;
  }
  // Eve persists the workflow before it waits for the command hook, so a
  // create that never answers — the 30s wait elapsing into a 500, a dropped
  // connection, this handler dying — can still leave a session that runs
  // later. Resolving the chat, finding it has no session, and recording the
  // attempt are separate reads, so two requests could each pass that check
  // against a stale row and both cross a boundary neither can take back. The
  // claim collapses the check and the mark into one conditional write.
  const claimed = await context.repository.claimSessionCreate(
    context.chat.id,
    new Date(Date.now() - CREATE_CLAIM_LEASE_MS),
  );
  if (!claimed) {
    return errorResponse("A session create for this chat is already in progress", 409);
  }

  try {
    return await forwardTurn(request, context, undefined, body);
  } finally {
    // Only the claim is released here; the unconfirmed mark it left is for
    // proof to clear, and outlives every failure this request can have.
    await context.repository
      .releaseSessionCreateClaim(context.chat.id)
      .catch((error: unknown) => {
        console.error(`Failed to release the create claim for ${context.chat.id}:`, error);
      });
  }
}

async function forwardTurn(
  request: Request,
  context: ProxyContext,
  sessionId: string | undefined,
  body: Record<string, unknown>,
): Promise<Response> {
  const isCreate = sessionId === undefined;
  const currentSession = context.chat.sessionState;

  let remote: Response;
  try {
    remote = await postTurn(context, sessionId, body, request.signal);
  } catch {
    await context.repository.updateChatStatus(context.chat.id, "failed");
    return errorResponse("Unable to reach Eve agent", 502);
  }

  if (!remote.ok && isCreate && (await rejectsOperationId(remote, body))) {
    // Eve accepts `operationId` only for an authenticated principal, and an
    // Agent whose Eve channel configures no authenticator resolves every
    // caller as anonymous however Dawn holds its credential. The rejection is
    // issued before any session work, so this retry replaces a request that
    // provably created nothing; it costs idempotency, which that Agent could
    // not have offered anyway.
    delete body.operationId;
    try {
      remote = await postTurn(context, sessionId, body, request.signal);
    } catch {
      await context.repository.updateChatStatus(context.chat.id, "failed");
      return errorResponse("Unable to reach Eve agent", 502);
    }
  }

  if (!remote.ok) {
    if (isCreate && !isAmbiguousFailureStatus(remote.status)) {
      // The Agent refused the request itself, which is proof it created
      // nothing: this chat is safe to send from again.
      await context.repository.clearSessionCreateUnconfirmed(context.chat.id);
    }
    if (remote.status !== 401) {
      await context.repository.updateChatStatus(context.chat.id, "failed");
    }
    return forwardErrorResponse(remote, context.chat.id);
  }

  // Eve answered 2xx from here on, so an unreadable body or a missing session
  // ID leaves a create unconfirmed rather than refuted.
  const payload = await readResponseObject(remote);
  if (payload instanceof Response) {
    await context.repository.updateChatStatus(context.chat.id, "failed");
    return payload;
  }

  const resolvedSessionId =
    stringValue(payload.sessionId) ?? remote.headers.get("x-eve-session-id")?.trim() ?? sessionId;
  if (!resolvedSessionId) {
    await context.repository.updateChatStatus(context.chat.id, "failed");
    return errorResponse("Eve response did not include a session id", 502);
  }

  const isContinuing = currentSession?.sessionId === resolvedSessionId;
  const nextSession: SessionState = {
    sessionId: resolvedSessionId,
    streamIndex: isContinuing ? (currentSession?.streamIndex ?? 0) : 0,
  };
  if (!isContinuing) {
    // Batches belong to a session; none survive its replacement.
    await context.repository
      .updatePendingInput(context.chat.id, () => EMPTY_PENDING_INPUT)
      .catch((error: unknown) => {
        console.error(`Failed to clear pending input for ${context.chat.id}:`, error);
      });
  }
  await context.repository.updateChatSessionState(context.chat.id, nextSession, "active");
  await context.repository.clearPendingUserMessage(context.chat.id);
  await recordInputResponses(context, body);

  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  headers.set("x-eve-session-id", resolvedSessionId);
  return new Response(JSON.stringify(withoutContinuationToken(payload)), {
    status: remote.status,
    headers,
  });
}

/**
 * Records the answers a turn carried: a `client.input.responded` event so a
 * replay can show them, and a ledger settle so the answered batch stops
 * reading as open. This is the only point that observes Eve accepting a turn
 * — the acceptance signal the browser never gets.
 *
 * The Agent accepted the turn by the time this runs, so failing the request
 * over the record would cost more than losing it: the batch re-offers and a
 * re-answer degrades to Eve's stale-response handling.
 */
async function recordInputResponses(
  context: ProxyContext,
  body: Record<string, unknown>,
): Promise<void> {
  const responses = readInputResponses(body);
  if (responses.length === 0) {
    return;
  }

  const event = inputRespondedEvent(responses, Date.now());
  try {
    await context.repository.appendEvent({
      chatId: context.chat.id,
      type: event.type,
      payload: event,
    });
  } catch (error) {
    console.error(`Failed to record input responses for ${context.chat.id}:`, error);
  }
  try {
    await context.repository.updatePendingInput(context.chat.id, (current) =>
      // A legacy chat keeps its NULL marker; the recorded event above feeds
      // the later derivation instead.
      current === null ? null : settlePendingInput(current, responses),
    );
  } catch (error) {
    console.error(`Failed to settle pending input for ${context.chat.id}:`, error);
  }
}

async function postTurn(
  context: ProxyContext,
  sessionId: string | undefined,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  const path = sessionId
    ? `/eve/v1/session/${encodeURIComponent(sessionId)}`
    : "/eve/v1/session";
  return context.client.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

async function resolveProxyContext(
  request: Request,
  chatId: string,
): Promise<ProxyContext | Response> {
  const resolved = await resolveProxyChat(request, chatId);
  if (resolved instanceof Response) {
    return resolved;
  }
  const { chat, repository, callerToken } = resolved;

  const agent = await repository.getAgentConnection(chat.agentConnectionId);
  if (!agent) {
    return errorResponse("Agent connection not found", 404);
  }
  if (agent.evelandProjectId !== chat.evelandProjectId) {
    return errorResponse("Chat not found", 404);
  }
  if (agent.status === "unreachable") {
    return errorResponse("Agent connection is unreachable", 409);
  }

  try {
    return {
      chat,
      repository,
      client: createEveClientForConnection(agent, callerToken),
      // Any credential may authenticate a principal: a custom header is
      // opaque to Dawn but not to the Agent's auth function, which can
      // resolve it exactly like a bearer token. Only the browser session
      // alone reaches Eve as an anonymous principal, and Eve refuses an
      // operationId from one — a refusal `rejectsOperationId` falls back on
      // when a credential turns out not to authenticate anything either.
      ...((callerToken || agent.authType !== "none")
        ? { sessionCreateOperationId: createSessionOperationId(chat.id) }
        : {}),
    };
  } catch {
    return errorResponse("Agent authentication configuration is invalid", 500);
  }
}

/**
 * Whether a failed request leaves the Agent's side of it unknown. Only a
 * refusal the Agent issued itself proves nothing was created; a 5xx or a
 * request timeout can arrive after Eve has already persisted the workflow.
 */
function isAmbiguousFailureStatus(status: number): boolean {
  return status >= 500 || status === 408;
}

/**
 * Eve's own refusal to accept an `operationId` from the principal it resolved:
 * `operationId requires an authenticated principal.` A reworded refusal stops
 * matching and surfaces as the deterministic 400 it is, which loses the
 * fallback without risking a second session.
 */
async function rejectsOperationId(
  response: Response,
  body: Record<string, unknown>,
): Promise<boolean> {
  if (response.status !== 400 || body.operationId === undefined) {
    return false;
  }
  try {
    const value = (await response.clone().json()) as unknown;
    const error =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as { error?: unknown }).error
        : undefined;
    if (typeof error !== "string") return false;
    const message = error.toLowerCase();
    return message.includes("operationid") && message.includes("authenticated principal");
  } catch {
    return false;
  }
}

function createSessionOperationId(chatId: string): string {
  const digest = createHash("sha256")
    .update("dawnchat:create-session:v1\0")
    .update(chatId)
    .digest("hex");
  return `dawnchat-create-${digest}`;
}

/**
 * Resolves the chat a request may act on, honouring every credential the chat
 * routes accept: the anonymous browser session, an App Token, and a Caller
 * Token issued after an Eveland challenge. Routes that only read chat data
 * (the pending-input ledger) share this so a Caller Token client is not
 * locked out of reconciliation.
 */
export async function resolveProxyChat(
  request: Request,
  chatId: string,
): Promise<{ chat: Chat; repository: Repository; callerToken?: string } | Response> {
  const repository = createRepository(getDbClient());
  const candidate = await repository.getChat(chatId);
  if (!candidate) {
    return errorResponse("Chat not found", 404);
  }

  let chat: Chat | null = null;
  let callerToken: string | undefined;
  try {
    const authorization = request.headers.get("authorization");
    const browserSession = resolveAppBrowserSession(request);
    const clientChat = await repository.getChatForClient(
      chatId,
      browserSession.clientId,
    );
    chat = clientChat;

    if (authorization) {
      let appIdentity;
      try {
        appIdentity = await getCallerTokenVerifier().verifyAppAuthorization(
          authorization,
          process.env.NEXT_PUBLIC_EVELAND_IDENTITY_RETURN_TARGET ?? "eve-chats",
        );
      } catch (appError) {
        if (!candidate.evelandProjectId) throw appError;
        const identity = await getCallerTokenVerifier().verifyAuthorization(
          authorization,
          candidate.evelandProjectId,
        );
        if (
          candidate.ownerIdentityIssuer &&
          candidate.ownerIdentityIssuer !== identity.issuer
        ) {
          return errorResponse("Chat not found", 404);
        }
        const candidateAgent = await repository.getAgentConnection(
          candidate.agentConnectionId,
        );
        if (candidateAgent?.source === "managed") {
          if (!identity.agentUrl) {
            return errorResponse(
              "Caller Token is not bound to a Catalog endpoint",
              409,
            );
          }
          if (identity.agentUrl !== candidateAgent.baseUrl) {
            await repository.upsertCatalogAgent({
              identityIssuer: identity.issuer,
              evelandProjectId: identity.projectId,
              name: candidateAgent.name,
              description: candidateAgent.description,
              baseUrl: identity.agentUrl,
            });
          }
        }
        chat =
          clientChat ??
          (await repository.getChatForIdentity(chatId, {
            principalId: identity.principalId,
            realmId: identity.realmId,
            projectId: identity.projectId,
          }));
        callerToken = authorization.startsWith("Bearer ")
          ? authorization.slice("Bearer ".length)
          : "";
      }
      if (appIdentity) {
        chat =
          clientChat ??
          (await repository.getChatForAppIdentity(chatId, {
            issuer: appIdentity.issuer,
            principalId: appIdentity.principalId,
            realmId: appIdentity.realmId,
          }));
      }
    } else if (!clientChat) {
      await getCallerTokenVerifier().verifyAppAuthorization(
        null,
        process.env.NEXT_PUBLIC_EVELAND_IDENTITY_RETURN_TARGET ?? "eve-chats",
      );
    }
  } catch (error) {
    if (error instanceof CallerTokenError) return callerTokenErrorResponse(error);
    return errorResponse("Unable to verify Eveland identity", 503);
  }
  if (!chat) {
    return errorResponse("Chat not found", 404);
  }

  return { chat, repository, callerToken };
}

function createPersistedEventStream(input: {
  abort: AbortController;
  chat: Chat;
  first: IteratorResult<MessageStreamEvent>;
  iterator: AsyncIterator<MessageStreamEvent>;
  repository: Repository;
  session: SessionState;
  sessionId: string;
  startIndex: number;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let buffered: IteratorResult<MessageStreamEvent> | null = input.first;
  let nextStreamIndex = input.startIndex;
  let latestCursor = input.session.streamIndex ?? 0;
  let currentSession: SessionState = input.session;

  const persistEvent = async (
    event: MessageStreamEvent,
  ): Promise<{ event: MessageStreamEvent; terminal: boolean }> => {
    const browserEvent = redactWaitingContinuationToken(event, input.sessionId);
    const eventStreamIndex = nextStreamIndex;
    nextStreamIndex += 1;
    latestCursor = Math.max(latestCursor, nextStreamIndex);
    currentSession = {
      ...currentSession,
      streamIndex: latestCursor,
    };

    // Incremental text, reasoning, and tool-input events are renderer traffic,
    // not domain events. Completed text/reasoning or the validated
    // `actions.requested` call supersedes each run, and a resume replays the
    // missing deltas from Eve by cursor. Deltas are forwarded and counted in
    // the cursor, never persisted — the next stored event carries the cursor
    // they advanced. A crash inside a delta run leaves the stored cursor behind
    // the stream; the reconnect replays the gap and the (session, stream index)
    // key absorbs rows it already has.
    if (STREAM_DELTA_EVENT_TYPES.has(browserEvent.type)) {
      return { event: browserEvent, terminal: false };
    }

    const status = chatStatusFromEvent(event);
    await input.repository.appendEvent({
      chatId: input.chat.id,
      sessionId: input.sessionId,
      streamIndex: eventStreamIndex,
      type: browserEvent.type,
      payload: browserEvent,
      pendingInput: pendingInputTransition(browserEvent),
      sessionState: { state: currentSession, ...(status ? { status } : {}) },
    });
    const errorId = sessionFailureErrorId(browserEvent);
    if (errorId) {
      console.error("Eve agent session failed", {
        chatId: input.chat.id,
        sessionId: input.sessionId,
        errorId,
      });
    }
    return { event: browserEvent, terminal: status !== undefined };
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = buffered ?? (await input.iterator.next());
        buffered = null;
        if (next.done) {
          controller.close();
          return;
        }

        const persisted = await persistEvent(next.value);
        controller.enqueue(encoder.encode(`${JSON.stringify(persisted.event)}\n`));
        if (persisted.terminal) {
          input.abort.abort();
          void input.iterator.return?.();
          controller.close();
        }
      } catch (error) {
        if (input.abort.signal.aborted) {
          controller.close();
        } else {
          controller.error(error);
        }
      }
    },
    cancel() {
      input.abort.abort();
      void input.iterator.return?.();
    },
  });
}

/**
 * The ledger transition an event carries. An `input.requested` opens its batch
 * under the turn that raised it; `input.resolved` marks every terminal HITL
 * outcome from any channel. A terminal session closes every park; a cancelled
 * turn closes only the parks that turn owns, while other batches stay parked
 * and answerable.
 * Turn boundaries deliberately map to nothing — Eve emits them without
 * resolving anything (a re-parked required batch), so only real teardown
 * events clear.
 */
function pendingInputTransition(
  event: MessageStreamEvent,
):
  | { open: PendingInputRequest[]; turnId?: string }
  | { clear: true }
  | { clearTurn: string }
  | { settle: string[] }
  | undefined {
  if (event.type === "input.requested") {
    const requests = pendingRequestsFromEvent(event);
    if (!requests) return undefined;
    const turnId = turnIdFromEvent(event);
    return { open: requests, ...(turnId ? { turnId } : {}) };
  }
  if (event.type === "input.resolved") {
    const requestIds = resolvedInputRequestIds(event);
    return requestIds.length > 0 ? { settle: requestIds } : undefined;
  }
  if (event.type === "turn.cancelled") {
    const turnId = turnIdFromEvent(event);
    // A cancel that names no turn is unattributable; keeping every batch is
    // the recoverable direction (see `clearPendingBatchesForTurn`).
    return turnId ? { clearTurn: turnId } : undefined;
  }
  if (event.type === "session.completed" || event.type === "session.failed") {
    return { clear: true };
  }
  return undefined;
}

/**
 * Eve's `session.waiting` continuation token is a channel-local capability.
 * It stays server-side; the browser and durable history receive the public
 * session ID in its place.
 */
function redactWaitingContinuationToken(
  event: MessageStreamEvent,
  sessionId: string,
): MessageStreamEvent {
  if (event.type !== "session.waiting") return event;
  const data = event.data as unknown;
  const safeData =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  return {
    ...event,
    data: { ...withoutContinuationToken(safeData), continuationToken: sessionId },
  } as MessageStreamEvent;
}

function chatStatusFromEvent(event: MessageStreamEvent): Chat["status"] | undefined {
  if (event.type === "session.waiting") return "active";
  if (event.type === "session.completed") return "completed";
  if (event.type === "session.failed") return "failed";
  return undefined;
}

function parseStartIndex(value: string | null): number | null {
  if (value === null || value === "") return 0;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function readObjectBody(request: Request): Promise<Record<string, unknown> | Response> {
  try {
    const value = (await request.json()) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : errorResponse("Invalid Eve request body", 400);
  } catch {
    return errorResponse("Invalid JSON", 400);
  }
}

async function readOptionalObjectBody(
  request: Request,
): Promise<Record<string, unknown> | Response> {
  const text = await request.text();
  if (!text.trim()) {
    return {};
  }
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : errorResponse("Invalid Eve request body", 400);
  } catch {
    return errorResponse("Invalid JSON", 400);
  }
}

async function readResponseObject(response: Response): Promise<Record<string, unknown> | Response> {
  try {
    const value = (await response.json()) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : errorResponse("Eve returned an invalid response", 502);
  } catch {
    return errorResponse("Eve returned an invalid response", 502);
  }
}

async function forwardErrorResponse(response: Response, chatId: string): Promise<Response> {
  const body = await response.text();
  const forwarded = prepareEveError(body);
  if (response.status !== 401) {
    console.error("Eve agent request failed", {
      chatId,
      status: response.status,
      ...(forwarded.errorId ? { errorId: forwarded.errorId } : {}),
    });
  }
  const headers = new Headers();
  for (const name of ["cache-control", "content-type", "www-authenticate"]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(forwarded.body || JSON.stringify({ error: "Eve request failed" }), {
    status: response.status,
    headers,
  });
}

function prepareEveError(body: string): { body: string; errorId?: string } {
  try {
    const value = JSON.parse(body) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return { body };
    const errorBody = value as Record<string, unknown>;
    const errorId = readEveErrorId(errorBody.errorId);
    if (!errorId) return { body };
    const message =
      typeof errorBody.error === "string" && errorBody.error.trim()
        ? errorBody.error.trim()
        : "Eve request failed.";
    return {
      body: JSON.stringify({
        ...errorBody,
        error: formatEveErrorMessage(message, errorId),
      }),
      errorId,
    };
  } catch {
    return { body };
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function errorResponse(error: string, status: number): Response {
  return Response.json({ error }, { status });
}
