"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ArrowUp } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

type NewChatComposerProps = {
  agentId: string;
  agentName: string;
  disabled?: boolean;
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

export function NewChatComposer({ agentId, agentName, disabled = false }: NewChatComposerProps): React.ReactElement {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (disabled || isSubmittingRef.current) {
      return;
    }

    isSubmittingRef.current = true;
    setError(null);

    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      setError("Enter a first message.");
      isSubmittingRef.current = false;
      setIsSubmitting(false);
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch("/api/chats", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId, message: trimmedMessage }),
      });
      const body = parseCreateChatResponse(await response.json());
      if (!body.chatId) {
        setError(body.error ?? "Unable to start chat.");
        isSubmittingRef.current = false;
        setIsSubmitting(false);
        return;
      }
      router.push(`/chats/${body.chatId}` as Route);
      router.refresh();
    } catch {
      setError("Unable to start chat.");
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  return (
    <div className="w-full space-y-3">
      <form
        onSubmit={onSubmit}
        className="border-border/60 bg-muted/30 focus-within:border-border flex flex-col gap-2 rounded-3xl border p-3 shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08)] transition-colors"
      >
        <Label htmlFor="new-chat-message" className="sr-only">
          First message
        </Label>
        <textarea
          id="new-chat-message"
          value={message}
          disabled={disabled || isSubmitting}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          rows={3}
          placeholder={`Message ${agentName}...`}
          className="placeholder:text-muted-foreground/80 max-h-48 w-full resize-none bg-transparent px-2.5 py-1 text-base outline-none disabled:cursor-not-allowed disabled:opacity-60"
        />
        <div className="flex items-center justify-end">
          <Button type="submit" size="sm" disabled={disabled || isSubmitting} className="rounded-full">
            <ArrowUp />
            {isSubmitting ? "Starting…" : "Start chat"}
          </Button>
        </div>
      </form>
      {error ? (
        <p role="alert" className="text-destructive text-center text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
