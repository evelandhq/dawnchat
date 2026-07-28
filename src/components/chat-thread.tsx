"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { UserContent } from "ai";
import {
  ClientError,
  type HandleMessageStreamEvent,
  type InputResponse,
  type SendTurnPayload,
  type SessionState,
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
import { EveMessageView } from "@/components/eve-message";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EVE_PROXY_CONTINUATION_TOKEN } from "@/eve/proxy-contract";
import {
  CHAT_ATTACHMENT_MAX_FILES,
  CHAT_ATTACHMENT_MAX_FILE_SIZE,
  promptMessageToUserContent,
} from "@/lib/chat-messages";

export type ChatThreadSummary = {
  id: string;
  agentConnectionId: string;
  agentName: string;
  title: string;
  status: "active" | "completed" | "failed";
  sessionState: Omit<SessionState, "continuationToken"> | null;
  createdAt: string;
  updatedAt: string;
};

type ChatThreadProps = {
  chat: ChatThreadSummary;
  events: HandleMessageStreamEvent[];
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
    events: HandleMessageStreamEvent[];
    session?: SessionState;
    retryInput?: SendTurnPayload;
  }>({
    revision: 0,
    mode: "app",
    events,
  });

  const handleAuthenticationError = async (
    error: ClientError,
    retryInput: SendTurnPayload,
    currentEvents: HandleMessageStreamEvent[],
    currentSession: SessionState,
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
  initialSession,
  pendingUserMessage,
  pendingSentRef,
  getAccessToken,
  getCallerToken,
  onAuthenticationError,
  readOnly,
  retryInput,
}: ChatThreadProps & {
  initialSession?: SessionState;
  pendingSentRef: React.MutableRefObject<boolean>;
  onAuthenticationError(
    error: ClientError,
    retryInput: SendTurnPayload,
    events: HandleMessageStreamEvent[],
    session: SessionState,
  ): Promise<void>;
  retryInput?: SendTurnPayload;
}): React.ReactElement {
  const router = useRouter();
  const agentRef = useRef<ReturnType<typeof useEveAgent> | null>(null);
  const latestInputRef = useRef<SendTurnPayload | null>(null);
  const retrySentRef = useRef(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [showPendingUserMessage, setShowPendingUserMessage] = useState(
    Boolean(pendingUserMessage) &&
      !events.some((event) => event.type === "message.received"),
  );
  const agent = useEveAgent({
    host: `/api/chats/${chat.id}/agent`,
    auth: getAccessToken ? { bearer: getAccessToken } : undefined,
    initialEvents: events,
    initialSession: initialSession ?? (chat.sessionState
      ? { ...chat.sessionState, continuationToken: EVE_PROXY_CONTINUATION_TOKEN }
      : undefined),
    prepareSend(input) {
      latestInputRef.current = input;
      return input;
    },
    onError(error) {
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
        ).catch((authenticationError: unknown) => {
          setLocalError(errorMessage(authenticationError));
        });
      }
    },
    onEvent(event) {
      if (event.type === "message.received") {
        setShowPendingUserMessage(false);
      }
    },
    onFinish(snapshot) {
      if (snapshot.status === "ready") {
        router.refresh();
      }
    },
  });
  agentRef.current = agent;
  const isBusy = agent.status === "submitted" || agent.status === "streaming";
  const hasPendingInteraction = agent.data.messages.some((message) =>
    message.parts.some(
      (part) =>
        (part.type === "authorization" && part.state === "required") ||
        (part.type === "dynamic-tool" && part.state === "approval-requested"),
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
    if (!retryInput || retrySentRef.current || agent.status !== "ready") {
      return;
    }
    retrySentRef.current = true;
    setLocalError(null);
    void agent.send(retryInput).catch((error: unknown) => {
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
    void agent.send({ message: pendingUserMessage }).catch((error: unknown) => {
      pendingSentRef.current = false;
      setLocalError(errorMessage(error));
    });
  }, [agent, pendingUserMessage, readOnly]);

  const handleSubmit = async (message: PromptInputMessage): Promise<void> => {
    const text = message.text.trim();
    if ((text.length === 0 && message.files.length === 0) || isBusy || composerDisabled) {
      return;
    }

    setLocalError(null);
    try {
      await agent.send({ message: promptMessageToUserContent(message) });
    } catch (error) {
      setLocalError(errorMessage(error));
      throw error;
    }
  };

  const handleInputResponses = async (responses: readonly InputResponse[]): Promise<void> => {
    setLocalError(null);
    try {
      await agent.send({ inputResponses: responses });
    } catch (error) {
      setLocalError(errorMessage(error));
    }
  };

  const handleStop = (): void => {
    agent.stop();
    const sessionId = agent.session.sessionId;
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
        // The local stream is already stopped. A later stream replay will
        // reconcile the authoritative turn state if cooperative cancel fails.
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
                  canRespond={!readOnly && !isBusy && chat.status !== "completed"}
                  isStreaming={
                    agent.status === "streaming" &&
                    index === visibleMessages.length - 1
                  }
                  key={message.id}
                  message={message}
                  onInputResponses={handleInputResponses}
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
