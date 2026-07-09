"use client";

import { useState } from "react";

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

export function ChatThread({ chat: initialChat, messages: initialMessages }: ChatThreadProps): React.ReactElement {
  const [chat, setChat] = useState(initialChat);
  const [messages, setMessages] = useState(initialMessages);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      setError("Enter a message.");
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch(`/api/chats/${chat.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: trimmedMessage }),
      });
      const body = (await response.json()) as SendMessageResponse;
      if (!response.ok || !body.messages) {
        setError(body.error ?? "Unable to send message.");
        return;
      }
      if (body.chat) {
        setChat({ ...body.chat, agentName: chat.agentName });
      }
      setMessages(body.messages);
      setMessage("");
    } catch {
      setError("Unable to send message.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section style={{ display: "grid", gap: "1.5rem" }}>
      <header style={{ display: "grid", gap: "0.5rem" }}>
        <h1>{chat.title}</h1>
        <dl style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
          <div>
            <dt>Agent</dt>
            <dd>{chat.agentName}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{chat.status}</dd>
          </div>
        </dl>
      </header>

      <div aria-label="Thread" style={{ display: "grid", gap: "0.75rem" }}>
        {messages.length === 0 ? (
          <p>No messages yet.</p>
        ) : (
          messages.map((threadMessage) => (
            <article key={threadMessage.id} style={{ border: "1px solid #d1d5db", borderRadius: "0.5rem", padding: "1rem" }}>
              <strong>{threadMessage.role === "assistant" ? chat.agentName : threadMessage.role}</strong>
              <p>{threadMessage.content}</p>
            </article>
          ))
        )}
      </div>

      <form onSubmit={onSubmit} style={{ display: "grid", gap: "0.75rem" }}>
        <label style={{ display: "grid", gap: "0.25rem" }}>
          Message
          <textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={4} />
        </label>
        <button type="submit" disabled={isSubmitting || chat.status !== "active"}>
          {isSubmitting ? "Sending…" : "Send"}
        </button>
        {chat.status !== "active" ? <p>This chat is {chat.status}; new messages are disabled.</p> : null}
        {error ? <p role="alert">{error}</p> : null}
      </form>
    </section>
  );
}
