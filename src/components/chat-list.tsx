"use client";

import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

export type ChatListSummary = {
  id: string;
  agentConnectionId: string;
  agentName: string;
  title: string;
  status: "active" | "completed" | "failed";
  lastMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ChatListAgent = {
  id: string;
  name: string;
  status: "unknown" | "healthy" | "unreachable";
};

type ChatListProps = {
  chats: ChatListSummary[];
  agents: ChatListAgent[];
};

type CreateChatResponse = {
  chat?: {
    id: string;
  };
  error?: string;
};

export function ChatList({ chats, agents }: ChatListProps): React.ReactElement {
  const router = useRouter();
  const healthyAgents = useMemo(() => agents.filter((agent) => agent.status === "healthy"), [agents]);
  const [agentId, setAgentId] = useState(healthyAgents[0]?.id ?? "");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    const trimmedMessage = message.trim();
    if (!agentId || !trimmedMessage) {
      setError("Choose a healthy agent and enter a first message.");
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch("/api/chats", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId, message: trimmedMessage }),
      });
      const body = (await response.json()) as CreateChatResponse;
      if (!response.ok || !body.chat?.id) {
        setError(body.error ?? "Unable to start chat.");
        return;
      }
      router.push(`/chats/${body.chat.id}` as Route);
    } catch {
      setError("Unable to start chat.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section style={{ display: "grid", gap: "1.5rem" }}>
      <div>
        <h1>Chats</h1>
        <p>Review previous Eve conversations or start a new chat with a healthy agent.</p>
      </div>

      <form onSubmit={onSubmit} style={{ display: "grid", gap: "0.75rem", border: "1px solid #d1d5db", borderRadius: "0.5rem", padding: "1rem" }}>
        <h2>Start a new chat</h2>
        {healthyAgents.length === 0 ? (
          <p>No healthy agents are available. Check an agent before starting a chat.</p>
        ) : (
          <>
            <label style={{ display: "grid", gap: "0.25rem" }}>
              Agent
              <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
                {healthyAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "grid", gap: "0.25rem" }}>
              First message
              <textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={4} />
            </label>
            <button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Starting…" : "Start chat"}
            </button>
          </>
        )}
        {error ? <p role="alert">{error}</p> : null}
      </form>

      <div style={{ display: "grid", gap: "0.75rem" }}>
        <h2>Chat history</h2>
        {chats.length === 0 ? (
          <p>No chats yet.</p>
        ) : (
          <ul style={{ display: "grid", gap: "0.75rem", listStyle: "none", padding: 0 }}>
            {chats.map((chat) => (
              <li key={chat.id} style={{ border: "1px solid #d1d5db", borderRadius: "0.5rem", padding: "1rem" }}>
                <h3>{chat.title}</h3>
                <dl style={{ display: "grid", gap: "0.25rem" }}>
                  <div>
                    <dt>Agent</dt>
                    <dd>{chat.agentName}</dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>{chat.status}</dd>
                  </div>
                  <div>
                    <dt>Last message</dt>
                    <dd>{chat.lastMessage ?? "No messages yet."}</dd>
                  </div>
                </dl>
                <Link href={`/chats/${chat.id}` as Route}>Open {chat.title}</Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
