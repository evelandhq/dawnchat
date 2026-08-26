"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UserContent } from "ai";
import {
  ClientError,
  type ClientSessionState,
  type InputResponse,
  type MessageStreamEvent,
  type PrepareSend,
} from "eve/client";
import {
  type EveMessage,
  type EveMessagePart,
  useEveAgent,
} from "eve/react";
import { AlertCircleIcon, MessageCircleIcon } from "lucide-react";
import { nanoid } from "nanoid";

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  PromptInput,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import {
  ChatAttachmentButton,
  ChatComposerAttachments,
} from "@/components/chat-composer-attachments";
import {
  ChatSteerQueue,
  type QueuedTurn,
} from "@/components/chat-steer-queue";
import { EveMessageView, type InputRequestBatch } from "@/components/eve-message";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  formatEveErrorMessage,
  sessionFailureErrorId,
} from "@/eve/error-observability";
import {
  isRequiredKind,
  pendingRequestsFromEvent,
  resolvedInputRequestIds,
  type ChatEvent,
  type PendingInputRequest,
  type PendingInputState,
} from "@/eve/proxy-contract";
import {
  CHAT_ATTACHMENT_MAX_FILES,
  CHAT_ATTACHMENT_MAX_FILE_SIZE,
  promptMessageToUserContent,
} from "@/lib/chat-messages";

/** One outbound turn: a user message, or a reply to pending HITL requests. */
type TurnPayload = Parameters<PrepareSend>[0];

type UpdateQueuedTurns = (
  update: (current: QueuedTurn[]) => QueuedTurn[],
) => void;

/**
 * Eve 0.42–0.44 send messages with `turnPolicy: "steer"` by default. Dawn uses
 * queue for ordinary turns, including the local FIFO above the composer, and
 * opts into steer only when the user presses that queued message's Steer
 * action. A racing second tab therefore still waits instead of destroying the
 * running turn.
 */
const TURN_POLICY = "queue" as const;

export type ChatThreadSummary = {
  id: string;
  agentConnectionId: string;
  agentName: string;
  title: string;
  status: "active" | "completed" | "failed";
  sessionState: ClientSessionState | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * One input batch as this client tracks it. The proxy's ledger is the
 * authority on which batches Eve is parked on; the client seeds from it,
 * appends batches from live `input.requested` events, closes optimistically
 * on `respond()`, and refetches the ledger whenever a send may have failed or
 * another actor may have settled one.
 */
type ClientPendingBatch = {
  key: string;
  requests: PendingInputRequest[];
  answered: ReadonlySet<string>;
};

function batchesFromState(state: PendingInputState): ClientPendingBatch[] {
  return state.batches
    .filter((batch) => batch.requests.length > 0)
    .map((batch) => ({
      key: batch.requests[0]!.requestId,
      requests: batch.requests,
      answered: new Set(batch.answered),
    }));
}

type ChatThreadProps = {
  chat: ChatThreadSummary;
  events: ChatEvent[];
  pendingInput: PendingInputState;
  pendingUserMessage?: UserContent | null;
  getAccessToken?: () => Promise<string>;
  getCallerToken?: () => Promise<string>;
  respondToAuthenticationChallenge?: (
    header: string | null,
  ) => Promise<string | null>;
  readOnly?: boolean;
  /** Called when a turn completes, so the app can re-read what it changed. */
  onTurnFinished?: () => void;
};

export function ChatThread({
  chat,
  events,
  pendingInput,
  pendingUserMessage = null,
  getAccessToken,
  getCallerToken,
  respondToAuthenticationChallenge,
  readOnly = false,
  onTurnFinished,
}: ChatThreadProps): React.ReactElement {
  const pendingSentRef = useRef(false);
  const challengeInFlightRef = useRef(false);
  const authenticationAttemptedRef = useRef(false);
  const [queuedTurnState, setQueuedTurnState] = useState<{
    chatId: string | null;
    turns: QueuedTurn[];
  }>({ chatId: null, turns: [] });
  const queuedTurns =
    queuedTurnState.chatId === chat.id ? queuedTurnState.turns : [];
  const updateQueuedTurns = useCallback<UpdateQueuedTurns>(
    (update) => {
      setQueuedTurnState((current) => ({
        chatId: chat.id,
        turns: update(current.chatId === chat.id ? current.turns : []),
      }));
    },
    [chat.id],
  );
  const [authentication, setAuthentication] = useState<{
    revision: number;
    mode: "app" | "caller";
    events: ChatEvent[];
    pendingBatches: ClientPendingBatch[];
    session?: ClientSessionState;
    retryInput?: TurnPayload;
    retryQueuedTurnId?: string;
  }>({
    revision: 0,
    mode: "app",
    events,
    pendingBatches: batchesFromState(pendingInput),
  });

  const handleAuthenticationError = async (
    error: ClientError,
    retryInput: TurnPayload,
    currentEvents: ChatEvent[],
    currentSession: ClientSessionState | undefined,
    currentPendingBatches: ClientPendingBatch[],
    queuedTurnId?: string,
  ): Promise<void> => {
    if (
      error.status !== 401 ||
      !respondToAuthenticationChallenge ||
      !getCallerToken ||
      challengeInFlightRef.current ||
      authenticationAttemptedRef.current
    ) {
      return;
    }
    challengeInFlightRef.current = true;
    try {
      const token = await respondToAuthenticationChallenge(
        error.headers["www-authenticate"] ?? null,
      );
      if (!token) return;
      authenticationAttemptedRef.current = true;
      pendingSentRef.current = true;
      setAuthentication((current) => ({
        revision: current.revision + 1,
        mode: "caller",
        events: currentEvents,
        pendingBatches: currentPendingBatches,
        session: currentSession,
        retryInput,
        retryQueuedTurnId: queuedTurnId,
      }));
    } finally {
      challengeInFlightRef.current = false;
    }
  };

  useEffect(() => {
    setQueuedTurnState({
      chatId: chat.id,
      turns: readQueuedTurns(chat.id),
    });
  }, [chat.id]);

  useEffect(() => {
    if (queuedTurnState.chatId !== chat.id) return;
    writeQueuedTurns(chat.id, queuedTurnState.turns);
  }, [chat.id, queuedTurnState]);

  return (
    <ChatThreadSession
      key={authentication.revision}
      chat={chat}
      events={authentication.events}
      pendingInput={pendingInput}
      initialPendingBatches={authentication.pendingBatches}
      initialSession={authentication.session}
      pendingUserMessage={pendingUserMessage}
      pendingSentRef={pendingSentRef}
      getAccessToken={
        authentication.mode === "caller" ? getCallerToken : getAccessToken
      }
      getCallerToken={getCallerToken}
      onAuthenticationError={handleAuthenticationError}
      onTurnFinished={onTurnFinished}
      queuedTurns={queuedTurns}
      readOnly={readOnly}
      retryInput={authentication.retryInput}
      retryQueuedTurnId={authentication.retryQueuedTurnId}
      updateQueuedTurns={updateQueuedTurns}
    />
  );
}

function ChatThreadSession({
  chat,
  events,
  initialPendingBatches,
  initialSession,
  pendingUserMessage,
  pendingSentRef,
  getAccessToken,
  getCallerToken,
  onAuthenticationError,
  onTurnFinished,
  queuedTurns,
  readOnly,
  retryInput,
  retryQueuedTurnId,
  updateQueuedTurns,
}: ChatThreadProps & {
  initialPendingBatches: ClientPendingBatch[];
  initialSession?: ClientSessionState;
  pendingSentRef: React.MutableRefObject<boolean>;
  onAuthenticationError(
    error: ClientError,
    retryInput: TurnPayload,
    events: ChatEvent[],
    session: ClientSessionState | undefined,
    pendingBatches: ClientPendingBatch[],
    queuedTurnId?: string,
  ): Promise<void>;
  queuedTurns: QueuedTurn[];
  retryInput?: TurnPayload;
  retryQueuedTurnId?: string;
  updateQueuedTurns: UpdateQueuedTurns;
}): React.ReactElement {
  const agentRef = useRef<ReturnType<typeof useEveAgent> | null>(null);
  const drainQueuedTurnRef = useRef<
    ((settledQueuedTurnId?: string) => void) | null
  >(null);
  const latestInputRef = useRef<TurnPayload | null>(null);
  const retrySentRef = useRef(false);
  const retryRefetchedRef = useRef(false);
  const [localError, setLocalError] = useState<string | null>(null);
  // Refs mirror the states below so callbacks and same-batch dispatches read
  // the latest value instead of a stale render's.
  const draftResponsesRef = useRef<ReadonlyMap<string, InputResponse>>(new Map());
  const [draftResponses, setDraftResponses] = useState<ReadonlyMap<string, InputResponse>>(
    draftResponsesRef.current,
  );
  const pendingBatchesRef = useRef<ClientPendingBatch[]>(initialPendingBatches);
  // Every local change advances the generation; a refetch started before the
  // latest change is stale and must not overwrite it (a slow GET returning an
  // intermediate state would otherwise erase a batch a live event just opened).
  const pendingGenerationRef = useRef(0);
  const [pendingBatches, setPendingBatchesState] =
    useState<ClientPendingBatch[]>(initialPendingBatches);
  const [showPendingUserMessage, setShowPendingUserMessage] = useState(
    Boolean(pendingUserMessage) &&
      !events.some((event) => event.type === "message.received"),
  );
  const queuedTurnsRef = useRef(queuedTurns);
  queuedTurnsRef.current = queuedTurns;
  const activeQueuedTurnIdRef = useRef<string | null>(
    retryQueuedTurnId ??
      queuedTurns.find((turn) => turn.status === "sending")?.id ??
      null,
  );

  const removeQueuedTurn = useCallback(
    (id: string): void => {
      updateQueuedTurns((current) => current.filter((turn) => turn.id !== id));
      if (activeQueuedTurnIdRef.current === id) {
        activeQueuedTurnIdRef.current = null;
      }
    },
    [updateQueuedTurns],
  );

  const failQueuedTurn = useCallback(
    (id: string, error: unknown): void => {
      const message = errorMessage(error);
      updateQueuedTurns((current) =>
        current.map((turn) =>
          turn.id === id
            ? { ...turn, dispatchPolicy: undefined, error: message, status: "failed" }
            : turn,
        ),
      );
      if (activeQueuedTurnIdRef.current === id) {
        activeQueuedTurnIdRef.current = null;
      }
    },
    [updateQueuedTurns],
  );

  const setDrafts = (drafts: ReadonlyMap<string, InputResponse>): void => {
    draftResponsesRef.current = drafts;
    setDraftResponses(drafts);
  };

  const setPendingBatches = (batches: ClientPendingBatch[]): void => {
    pendingGenerationRef.current += 1;
    pendingBatchesRef.current = batches;
    setPendingBatchesState(batches);
  };

  /**
   * Replaces the local view with the proxy's ledger — the record of what Eve
   * actually accepted. Drafts survive as long as their request is still open
   * there, so a send that never reached Eve keeps every collected answer.
   */
  const reconcilePendingInput = (state: PendingInputState): void => {
    const batches = batchesFromState(state);
    setPendingBatches(batches);
    const open = new Set<string>();
    for (const batch of batches) {
      for (const request of batch.requests) {
        if (!batch.answered.has(request.requestId)) {
          open.add(request.requestId);
        }
      }
    }
    setDrafts(
      new Map(
        [...draftResponsesRef.current].filter(([requestId]) => open.has(requestId)),
      ),
    );
  };

  /** Applies one authoritative live settlement without waiting for stream end. */
  const settleLiveInput = (requestIds: readonly string[]): void => {
    if (requestIds.length === 0) return;
    const resolved = new Set(requestIds);
    const batches: ClientPendingBatch[] = [];
    for (const batch of pendingBatchesRef.current) {
      const addressed = batch.requests.some((request) =>
        resolved.has(request.requestId),
      );
      if (!addressed) {
        batches.push(batch);
        continue;
      }
      const answered = new Set([
        ...batch.answered,
        ...batch.requests
          .map((request) => request.requestId)
          .filter((requestId) => resolved.has(requestId)),
      ]);
      const requiredOpen = batch.requests.some(
        (request) =>
          isRequiredKind(request.kind) && !answered.has(request.requestId),
      );
      if (requiredOpen) {
        batches.push({ ...batch, answered });
      }
    }
    setPendingBatches(batches);
    const open = new Set(
      batches.flatMap((batch) =>
        batch.requests
          .filter((request) => !batch.answered.has(request.requestId))
          .map((request) => request.requestId),
      ),
    );
    setDrafts(
      new Map(
        [...draftResponsesRef.current].filter(([requestId]) => open.has(requestId)),
      ),
    );
  };

  const refetchPendingInput = async (): Promise<void> => {
    const generation = pendingGenerationRef.current;
    try {
      const headers: Record<string, string> = {};
      if (getAccessToken) {
        headers.authorization = `Bearer ${await getAccessToken()}`;
      }
      const response = await fetch(
        `/api/chats/${encodeURIComponent(chat.id)}/pending-input`,
        { headers, cache: "no-store" },
      );
      if (!response.ok) return;
      const body = (await response.json()) as { pendingInput?: PendingInputState };
      if (body.pendingInput && pendingGenerationRef.current === generation) {
        reconcilePendingInput(body.pendingInput);
      }
    } catch {
      // The local view stands; the next reconcile trigger retries.
    }
  };

  const agent = useEveAgent({
    host: `/api/chats/${chat.id}/agent`,
    auth: getAccessToken ? { bearer: getAccessToken } : undefined,
    // Eve types `initialEvents` as its own stream but folds every seeded event
    // through the reducer, which is how a stored `client.input.responded`
    // reaches the message parts it answers.
    initialEvents: events as MessageStreamEvent[],
    initialSession: initialSession ?? chat.sessionState ?? undefined,
    prepareSend(input) {
      latestInputRef.current = input;
      return input;
    },
    onError(error) {
      // Covers every failed send, including a turn Eve accepted whose stream
      // broke: the ledger recorded the acceptance (or didn't) at the 2xx.
      void refetchPendingInput();

      const current = agentRef.current;
      const retry = latestInputRef.current;
      const queuedTurnId = activeQueuedTurnIdRef.current ?? undefined;
      if (queuedTurnId) {
        failQueuedTurn(queuedTurnId, error);
      }
      if (
        error instanceof ClientError &&
        current &&
        retry
      ) {
        void onAuthenticationError(
          error,
          retry,
          [...current.events],
          current.session,
          pendingBatchesRef.current,
          queuedTurnId,
        ).catch((authenticationError: unknown) => {
          setLocalError(errorMessage(authenticationError));
        });
      }
    },
    onEvent(event) {
      if (event.type === "message.received") {
        setShowPendingUserMessage(false);
        const queuedTurnId = activeQueuedTurnIdRef.current;
        const queuedTurn = queuedTurnsRef.current.find(
          (turn) => turn.id === queuedTurnId,
        );
        if (queuedTurn && receivedMessageMatchesQueuedTurn(event, queuedTurn)) {
          removeQueuedTurn(queuedTurn.id);
        }
      }
      if (event.type === "input.requested") {
        const requests = pendingRequestsFromEvent(event);
        if (requests) {
          const key = requests[0]!.requestId;
          setPendingBatches([
            ...pendingBatchesRef.current.filter((batch) => batch.key !== key),
            { key, requests, answered: new Set() },
          ]);
        }
      }
      if (event.type === "input.resolved") {
        settleLiveInput(resolvedInputRequestIds(event));
      }
      // A turn boundary while batches look open is the signature of another
      // actor (a second tab, an external cancel) having settled one.
      if (
        (event.type === "turn.started" || event.type === "turn.cancelled") &&
        pendingBatchesRef.current.length > 0
      ) {
        void refetchPendingInput();
      }
    },
    onFinish(snapshot) {
      // A cancelled turn settles here without an error surfacing anywhere
      // else, so every finish reconciles.
      void refetchPendingInput();
      const queuedTurnId = activeQueuedTurnIdRef.current;
      if (queuedTurnId) {
        if (snapshot.status === "ready") {
          removeQueuedTurn(queuedTurnId);
        } else {
          failQueuedTurn(
            queuedTurnId,
            snapshot.error ?? new Error("Unable to send the queued message."),
          );
        }
      }
      if (snapshot.status === "ready") {
        // Finishing a turn is the authoritative queue-drain trigger. The
        // idle-state effect below remains useful for restored queues, but its
        // deferred timer can be cancelled by an unrelated parent refresh.
        // Dispatch here before that refresh so a queued message cannot strand
        // every later composer submission behind it.
        drainQueuedTurnRef.current?.(queuedTurnId ?? undefined);
        onTurnFinished?.();
      }
    },
  });
  agentRef.current = agent;
  const isBusy = agent.status === "submitted" || agent.status === "streaming";
  const pendingRequestIds = useMemo(() => {
    const ids = new Set<string>();
    for (const batch of pendingBatches) {
      for (const request of batch.requests) {
        if (!batch.answered.has(request.requestId)) {
          ids.add(request.requestId);
        }
      }
    }
    return ids;
  }, [pendingBatches]);
  const composerDisabled = readOnly || chat.status === "completed";
  const projectedMessages = queuedTurns.some(
    (turn) => turn.status === "sending" || turn.status === "failed",
  )
    ? agent.data.messages.filter((message) => !message.metadata?.optimistic)
    : agent.data.messages;
  const visibleMessages =
    showPendingUserMessage && pendingUserMessage
      ? [
          pendingUserContentMessage(chat.id, pendingUserMessage),
          ...projectedMessages.filter(
            (message) => !message.metadata?.optimistic,
          ),
        ]
      : projectedMessages;

  const dispatchQueuedTurn = useCallback(
    (id: string, requestedPolicy: "queue" | "steer"): void => {
      if (composerDisabled || activeQueuedTurnIdRef.current) return;
      const turn = queuedTurnsRef.current.find(
        (candidate) => candidate.id === id && candidate.status !== "sending",
      );
      const currentAgent = agentRef.current;
      if (!turn || !currentAgent) return;

      // If the active turn settles in the same frame as the click, Steer
      // degrades to a normal queued turn instead of cancelling nothing.
      const busy =
        currentAgent.status === "submitted" || currentAgent.status === "streaming";
      const dispatchPolicy = requestedPolicy === "steer" && busy ? "steer" : "queue";
      activeQueuedTurnIdRef.current = id;
      updateQueuedTurns((current) =>
        current.map((candidate) =>
          candidate.id === id
            ? {
                ...candidate,
                dispatchPolicy,
                error: undefined,
                status: "sending",
              }
            : candidate,
        ),
      );
      setLocalError(null);
      void currentAgent
        .send(promptMessageToUserContent(turn.message), {
          turnPolicy: dispatchPolicy,
        })
        .catch((error: unknown) => {
          if (activeQueuedTurnIdRef.current !== id) return;
          failQueuedTurn(id, error);
          setLocalError(errorMessage(error));
          const current = agentRef.current;
          const retry = latestInputRef.current;
          if (error instanceof ClientError && current && retry) {
            void onAuthenticationError(
              error,
              retry,
              [...current.events],
              current.session,
              pendingBatchesRef.current,
              id,
            ).catch((authenticationError: unknown) => {
              setLocalError(errorMessage(authenticationError));
            });
          }
        });
    },
    [
      composerDisabled,
      failQueuedTurn,
      onAuthenticationError,
      updateQueuedTurns,
    ],
  );

  const drainQueuedTurn = useCallback(
    (settledQueuedTurnId?: string): void => {
      if (composerDisabled || activeQueuedTurnIdRef.current) return;
      const next = queuedTurnsRef.current.find(
        (turn) => turn.id !== settledQueuedTurnId,
      );
      if (!next || next.status !== "queued") return;
      dispatchQueuedTurn(next.id, "queue");
    },
    [composerDisabled, dispatchQueuedTurn],
  );
  drainQueuedTurnRef.current = drainQueuedTurn;

  useEffect(() => {
    if (!retryInput || retryRefetchedRef.current) {
      return;
    }
    retryRefetchedRef.current = true;
    void refetchPendingInput();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryInput]);

  // Both mount-time sends below are deferred one tick. StrictMode's simulated
  // remount runs this component's cleanup right after its first effects pass;
  // that cleanup detaches the eve store, aborting a turn already in flight,
  // and the sent-once ref would then swallow the message for good. A timer
  // scheduled in the first pass is cleared by that same cleanup before it can
  // send, so only the surviving pass sends — after the abort window has
  // closed. A real unmount clears the timer the same way.
  useEffect(() => {
    if (!retryInput || retrySentRef.current || agent.status !== "ready") {
      return;
    }
    const timer = setTimeout(() => {
      if (agentRef.current?.status !== "ready") return;
      retrySentRef.current = true;
      setLocalError(null);
      if (retryQueuedTurnId) {
        activeQueuedTurnIdRef.current = retryQueuedTurnId;
        updateQueuedTurns((current) =>
          current.map((turn) =>
            turn.id === retryQueuedTurnId
              ? { ...turn, error: undefined, status: "sending" }
              : turn,
          ),
        );
      }
      void sendTurn(agent, retryInput).catch((error: unknown) => {
        retrySentRef.current = false;
        if (retryQueuedTurnId) {
          failQueuedTurn(retryQueuedTurnId, error);
        }
        setLocalError(errorMessage(error));
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [
    agent,
    failQueuedTurn,
    retryInput,
    retryQueuedTurnId,
    updateQueuedTurns,
  ]);

  useEffect(() => {
    if (
      readOnly ||
      retryInput ||
      !pendingUserMessage ||
      pendingSentRef.current ||
      agent.status !== "ready"
    ) {
      return;
    }
    const timer = setTimeout(() => {
      if (agentRef.current?.status !== "ready") return;
      pendingSentRef.current = true;
      setLocalError(null);
      void agent.send(pendingUserMessage, { turnPolicy: TURN_POLICY }).catch((error: unknown) => {
        pendingSentRef.current = false;
        setLocalError(errorMessage(error));
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [agent, pendingUserMessage, readOnly, retryInput, pendingSentRef]);

  useEffect(() => {
    if (
      composerDisabled ||
      retryInput ||
      (pendingUserMessage && !pendingSentRef.current) ||
      isBusy ||
      activeQueuedTurnIdRef.current
    ) {
      return;
    }
    const next = queuedTurns[0];
    if (!next || next.status !== "queued") return;

    const timer = setTimeout(() => {
      const status = agentRef.current?.status;
      if (status === "submitted" || status === "streaming") return;
      drainQueuedTurn();
    }, 0);
    return () => clearTimeout(timer);
  }, [
    agent.status,
    composerDisabled,
    drainQueuedTurn,
    isBusy,
    pendingSentRef,
    pendingUserMessage,
    queuedTurns,
    retryInput,
  ]);

  const handleSubmit = async (message: PromptInputMessage): Promise<void> => {
    const text = message.text.trim();
    if ((text.length === 0 && message.files.length === 0) || composerDisabled) {
      return;
    }

    if (isBusy || queuedTurnsRef.current.length > 0) {
      updateQueuedTurns((current) => [
        ...current,
        {
          id: nanoid(),
          message: { files: message.files, text },
          status: "queued",
        },
      ]);
      return;
    }

    setLocalError(null);
    try {
      await agent.send(promptMessageToUserContent(message), {
        turnPolicy: TURN_POLICY,
      });
    } catch (error) {
      setLocalError(errorMessage(error));
      throw error;
    }
  };

  /**
   * Eve resolves an input batch as a whole: the first response settles a
   * dismissable batch and every unanswered request reaches the model as
   * `{ status: "ignored" }`. Answers are therefore held per batch until every
   * still-open request in that batch has one, and the payload is exactly that
   * batch's answers — never a union across batches, which can be parked
   * independently (subagent-proxied requests).
   */
  const handleInputResponse = async (response: InputResponse): Promise<void> => {
    const batch = pendingBatchesRef.current.find((candidate) =>
      candidate.requests.some(
        (request) =>
          request.requestId === response.requestId &&
          !candidate.answered.has(request.requestId),
      ),
    );
    if (!batch) {
      return;
    }

    const drafts = new Map(draftResponsesRef.current).set(response.requestId, response);
    const unanswered = batch.requests.filter(
      (request) => !batch.answered.has(request.requestId),
    );
    const answers = unanswered.map((request) => drafts.get(request.requestId));
    if (answers.some((answer) => answer === undefined)) {
      setDrafts(drafts);
      return;
    }

    // Drafts stay until a reconcile confirms the batch closed, so a send that
    // never reached Eve reopens with every answer intact. The close below is
    // optimistic; onError/onFinish refetch the ledger either way.
    setDrafts(drafts);
    setLocalError(null);
    setPendingBatches(
      pendingBatchesRef.current.filter((candidate) => candidate.key !== batch.key),
    );
    try {
      await agent.respond(answers.filter((answer) => answer !== undefined));
    } catch (error) {
      // Only a turn refused before it started rejects here; a transport
      // failure settles through `onError` instead.
      setLocalError(errorMessage(error));
      void refetchPendingInput();
    }
  };

  const inputRequests: InputRequestBatch = {
    canRespond: !readOnly && !isBusy && chat.status !== "completed",
    drafts: draftResponses,
    pending: pendingRequestIds,
    respond: handleInputResponse,
  };

  /**
   * Eve's durable `cancel()` waits for the in-flight turn's `turn.started`, POSTs
   * `{ turnId }` to the session cancel route — this chat's per-chat proxy,
   * which scopes its ledger clear to exactly that turn — and keeps the stream
   * attached until the turn settles, so `turn.cancelled` still reaches the
   * proxy's tap. That is everything the previous hand-rolled cancel fetch
   * existed to guarantee, without the unattributable blanket clear a Stop
   * before `turn.started` used to cause.
   */
  const handleStop = (): void => {
    void agent
      .cancel()
      .catch((error: unknown) => {
        // The turn keeps running when the cancel never reached Eve, so this
        // failure is worth surfacing, unlike a `no_active_turn` result.
        setLocalError(errorMessage(error));
      })
      .finally(() => {
        void refetchPendingInput();
      });
  };

  const displayedError =
    localError ??
    (agent.error
      ? formatEveErrorMessage(
          agent.error.message,
          sessionFailureErrorId(agent.events.at(-1)),
        )
      : null);

  return (
    <TooltipProvider>
      <section className="flex h-full min-h-0 flex-col bg-background">
        <Conversation className="min-h-0 flex-1">
          <ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 py-8 sm:px-6">
            {visibleMessages.length === 0 ? (
              <ConversationEmptyState
                description={`Send a message to ${chat.agentName}.`}
                icon={<MessageCircleIcon className="size-6" />}
                title="Start this conversation"
              />
            ) : (
              visibleMessages.map((message, index) => (
                <EveMessageView
                  inputRequests={inputRequests}
                  isStreaming={
                    agent.status === "streaming" &&
                    index === visibleMessages.length - 1
                  }
                  key={message.id}
                  message={message}
                />
              ))
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-5 sm:px-6">
          {displayedError ? (
            <div className="mb-2 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
              <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
              <p role="alert">{displayedError}</p>
            </div>
          ) : null}
          <PromptInput
            maxFileSize={CHAT_ATTACHMENT_MAX_FILE_SIZE}
            maxFiles={CHAT_ATTACHMENT_MAX_FILES}
            multiple
            onError={(error) => setLocalError(error.message)}
            onSubmit={handleSubmit}
          >
            <ChatSteerQueue
              dispatchBlocked={
                composerDisabled ||
                queuedTurns.some((turn) => turn.status === "sending")
              }
              onDelete={removeQueuedTurn}
              onDispatch={(id) => dispatchQueuedTurn(id, "steer")}
              turns={queuedTurns}
            />
            <ChatComposerAttachments />
            <PromptInputTextarea
              aria-label="Message"
              disabled={composerDisabled}
              placeholder={
                readOnly
                  ? "This Agent is currently unavailable"
                  : composerPlaceholder(chat.status)
              }
            />
            <PromptInputFooter>
              <PromptInputTools>
                <ChatAttachmentButton disabled={composerDisabled} />
              </PromptInputTools>
              <PromptInputSubmit
                aria-label={isBusy ? "Stop generating" : "Send message"}
                disabled={composerDisabled && !isBusy}
                onStop={handleStop}
                status={agent.status}
              />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </section>
    </TooltipProvider>
  );
}

/**
 * Replays one captured turn. The payload the hook handed to `prepareSend`
 * decides whether `send(message)` or `respond(inputResponses)` re-issues it.
 */
async function sendTurn(
  agent: ReturnType<typeof useEveAgent>,
  input: TurnPayload,
): Promise<void> {
  const { inputResponses, message, ...options } = input;
  if (inputResponses !== undefined) {
    return agent.respond(inputResponses, options);
  }
  return agent.send(message, { ...options, turnPolicy: TURN_POLICY });
}

function pendingUserContentMessage(
  chatId: string,
  content: UserContent,
): EveMessage {
  const parts: EveMessagePart[] =
    typeof content === "string"
      ? [{ state: "done", text: content, type: "text" }]
      : content.flatMap((part): EveMessagePart[] => {
          if (part.type === "text") {
            return [{ state: "done", text: part.text, type: "text" }];
          }
          if (part.type === "file") {
            return [
              {
                filename: part.filename,
                mediaType: part.mediaType,
                type: "file",
                url: typeof part.data === "string" ? part.data : undefined,
              },
            ];
          }
          return [];
        });

  return {
    id: `pending:${chatId}:user`,
    metadata: { optimistic: true, status: "submitted" },
    parts,
    role: "user",
  };
}

function queuedTurnsStorageKey(chatId: string): string {
  return `dawn:queued-turns:${chatId}`;
}

function readQueuedTurns(chatId: string): QueuedTurn[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(
      window.sessionStorage.getItem(queuedTurnsStorageKey(chatId)) ?? "[]",
    ) as unknown;
    if (!Array.isArray(value)) return [];
    return value.flatMap((candidate): QueuedTurn[] => {
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        !("id" in candidate) ||
        typeof candidate.id !== "string" ||
        !("message" in candidate) ||
        typeof candidate.message !== "object" ||
        candidate.message === null ||
        !("text" in candidate.message) ||
        typeof candidate.message.text !== "string" ||
        !("files" in candidate.message) ||
        !Array.isArray(candidate.message.files) ||
        !candidate.message.files.every(isStoredFilePart)
      ) {
        return [];
      }
      const failed = "status" in candidate && candidate.status === "failed";
      return [
        {
          id: candidate.id,
          message: {
            files: candidate.message.files,
            text: candidate.message.text,
          },
          status: failed ? "failed" : "queued",
          error:
            failed && "error" in candidate && typeof candidate.error === "string"
              ? candidate.error
              : undefined,
        },
      ];
    });
  } catch {
    return [];
  }
}

function isStoredFilePart(value: unknown): value is PromptInputMessage["files"][number] {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "file" &&
    "url" in value &&
    typeof value.url === "string"
  );
}

function writeQueuedTurns(chatId: string, turns: QueuedTurn[]): void {
  if (typeof window === "undefined") return;
  try {
    const key = queuedTurnsStorageKey(chatId);
    if (turns.length === 0) {
      window.sessionStorage.removeItem(key);
      return;
    }
    window.sessionStorage.setItem(
      key,
      JSON.stringify(
        turns.map(({ dispatchPolicy: _dispatchPolicy, ...turn }) => ({
          ...turn,
          status: turn.status === "sending" ? "queued" : turn.status,
        })),
      ),
    );
  } catch {
    // A large data-URL attachment may exceed the browser's storage quota. The
    // in-memory queue remains fully functional for the current page lifetime.
  }
}

function receivedMessageMatchesQueuedTurn(
  event: Extract<MessageStreamEvent, { type: "message.received" }>,
  turn: QueuedTurn,
): boolean {
  const text = turn.message.text.trim();
  if (turn.message.files.length === 0) {
    return event.data.message === text;
  }
  if (event.data.parts) {
    const expectedParts = [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...turn.message.files.map((file) => ({
        filename: file.filename,
        mediaType: file.mediaType,
        type: "file" as const,
      })),
    ];
    return (
      event.data.parts.length === expectedParts.length &&
      event.data.parts.every((part, index) => {
        const expected = expectedParts[index];
        if (!expected || part.type !== expected.type) return false;
        return part.type === "text" && expected.type === "text"
          ? part.text === expected.text
          : part.type === "file" && expected.type === "file"
            ? part.filename === expected.filename &&
              part.mediaType === expected.mediaType
            : false;
      })
    );
  }
  return (
    (!text || event.data.message.startsWith(text)) &&
    turn.message.files.every((file) =>
      event.data.message.includes(file.filename?.trim() || "Attachment"),
    )
  );
}

function composerPlaceholder(status: ChatThreadSummary["status"]): string {
  if (status === "completed") {
    return "This chat is completed";
  }
  if (status === "failed") {
    return "Try sending your message again";
  }
  return "Message this agent…";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to continue.";
}
