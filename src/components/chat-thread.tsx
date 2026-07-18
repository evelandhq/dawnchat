"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { UserContent } from "ai";
import type { HandleMessageStreamEvent, InputResponse, SessionState } from "eve/client";
import { useEveAgent } from "eve/react";
import { AlertCircleIcon, MessageCircleIcon, PaperclipIcon } from "lucide-react";

import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  PromptInput,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { EveMessageView } from "@/components/eve-message";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EVE_PROXY_CONTINUATION_TOKEN } from "@/eve/proxy-contract";
import {
  claimPendingAgentTurn,
  handleAgentAuthInteraction,
  type PendingAgentTurn,
} from "@/lib/agent-auth-interaction";

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
  pendingUserMessage?: string | null;
};

export function ChatThread({
  chat,
  events,
  pendingUserMessage = null,
}: ChatThreadProps): React.ReactElement {
  const router = useRouter();
  const pendingSentRef = useRef(false);
  const resumeCheckedRef = useRef(false);
  const pendingAuthTurnRef = useRef<PendingAgentTurn | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const agent = useEveAgent({
    host: `/api/chats/${chat.id}/agent`,
    initialEvents: events,
    initialSession: chat.sessionState
      ? { ...chat.sessionState, continuationToken: EVE_PROXY_CONTINUATION_TOKEN }
      : undefined,
    onError: (error) => {
      const handled = handleAgentAuthInteraction({
        chatId: chat.id,
        error,
        redirect: (url) => window.location.assign(url),
        storage: window.sessionStorage,
        turn: pendingAuthTurnRef.current,
      });
      if (!handled) setLocalError(errorMessage(error));
    },
    onFinish: () => router.refresh(),
  });
  const isBusy = agent.status === "submitted" || agent.status === "streaming";
  const hasPendingInteraction = agent.data.messages.some((message) =>
    message.parts.some(
      (part) =>
        (part.type === "authorization" && part.state === "required") ||
        (part.type === "dynamic-tool" && part.state === "approval-requested"),
    ),
  );
  const composerDisabled = chat.status === "completed" || hasPendingInteraction;

  useEffect(() => {
    if (pendingSentRef.current || agent.status !== "ready") {
      return;
    }
    if (!resumeCheckedRef.current) {
      resumeCheckedRef.current = true;
      const pendingTurn = claimPendingAgentTurn(window.sessionStorage, chat.id);
      if (pendingTurn) {
        pendingSentRef.current = true;
        setLocalError(null);
        void sendTurnWithAgentAuth(pendingTurn).finally(() => {
          if (!pendingUserMessage) pendingSentRef.current = false;
        });
        return;
      }
    }
    if (!pendingUserMessage) return;
    pendingSentRef.current = true;
    setLocalError(null);
    void sendTurnWithAgentAuth({ message: pendingUserMessage }).catch((error: unknown) => {
      pendingSentRef.current = false;
      setLocalError(errorMessage(error));
    });
  }, [agent, chat.id, pendingUserMessage]);

  async function sendTurnWithAgentAuth(turn: PendingAgentTurn): Promise<void> {
    pendingAuthTurnRef.current = turn;
    try {
      await agent.send(turn);
    } finally {
      pendingAuthTurnRef.current = null;
    }
  }

  const handleSubmit = async (message: PromptInputMessage): Promise<void> => {
    const text = message.text.trim();
    if ((text.length === 0 && message.files.length === 0) || isBusy || composerDisabled) {
      return;
    }

    const content: UserContent = [];
    if (text) {
      content.push({ type: "text", text });
    }
    for (const file of message.files) {
      content.push({
        type: "file",
        data: file.url,
        filename: file.filename,
        mediaType: file.mediaType,
      });
    }

    setLocalError(null);
    try {
      await sendTurnWithAgentAuth({ message: message.files.length === 0 ? text : content });
    } catch (error) {
      setLocalError(errorMessage(error));
      throw error;
    }
  };

  const handleInputResponses = async (responses: readonly InputResponse[]): Promise<void> => {
    setLocalError(null);
    try {
      await sendTurnWithAgentAuth({ inputResponses: responses });
    } catch (error) {
      setLocalError(errorMessage(error));
    }
  };

  return (
    <TooltipProvider>
      <section className="flex h-full min-h-0 flex-col bg-background">
        <Conversation className="min-h-0 flex-1">
          <ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 py-8 sm:px-6">
            {agent.data.messages.length === 0 ? (
              <ConversationEmptyState
                description={`Send a message to ${chat.agentName}.`}
                icon={<MessageCircleIcon className="size-6" />}
                title="Start this conversation"
              />
            ) : (
              agent.data.messages.map((message, index) => (
                <EveMessageView
                  canRespond={!isBusy && chat.status !== "completed"}
                  isStreaming={
                    agent.status === "streaming" && index === agent.data.messages.length - 1
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
            maxFileSize={20 * 1024 * 1024}
            maxFiles={8}
            multiple
            onError={(error) => setLocalError(error.message)}
            onSubmit={handleSubmit}
          >
            <ComposerAttachments />
            <PromptInputTextarea
              aria-label="Message"
              disabled={composerDisabled}
              placeholder={composerPlaceholder(chat.status, hasPendingInteraction)}
            />
            <PromptInputFooter>
              <PromptInputTools>
                <AddAttachmentButton disabled={composerDisabled || isBusy} />
              </PromptInputTools>
              <PromptInputSubmit
                aria-label={isBusy ? "Stop generating" : "Send message"}
                disabled={composerDisabled && !isBusy}
                onStop={agent.stop}
                status={agent.status}
              />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </section>
    </TooltipProvider>
  );
}

function ComposerAttachments(): React.ReactElement | null {
  const attachments = usePromptInputAttachments();
  if (attachments.files.length === 0) {
    return null;
  }

  return (
    <PromptInputHeader>
      <Attachments variant="inline">
        {attachments.files.map((file) => (
          <Attachment data={file} key={file.id} onRemove={() => attachments.remove(file.id)}>
            <AttachmentPreview />
            <AttachmentInfo />
            <AttachmentRemove />
          </Attachment>
        ))}
      </Attachments>
    </PromptInputHeader>
  );
}

function AddAttachmentButton({ disabled }: { disabled: boolean }): React.ReactElement {
  const attachments = usePromptInputAttachments();
  return (
    <PromptInputButton
      aria-label="Attach files"
      disabled={disabled}
      onClick={attachments.openFileDialog}
      tooltip="Attach files"
    >
      <PaperclipIcon className="size-4" />
    </PromptInputButton>
  );
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
