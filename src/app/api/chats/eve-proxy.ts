import { clearInterval, setInterval, setTimeout as setNodeTimeout, clearTimeout } from "node:timers";

import type { HandleMessageStreamEvent } from "eve/client";

import { resolveAppBrowserSession } from "@/app-session";
import {
  createRepository,
  type Chat,
  type Repository,
  type SessionState,
} from "@/db/repository";
import { getDbClient } from "@/db/provider";
import { createEveClientForConnection } from "@/eve/client";
import { EVE_PROXY_CONTINUATION_TOKEN } from "@/eve/proxy-contract";
import {
  CallerTokenError,
  callerTokenErrorResponse,
  getCallerTokenVerifier,
} from "@/identity/server";

const NDJSON_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";

/**
 * How long a `running` turn keeps blocking the next one. An attached stream
 * renews the lease on a timer, so the lease tracks whether anyone is observing
 * the turn rather than how talkative the agent is: a turn whose reader vanished
 * (crashed request, killed server) stops renewing and the chat becomes usable
 * again on its own, while a turn that is merely silent — a long tool call, a
 * subagent, a compaction — keeps its lease for as long as it is watched.
 */
const RUNNING_TURN_LEASE_MS = 30_000;
const RUNNING_TURN_RENEW_MS = 10_000;

/**
 * How long a cancel waits for the agent to confirm on the stream. eve always
 * follows `turn.cancelled` with `session.waiting`, and that boundary carries the
 * continuation token the next turn has to use, so it is worth a short wait.
 */
const CANCELLED_TURN_DRAIN_MS = 3_000;

const TURN_BOUNDARIES = {
  "session.waiting": { status: "active", turnState: "waiting" },
  "session.completed": { status: "completed", turnState: "completed" },
  "session.failed": { status: "failed", turnState: "failed" },
} as const;

/**
 * Events that suspend a turn without ending it. eve durably parks a turn while
 * it waits for an OAuth callback or a pending input batch; the authorization
 * park emits no `session.*` boundary at all, so a stream that ends there has not
 * crashed — it is waiting on the user, and failing the chat would abandon a turn
 * that is still resumable.
 */
const TURN_PARK_EVENTS: Record<string, TurnState | undefined> = {
  "authorization.required": "parked",
  "input.requested": "parked",
  "authorization.completed": "running",
};

type ProxyContext = {
  chat: Chat;
  repository: Repository;
  client: ReturnType<typeof createEveClientForConnection>;
};

type TurnState = NonNullable<SessionState["turnState"]>;

export async function proxyCreateEveSession(request: Request, chatId: string): Promise<Response> {
  const resolved = await resolveProxyContext(request, chatId);
  if (resolved instanceof Response) {
    return resolved;
  }

  if (resolved.chat.status === "completed") {
    return errorResponse("Chat is completed", 409);
  }
  const activeSessionId = resolved.chat.sessionState?.sessionId;
  // The browser client resets its own session cursor whenever a turn ends without
  // a boundary event, so it reissues a create for what is really the next turn on
  // the session eve-chats still holds.
  if (resolved.chat.status === "active" && activeSessionId) {
    return proxyTurnRequest(request, resolved, activeSessionId);
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
  if (resolved.chat.status === "failed") {
    return proxyTurnRequest(request, resolved);
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
    const result = await resolved.client
      .session({
        sessionId,
        continuationToken: session.continuationToken,
        streamIndex: session.streamIndex ?? 0,
      })
      .cancel(turnId ? { turnId } : undefined);
    // The browser stops its own stream before cancelling, so nothing is left to
    // persist the boundary event for the turn the agent just gave up on.
    await settleCancelledTurn(resolved);
    return Response.json(result, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return errorResponse("Unable to cancel the Eve turn", 502);
  }
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
  const turnState = await resolvePersistedTurnState(resolved);

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
  const iterator = resolved.client
    .session({
      sessionId,
      continuationToken: session.continuationToken,
      streamIndex: parsedStartIndex,
    })
    .stream({ startIndex: parsedStartIndex, signal: abort.signal })
    [Symbol.asyncIterator]();
  let first: IteratorResult<HandleMessageStreamEvent>;
  try {
    first = await iterator.next();
  } catch {
    if (abort.signal.aborted) {
      await releaseRunningTurn(resolved.repository, resolved.chat.id, session, turnState);
    } else {
      await failRunningTurn(resolved.repository, resolved.chat.id, session, turnState);
    }
    abort.abort();
    void iterator.return?.();
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
    turnState,
  });
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": NDJSON_CONTENT_TYPE,
  });

  return new Response(persisted, { status: 200, headers });
}

async function proxyTurnRequest(
  request: Request,
  initialContext: ProxyContext,
  sessionId?: string,
): Promise<Response> {
  const input = await readObjectBody(request);
  if (input instanceof Response) {
    return input;
  }

  let context = initialContext;
  const body: Record<string, unknown> = { ...input };
  delete body.continuationToken;
  let currentSession = context.chat.sessionState;
  let releasedSession: SessionState | null = null;
  let claimedSession: SessionState | null = null;
  if (sessionId && currentSession) {
    const claim = await claimTurn(context);
    if (claim instanceof Response) {
      return claim;
    }
    context = claim.context;
    currentSession = claim.claimed;
    releasedSession = claim.released;
    claimedSession = claim.claimed;
  }
  if (sessionId && currentSession?.continuationToken) {
    body.continuationToken = currentSession.continuationToken;
  }

  const path = sessionId
    ? `/eve/v1/session/${encodeURIComponent(sessionId)}`
    : "/eve/v1/session";
  let remote: Response;
  try {
    remote = await context.client.fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: request.signal,
    });
  } catch {
    await failTurnRequest(context, claimedSession);
    return errorResponse("Unable to reach Eve agent", 502);
  }

  if (!remote.ok) {
    if (remote.status === 401 && claimedSession && releasedSession) {
      await context.repository.transitionChatSessionState(
        context.chat.id,
        claimedSession,
        releasedSession,
        "active",
      );
    } else if (remote.status !== 401) {
      await failTurnRequest(context, claimedSession);
    }
    return forwardErrorResponse(remote);
  }

  const payload = await readResponseObject(remote);
  if (payload instanceof Response) {
    await failTurnRequest(context, claimedSession);
    return payload;
  }

  const resolvedSessionId =
    stringValue(payload.sessionId) ?? remote.headers.get("x-eve-session-id")?.trim() ?? sessionId;
  if (!resolvedSessionId) {
    await failTurnRequest(context, claimedSession);
    return errorResponse("Eve response did not include a session id", 502);
  }

  const isContinuing = currentSession?.sessionId === resolvedSessionId;
  const nextSession: SessionState = {
    sessionId: resolvedSessionId,
    continuationToken:
      stringValue(payload.continuationToken) ??
      (isContinuing ? currentSession?.continuationToken : undefined),
    streamIndex: isContinuing ? (currentSession?.streamIndex ?? 0) : 0,
    turnGeneration: isContinuing ? (currentSession?.turnGeneration ?? 0) : 1,
    turnState: "running",
  };
  // The agent has accepted the turn, so the stored state has to reflect it even
  // if the compare-and-set lost: dropping the fresh continuation token here would
  // leave the chat pointing at a turn nobody can continue or stream. Only a
  // brand-new session may also force the status back to `active` — reviving a
  // chat the agent has already settled is not this write's business.
  const transitioned =
    isContinuing && currentSession
      ? await context.repository.transitionChatSessionState(
          context.chat.id,
          currentSession,
          nextSession,
          "active",
        )
      : null;
  if (!transitioned) {
    await context.repository.updateChatSessionState(
      context.chat.id,
      nextSession,
      isContinuing ? undefined : "active",
    );
  }
  await context.repository.clearPendingUserMessage(context.chat.id);

  return eveSessionResponse(payload, remote.status, resolvedSessionId);
}

async function resolveProxyContext(
  request: Request,
  chatId: string,
): Promise<ProxyContext | Response> {
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
    };
  } catch {
    return errorResponse("Agent authentication configuration is invalid", 500);
  }
}

function createPersistedEventStream(input: {
  abort: AbortController;
  chat: Chat;
  first: IteratorResult<HandleMessageStreamEvent>;
  iterator: AsyncIterator<HandleMessageStreamEvent>;
  repository: Repository;
  session: SessionState;
  sessionId: string;
  startIndex: number;
  turnState: TurnState;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let buffered: IteratorResult<HandleMessageStreamEvent> | null = input.first;
  let nextStreamIndex = input.startIndex;
  const replayCursor = input.session.streamIndex ?? 0;
  let currentSession = input.session;
  let currentTurnState = input.turnState;

  // An attached stream holds the turn's lease even while the agent is silent, so
  // a long tool call cannot be mistaken for an abandoned turn. The renewal is a
  // no-op compare-and-set: it only bumps `updatedAt`, and it stops mattering the
  // moment a newer turn owns the session.
  const renewal = setInterval(() => {
    if (currentTurnState !== "running") return;
    void input.repository
      .transitionChatSessionState(input.chat.id, currentSession, currentSession)
      .catch(() => undefined);
  }, RUNNING_TURN_RENEW_MS);
  renewal.unref();
  const stopRenewal = (): void => clearInterval(renewal);

  const persistEvent = async (
    event: HandleMessageStreamEvent,
  ): Promise<{ event: HandleMessageStreamEvent; terminal: boolean } | null> => {
    const eventIndex = nextStreamIndex;
    nextStreamIndex += 1;
    // A client whose cursor was reset replays the whole session, so anything
    // below the persisted cursor belongs to a turn that already ended. It is
    // still forwarded to the client that asked for it, but it must not move the
    // session state or end the stream: doing either would strand the turn that
    // is actually running.
    if (eventIndex < replayCursor) {
      const browserEvent = replaceWaitingContinuationToken(event);
      await input.repository.appendEvent({
        chatId: input.chat.id,
        sessionId: input.sessionId,
        streamIndex: eventIndex,
        type: browserEvent.type,
        payload: browserEvent,
      });
      return { event: browserEvent, terminal: false };
    }

    const persisted = await persistTurnEvent({
      repository: input.repository,
      chatId: input.chat.id,
      sessionId: input.sessionId,
      streamIndex: eventIndex,
      event,
      session: currentSession,
      turnState: currentTurnState,
    });
    if (persisted === null) return null;
    currentSession = persisted.session;
    currentTurnState = persisted.turnState;
    return { event: persisted.browserEvent, terminal: persisted.terminal };
  };

  const release = (): Promise<void> =>
    releaseRunningTurn(input.repository, input.chat.id, currentSession, currentTurnState);

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = buffered ?? (await input.iterator.next());
        buffered = null;
        if (next.done) {
          stopRenewal();
          if (input.abort.signal.aborted) {
            await release();
          } else {
            await failRunningTurn(
              input.repository,
              input.chat.id,
              currentSession,
              currentTurnState,
            );
          }
          controller.close();
          return;
        }

        const persisted = await persistEvent(next.value);
        if (!persisted) {
          stopRenewal();
          input.abort.abort();
          void input.iterator.return?.();
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`${JSON.stringify(persisted.event)}\n`));
        if (persisted.terminal) {
          stopRenewal();
          input.abort.abort();
          void input.iterator.return?.();
          controller.close();
        }
      } catch (error) {
        stopRenewal();
        if (input.abort.signal.aborted) {
          await release();
          controller.close();
        } else {
          await failRunningTurn(
            input.repository,
            input.chat.id,
            currentSession,
            currentTurnState,
          );
          controller.error(error);
        }
      }
    },
    async cancel() {
      stopRenewal();
      input.abort.abort();
      void input.iterator.return?.();
      await release();
    },
  });
}

function waitingContinuationToken(event: HandleMessageStreamEvent): string | undefined {
  if (event.type !== "session.waiting") return undefined;
  const data = event.data as unknown;
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  return stringValue((data as Record<string, unknown>).continuationToken);
}

function replaceWaitingContinuationToken(
  event: HandleMessageStreamEvent,
): HandleMessageStreamEvent {
  if (event.type !== "session.waiting") return event;
  const data = event.data as unknown;
  const safeData = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  return {
    ...event,
    data: { ...safeData, continuationToken: EVE_PROXY_CONTINUATION_TOKEN },
  } as HandleMessageStreamEvent;
}

function turnBoundary(
  type: string,
): { status: Chat["status"]; turnState: TurnState } | undefined {
  return TURN_BOUNDARIES[type as keyof typeof TURN_BOUNDARIES];
}

function turnStateFromEvent(type: string): TurnState | undefined {
  return turnBoundary(type)?.turnState ?? TURN_PARK_EVENTS[type];
}

/**
 * Takes ownership of the next turn on a session that already has one. A lost
 * compare-and-set means another writer settled the previous turn in the same
 * instant rather than that a turn is live, so the claim is re-read and retried
 * once instead of being reported to the user.
 */
async function claimTurn(
  initialContext: ProxyContext,
): Promise<{ context: ProxyContext; released: SessionState; claimed: SessionState } | Response> {
  let context = initialContext;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const released = context.chat.sessionState;
    if (!released) {
      return errorResponse("Eve session is no longer available for this chat", 409);
    }
    if (await hasLiveTurn(context)) {
      return errorResponse("Eve is still working on the previous message", 409);
    }

    const claimed: SessionState = {
      ...released,
      turnGeneration: (released.turnGeneration ?? 0) + 1,
      turnState: "running",
    };
    const claimedChat = await context.repository.transitionChatSessionState(
      context.chat.id,
      released,
      claimed,
      "active",
    );
    if (claimedChat) {
      return { context: { ...context, chat: claimedChat }, released, claimed };
    }

    const refreshed = await context.repository.getChat(context.chat.id);
    if (!refreshed) {
      return errorResponse("Chat not found", 404);
    }
    context = { ...context, chat: refreshed };
  }

  return errorResponse("Eve is still working on the previous message", 409);
}

type PersistedTurnEvent = {
  browserEvent: HandleMessageStreamEvent;
  session: SessionState;
  turnState: TurnState;
  terminal: boolean;
};

/**
 * Appends one live event and advances the session through a compare-and-set.
 * Returns null when a newer turn owns the session, in which case the caller has
 * to stop: writing its own cursor would stomp the turn that replaced it.
 */
async function persistTurnEvent(input: {
  repository: Repository;
  chatId: string;
  sessionId: string;
  streamIndex: number;
  event: HandleMessageStreamEvent;
  session: SessionState;
  turnState: TurnState;
}): Promise<PersistedTurnEvent | null> {
  const browserEvent = replaceWaitingContinuationToken(input.event);
  await input.repository.appendEvent({
    chatId: input.chatId,
    sessionId: input.sessionId,
    streamIndex: input.streamIndex,
    type: browserEvent.type,
    payload: browserEvent,
  });

  const continuationToken = waitingContinuationToken(input.event);
  const boundary = turnBoundary(input.event.type);
  const nextSession: SessionState = {
    ...input.session,
    ...(continuationToken ? { continuationToken } : {}),
    streamIndex: Math.max(input.session.streamIndex ?? 0, input.streamIndex + 1),
    turnGeneration: input.session.turnGeneration ?? 0,
    turnState: turnStateFromEvent(input.event.type) ?? input.turnState,
  };
  const updated = await input.repository.transitionChatSessionState(
    input.chatId,
    input.session,
    nextSession,
    boundary?.status,
  );
  if (!updated) return null;

  return {
    browserEvent,
    session: nextSession,
    turnState: nextSession.turnState ?? input.turnState,
    terminal: boundary !== undefined,
  };
}

/**
 * Whether a turn is running *and* still being observed. An unobserved `running`
 * turn is claimable: nothing re-attaches to a stream on its own, so refusing new
 * turns forever would be the wedge this state exists to prevent.
 */
async function hasLiveTurn(context: ProxyContext): Promise<boolean> {
  if ((await resolvePersistedTurnState(context)) !== "running") return false;
  return Date.now() - context.chat.updatedAt.getTime() < RUNNING_TURN_LEASE_MS;
}

async function resolvePersistedTurnState(context: ProxyContext): Promise<TurnState> {
  const session = context.chat.sessionState;
  if (session?.turnState) return session.turnState;

  if (session) {
    const latest = await context.repository.getLatestSessionEvent(
      context.chat.id,
      session.sessionId,
    );
    const resolved = latest ? turnStateFromEvent(latest.type) : undefined;
    if (resolved) return resolved;
  }
  return context.chat.status === "active" ? "running" : context.chat.status;
}

async function failRunningTurn(
  repository: Repository,
  chatId: string,
  session: SessionState,
  turnState: TurnState,
): Promise<void> {
  await settleRunningTurn(repository, chatId, session, turnState, {
    turnState: "failed",
    status: "failed",
  });
}

/**
 * Hands a turn back without claiming to know how it ended. The agent may still be
 * working on it, so the chat stays active and only stops blocking the next turn.
 */
async function releaseRunningTurn(
  repository: Repository,
  chatId: string,
  session: SessionState,
  turnState: TurnState,
): Promise<void> {
  await settleRunningTurn(repository, chatId, session, turnState, { turnState: "detached" });
}

async function settleRunningTurn(
  repository: Repository,
  chatId: string,
  session: SessionState,
  turnState: TurnState,
  settled: { turnState: TurnState; status?: Chat["status"] },
): Promise<void> {
  if (turnState !== "running") return;
  await repository.transitionChatSessionState(
    chatId,
    session,
    {
      ...session,
      turnGeneration: session.turnGeneration ?? 0,
      turnState: settled.turnState,
    },
    settled.status,
  );
}

/**
 * Settles the session after the agent accepted a cancel. eve confirms on the
 * stream with `turn.cancelled` followed by `session.waiting`, and that boundary
 * carries the continuation token the next turn needs, so the confirmation is
 * drained first and parking is only the fallback for when it does not arrive.
 */
async function settleCancelledTurn(context: ProxyContext): Promise<void> {
  const refreshed = await context.repository.getChat(context.chat.id);
  const session = refreshed?.sessionState;
  if (!refreshed || !session) return;

  const current = { ...context, chat: refreshed };
  // Stop pressed on a turn that had already settled has nothing to confirm, and
  // an agent that holds its stream open would make waiting for it cost the full
  // deadline.
  const turnState = await resolvePersistedTurnState(current);
  if (turnState !== "running" && turnState !== "detached") return;

  const drained = await drainCancelledTurn(current, session);
  if (drained.settled) return;
  // A drain that stopped early still advanced the session, so parking has to
  // compare against where it left off rather than where it started.
  await parkCancelledTurn(current, drained.session);
}

async function drainCancelledTurn(
  context: ProxyContext,
  session: SessionState,
): Promise<{ settled: boolean; session: SessionState }> {
  const abort = new AbortController();
  const deadline = setNodeTimeout(() => abort.abort(), CANCELLED_TURN_DRAIN_MS);
  deadline.unref();
  let iterator: AsyncIterator<HandleMessageStreamEvent> | undefined;
  let streamIndex = session.streamIndex ?? 0;
  let currentSession = session;

  try {
    let turnState = await resolvePersistedTurnState(context);
    iterator = context.client
      .session({
        sessionId: currentSession.sessionId,
        continuationToken: currentSession.continuationToken,
        streamIndex,
      })
      .stream({ startIndex: streamIndex, signal: abort.signal })
      [Symbol.asyncIterator]();

    for (;;) {
      const next = await iterator.next();
      if (next.done) return { settled: false, session: currentSession };

      const persisted = await persistTurnEvent({
        repository: context.repository,
        chatId: context.chat.id,
        sessionId: currentSession.sessionId,
        streamIndex,
        event: next.value,
        session: currentSession,
        turnState,
      });
      // A newer turn owns the session, so it already decides what happens next.
      if (persisted === null) return { settled: true, session: currentSession };

      streamIndex += 1;
      currentSession = persisted.session;
      turnState = persisted.turnState;
      if (persisted.terminal) return { settled: true, session: currentSession };
    }
  } catch {
    return { settled: false, session: currentSession };
  } finally {
    clearTimeout(deadline);
    abort.abort();
    void iterator?.return?.();
  }
}

async function parkCancelledTurn(
  context: ProxyContext,
  session: SessionState,
): Promise<void> {
  const turnState = await resolvePersistedTurnState(context);
  if (turnState !== "running" && turnState !== "detached") return;
  await context.repository.transitionChatSessionState(
    context.chat.id,
    session,
    {
      ...session,
      turnGeneration: session.turnGeneration ?? 0,
      turnState: "waiting",
    },
    "active",
  );
}

async function failTurnRequest(
  context: ProxyContext,
  claimedSession: SessionState | null,
): Promise<void> {
  if (claimedSession) {
    await failRunningTurn(context.repository, context.chat.id, claimedSession, "running");
    return;
  }
  await context.repository.updateChatStatus(context.chat.id, "failed");
}

function eveSessionResponse(
  payload: Record<string, unknown>,
  status: number,
  sessionId: string,
): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  headers.set("x-eve-session-id", sessionId);
  return new Response(
    JSON.stringify({ ...payload, continuationToken: EVE_PROXY_CONTINUATION_TOKEN }),
    { status, headers },
  );
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

async function forwardErrorResponse(response: Response): Promise<Response> {
  const body = await response.text();
  const headers = new Headers();
  for (const name of ["cache-control", "content-type", "www-authenticate"]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(body || JSON.stringify({ error: "Eve request failed" }), {
    status: response.status,
    headers,
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function errorResponse(error: string, status: number): Response {
  return Response.json({ error }, { status });
}
