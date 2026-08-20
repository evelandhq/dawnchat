"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ArrowUp } from "lucide-react";

import {
  PromptInput,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import {
  ChatAttachmentButton,
  ChatComposerAttachments,
} from "@/components/chat-composer-attachments";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  CHAT_ATTACHMENT_MAX_FILES,
  CHAT_ATTACHMENT_MAX_FILE_SIZE,
  promptMessageToUserContent,
} from "@/lib/chat-messages";

type NewChatComposerProps = {
  agentId: string;
  agentName: string;
  disabled?: boolean;
  /** Resolved at submit time; `null` sends the request unauthenticated. */
  getAccessToken?: () => Promise<string | null>;
};

type CreateChatResponse = {
  chatId?: string;
  error?: string;
};

function parseCreateChatResponse(value: unknown): CreateChatResponse {
  if (!value || typeof value !== "object") {
    return {};
  }

  const body = value as Record<string, unknown>;
  const chat = body.chat && typeof body.chat === "object" ? (body.chat as Record<string, unknown>) : undefined;
  const chatId = typeof chat?.id === "string" && chat.id.trim() ? chat.id.trim() : undefined;
  const error = typeof body.error === "string" && body.error.trim() ? body.error : undefined;
  return { chatId, error };
}

export function NewChatComposer({
  agentId,
  agentName,
  disabled = false,
  getAccessToken,
}: NewChatComposerProps): React.ReactElement {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);

  async function onSubmit(submission: PromptInputMessage): Promise<void> {
    if (disabled || isSubmittingRef.current) {
      return;
    }

    isSubmittingRef.current = true;
    setError(null);

    const firstMessage = promptMessageToUserContent(submission);
    if (typeof firstMessage === "string" && !firstMessage) {
      setError("Enter a first message.");
      isSubmittingRef.current = false;
      setIsSubmitting(false);
      throw new Error("Enter a first message.");
    }

    setIsSubmitting(true);
    try {
      const accessToken =
        getAccessToken ? await getAccessToken() : null;
      const response = await fetch("/api/chats", {
        method: "POST",
        headers: {
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          agentId,
          message: firstMessage,
        }),
      });
      const body = parseCreateChatResponse(await response.json());
      if (!body.chatId) {
        throw new Error(body.error ?? "Unable to start chat.");
      }
      router.push(`/chats/${body.chatId}` as Route);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to start chat.");
      isSubmittingRef.current = false;
      setIsSubmitting(false);
      throw error;
    }
  }

  return (
    <TooltipProvider>
      <div className="w-full space-y-3">
        <PromptInput
          maxFileSize={CHAT_ATTACHMENT_MAX_FILE_SIZE}
          maxFiles={CHAT_ATTACHMENT_MAX_FILES}
          multiple
          onError={(promptError) => setError(promptError.message)}
          onSubmit={onSubmit}
        >
          <ChatComposerAttachments />
          <PromptInputTextarea
            aria-label="First message"
            disabled={disabled || isSubmitting}
            onChange={(event) => setMessage(event.target.value)}
            placeholder={`Message ${agentName}...`}
            value={message}
          />
          <PromptInputFooter>
            <PromptInputTools>
              <ChatAttachmentButton disabled={disabled || isSubmitting} />
            </PromptInputTools>
            <Button
              className="rounded-full"
              disabled={disabled || isSubmitting}
              size="sm"
              type="submit"
            >
              <ArrowUp />
              {isSubmitting ? "Starting…" : "Start chat"}
            </Button>
          </PromptInputFooter>
        </PromptInput>
        {error ? (
          <p role="alert" className="text-destructive text-center text-sm">
            {error}
          </p>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
