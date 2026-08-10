"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
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
import { EveMessageView, type InputRequestBatch } from "@/components/eve-message";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  isRequiredKind,
  pendingRequestsFromEvent,
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
}: ChatThreadProps): React.ReactElement {
  const pendingSentRef = useRef(false);
  const challengeInFlightRef = useRef(false);
  const authenticationAttemptedRef = useRef(false);
  const [authentication, setAuthentication] = useState<{
    revision: number;
    mode: "app" | "caller";
    events: ChatEvent[];
    pendingBatches: ClientPendingBatch[];
    session?: ClientSessionState;
    retryInput?: TurnPayload;
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
      }));
    } finally {
      challengeInFlightRef.current = false;
    }
  };

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
      readOnly={readOnly}
      retryInput={authentication.retryInput}
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
  readOnly,
  retryInput,
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
  ): Promise<void>;
  retryInput?: TurnPayload;
}): React.ReactElement {
  const router = useRouter();
  const agentRef = useRef<ReturnType<typeof useEveAgent> | null>(null);
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
        ).catch((authenticationError: unknown) => {
          setLocalError(errorMessage(authenticationError));
        });
      }
    },
    onEvent(event) {
      if (event.type === "message.received") {
        setShowPendingUserMessage(false);
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
      // `stop()` aborts without an error surfacing anywhere else (the store
      // skips `onError` for aborts), so every finish reconciles.
      void refetchPendingInput();
      if (snapshot.status === "ready") {
        router.refresh();
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
  // Only a required request locks the composer. A dismissable-only park keeps
  // it open: a plain message is Eve's own dismiss gesture for such a batch.
  const hasPendingInteraction =
    pendingBatches.some((batch) =>
      batch.requests.some(
        (request) =>
          isRequiredKind(request.kind) && !batch.answered.has(request.requestId),
      ),
    ) ||
    agent.data.messages.some((message) =>
      message.parts.some(
        (part) => part.type === "authorization" && part.state === "required",
      ),
    );
  const composerDisabled =
    readOnly || chat.status === "completed" || hasPendingInteraction;
  const visibleMessages =
    showPendingUserMessage && pendingUserMessage
      ? [
          pendingUserContentMessage(chat.id, pendingUserMessage),
          ...agent.data.messages.filter(
            (message) => !message.metadata?.optimistic,
          ),
        ]
      : agent.data.messages;

  useEffect(() => {
    if (!retryInput || retryRefetchedRef.current) {
      return;
    }
    retryRefetchedRef.current = true;
    void refetchPendingInput();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryInput]);

  useEffect(() => {
    if (!retryInput || retrySentRef.current || agent.status !== "ready") {
      return;
    }
    retrySentRef.current = true;
    setLocalError(null);
    void sendTurn(agent, retryInput).catch((error: unknown) => {
      retrySentRef.current = false;
      setLocalError(errorMessage(error));
    });
  }, [agent, retryInput]);

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
    pendingSentRef.current = true;
    setLocalError(null);
    void agent.send(pendingUserMessage).catch((error: unknown) => {
      pendingSentRef.current = false;
      setLocalError(errorMessage(error));
    });
  }, [agent, pendingUserMessage, readOnly, retryInput, pendingSentRef]);

  const handleSubmit = async (message: PromptInputMessage): Promise<void> => {
    const text = message.text.trim();
    if ((text.length === 0 && message.files.length === 0) || isBusy || composerDisabled) {
      return;
    }

    setLocalError(null);
    try {
      await agent.send(promptMessageToUserContent(message));
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

  const handleStop = (): void => {
    agent.stop();
    const sessionId = agent.session?.sessionId;
    const getCancelToken = getAccessToken ?? getCallerToken;
    if (!sessionId || !getCancelToken) {
      return;
    }

    void getCancelToken()
      .then((accessToken) =>
        fetch(
          `/api/chats/${encodeURIComponent(chat.id)}/agent/eve/v1/session/${encodeURIComponent(sessionId)}/cancel`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${accessToken}`,
              "content-type": "application/json",
            },
            body: "{}",
          },
        ),
      )
      .catch(() => {
        // The local stream is already stopped; the reconcile below reads
        // whatever the proxy recorded about the cancel.
      })
      .finally(() => {
        void refetchPendingInput();
      });
  };

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
          {agent.error || localError ? (
            <div className="mb-2 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
              <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
              <p role="alert">{localError ?? agent.error?.message ?? "Unable to continue."}</p>
            </div>
          ) : null}
          <PromptInput
            maxFileSize={CHAT_ATTACHMENT_MAX_FILE_SIZE}
            maxFiles={CHAT_ATTACHMENT_MAX_FILES}
            multiple
            onError={(error) => setLocalError(error.message)}
            onSubmit={handleSubmit}
          >
            <ChatComposerAttachments />
            <PromptInputTextarea
              aria-label="Message"
              disabled={composerDisabled}
              placeholder={
                readOnly
                  ? "This Agent is currently unavailable"
                  : composerPlaceholder(chat.status, hasPendingInteraction)
              }
            />
            <PromptInputFooter>
              <PromptInputTools>
                <ChatAttachmentButton disabled={composerDisabled || isBusy} />
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
 * Replays one captured turn. Eve 0.31 split the single continuation-token send
 * into `send(message)` and `respond(inputResponses)`, so the payload the hook
 * handed to `prepareSend` decides which command re-issues it.
 */
async function sendTurn(
  agent: ReturnType<typeof useEveAgent>,
  input: TurnPayload,
): Promise<void> {
  const { inputResponses, message, ...options } = input;
  if (inputResponses !== undefined) {
    return agent.respond(inputResponses, options);
  }
  return agent.send(message, options);
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

function composerPlaceholder(
  status: ChatThreadSummary["status"],
  hasPendingInteraction: boolean,
): string {
  if (status === "completed") {
    return "This chat is completed";
  }
  if (status === "failed") {
    return "Try sending your message again";
  }
  if (hasPendingInteraction) {
    return "Respond to the request above to continue";
  }
  return "Message this agent…";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to continue.";
}
