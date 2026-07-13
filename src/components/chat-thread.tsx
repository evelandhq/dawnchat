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

type ChatStreamLine =
  | { type: "delta"; message: string }
  | { type: "message"; message: string }
  | { type: "done"; chat: Omit<ChatThreadSummary, "agentName">; messages: ChatThreadMessage[] }
  | { type: "error"; error: string; chat?: Omit<ChatThreadSummary, "agentName">; messages?: ChatThreadMessage[] };

async function* readNdjsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatStreamLine> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const rawLine = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (rawLine) {
        yield JSON.parse(rawLine) as ChatStreamLine;
      }
      newlineIndex = buffer.indexOf("\n");
    }
  }
  const tail = buffer.trim();
  if (tail) {
    yield JSON.parse(tail) as ChatStreamLine;
  }
}

// Deliberately no `id`: assistant-ui then keys messages by list position, which
// stays stable when the optimistic message is replaced by the server list.
// Passing server ids makes the optimistic message an orphaned sibling in
// assistant-ui's message tree and phantom 1/2 branch switchers appear.
const convertMessage = (message: ChatThreadMessage): ThreadMessageLike => ({
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
    const withUser: ChatThreadMessage[] = [
      ...previous,
      {
        id: `optimistic_${Date.now()}`,
        chatId: chat.id,
        role: "user",
        content: text,
        eventIndex: null,
        createdAt: new Date().toISOString(),
      },
    ];
    setMessages(withUser);
    setIsRunning(true);
    try {
      const response = await fetch(`/api/chats/${chat.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text }),
      });

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/x-ndjson") || !response.body) {
        // Guard failures (validation, unreachable agent, completed chat) come
        // back as plain JSON with a real HTTP status.
        const body = (await response.json()) as SendMessageResponse;
        if (body.chat) {
          setChat({ ...body.chat, agentName: chat.agentName });
        }
        // A failed turn still returns the persisted messages (the user message
        // is saved server-side), so keep them visible instead of rolling back.
        if (body.messages) {
          setMessages(body.messages);
        } else if (!response.ok) {
          setMessages(previous);
        }
        if (!response.ok || !body.messages) {
          setError(body.error ?? "Unable to send message.");
          return;
        }
        router.refresh();
        return;
      }

      const committed: ChatThreadMessage[] = [];
      const assistantSoFar = (content: string, index: number): ChatThreadMessage => ({
        id: `streaming_${index}`,
        chatId: chat.id,
        role: "assistant",
        content,
        eventIndex: null,
        createdAt: new Date().toISOString(),
      });
      let terminal = false;
      for await (const line of readNdjsonLines(response.body)) {
        if (line.type === "delta") {
          setMessages([...withUser, ...committed, assistantSoFar(line.message, committed.length)]);
        } else if (line.type === "message") {
          committed.push(assistantSoFar(line.message, committed.length));
          setMessages([...withUser, ...committed]);
        } else if (line.type === "done") {
          terminal = true;
          setChat({ ...line.chat, agentName: chat.agentName });
          setMessages(line.messages);
          router.refresh();
        } else if (line.type === "error") {
          terminal = true;
          if (line.chat) {
            setChat({ ...line.chat, agentName: chat.agentName });
          }
          if (line.messages) {
            setMessages(line.messages);
          }
          setError(line.error);
        }
      }
      if (!terminal) {
        setError("Connection lost while receiving the reply. Send your message again to retry.");
      }
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
    isDisabled: chat.status === "completed",
  });

  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <AssistantRuntimeProvider runtime={runtime}>
          <Thread />
        </AssistantRuntimeProvider>
      </div>
      {chat.status === "completed" ? (
        <p className="text-muted-foreground border-t px-4 py-2 text-center text-sm">
          This chat is completed; new messages are disabled.
        </p>
      ) : null}
      {chat.status === "failed" ? (
        <p role="alert" className="text-destructive border-t px-4 py-2 text-center text-sm">
          {error ?? "Eve turn failed"} — the agent did not reply. Send your message again to retry.
        </p>
      ) : error ? (
        <p role="alert" className="text-destructive border-t px-4 py-2 text-center text-sm">
          {error}
        </p>
      ) : null}
    </section>
  );
}
