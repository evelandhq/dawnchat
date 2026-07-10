"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";

import { Thread } from "@/components/assistant-ui/thread";
import { StatusBadge } from "@/components/status-badge";

export type ChatThreadSummary = {
  id: string;
  agentConnectionId: string;
  agentName: string;
  title: string;
  status: "active" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
};

export type ChatThreadMessage = {
  id: string;
  chatId: string;
  role: "user" | "assistant" | "system";
  content: string;
  eventIndex: number | null;
  createdAt: string;
};

type ChatThreadProps = {
  chat: ChatThreadSummary;
  messages: ChatThreadMessage[];
};

type SendMessageResponse = {
  chat?: Omit<ChatThreadSummary, "agentName">;
  messages?: ChatThreadMessage[];
  error?: string;
};

const convertMessage = (message: ChatThreadMessage): ThreadMessageLike => ({
  id: message.id,
  role: message.role,
  content: [{ type: "text", text: message.content }],
  createdAt: new Date(message.createdAt),
});

export function ChatThread({ chat: initialChat, messages: initialMessages }: ChatThreadProps): React.ReactElement {
  const router = useRouter();
  const [chat, setChat] = useState(initialChat);
  const [messages, setMessages] = useState(initialMessages);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onNew(message: AppendMessage): Promise<void> {
    const text = message.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (!text) {
      return;
    }

    setError(null);
    const previous = messages;
    setMessages([
      ...previous,
      {
        id: `optimistic_${Date.now()}`,
        chatId: chat.id,
        role: "user",
        content: text,
        eventIndex: null,
        createdAt: new Date().toISOString(),
      },
    ]);
    setIsRunning(true);
    try {
      const response = await fetch(`/api/chats/${chat.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const body = (await response.json()) as SendMessageResponse;
      if (!response.ok || !body.messages) {
        setMessages(previous);
        setError(body.error ?? "Unable to send message.");
        return;
      }
      if (body.chat) {
        setChat({ ...body.chat, agentName: chat.agentName });
      }
      setMessages(body.messages);
      router.refresh();
    } catch {
      setMessages(previous);
      setError("Unable to send message.");
    } finally {
      setIsRunning(false);
    }
  }

  const runtime = useExternalStoreRuntime<ChatThreadMessage>({
    messages,
    setMessages: (next) => setMessages([...next]),
    convertMessage,
    onNew,
    isRunning,
    isDisabled: chat.status !== "active",
  });

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-3 sm:px-6">
        <h1 className="truncate text-base font-semibold">{chat.title}</h1>
        <span className="text-muted-foreground text-sm">{chat.agentName}</span>
        <StatusBadge status={chat.status} />
      </header>
      <div className="min-h-0 flex-1">
        <AssistantRuntimeProvider runtime={runtime}>
          <Thread />
        </AssistantRuntimeProvider>
      </div>
      {chat.status !== "active" ? (
        <p className="text-muted-foreground border-t px-4 py-2 text-center text-sm">
          This chat is {chat.status}; new messages are disabled.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive border-t px-4 py-2 text-center text-sm">
          {error}
        </p>
      ) : null}
    </section>
  );
}
