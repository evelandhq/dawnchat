"use client";

import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ArrowUp, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/native-select";
import { StatusBadge } from "@/components/status-badge";

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
  const recentChats = useMemo(() => [...chats].reverse(), [chats]);

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
      router.refresh();
    } catch {
      setError("Unable to start chat.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-12 px-6 py-10 sm:py-16">
      <h1 className="sr-only">Chats</h1>

      <div className="space-y-6">
        <div className="space-y-3 text-center">
          <div className="bg-primary text-primary-foreground mx-auto flex size-12 items-center justify-center rounded-2xl">
            <Sparkles className="size-6" />
          </div>
          <h2 className="text-2xl font-semibold tracking-tight">What can Eve help with?</h2>
          <p className="text-muted-foreground text-sm">
            Review previous Eve conversations or start a new chat with a healthy agent.
          </p>
        </div>

        {healthyAgents.length === 0 ? (
          <p className="text-muted-foreground rounded-xl border border-dashed px-6 py-10 text-center text-sm">
            No healthy agents are available. Check an agent before starting a chat.
          </p>
        ) : (
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
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              rows={3}
              placeholder="Send a message..."
              className="placeholder:text-muted-foreground/80 max-h-48 w-full resize-none bg-transparent px-2.5 py-1 text-base outline-none"
            />
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Label htmlFor="new-chat-agent" className="text-muted-foreground text-xs">
                  Agent
                </Label>
                <NativeSelect
                  id="new-chat-agent"
                  value={agentId}
                  onChange={(event) => setAgentId(event.target.value)}
                  className="h-7 w-auto rounded-full border-transparent bg-transparent pr-7 text-xs font-medium"
                >
                  {healthyAgents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <Button type="submit" size="sm" disabled={isSubmitting} className="rounded-full">
                <ArrowUp />
                {isSubmitting ? "Starting…" : "Start chat"}
              </Button>
            </div>
          </form>
        )}
        {error ? (
          <p role="alert" className="text-destructive text-center text-sm">
            {error}
          </p>
        ) : null}
      </div>

      <div className="space-y-3">
        <h2 className="text-muted-foreground text-sm font-medium">Chat history</h2>
        {recentChats.length === 0 ? (
          <p className="text-muted-foreground rounded-xl border border-dashed px-6 py-10 text-center text-sm">
            No chats yet.
          </p>
        ) : (
          <ul className="grid list-none gap-2 p-0">
            {recentChats.map((chat) => (
              <li key={chat.id} className="hover:bg-accent/50 relative rounded-xl border p-4 transition-colors">
                <div className="flex items-center justify-between gap-3">
                  <Link href={`/chats/${chat.id}` as Route} className="truncate font-medium after:absolute after:inset-0">
                    <span className="sr-only">Open </span>
                    {chat.title}
                  </Link>
                  <StatusBadge status={chat.status} />
                </div>
                <p className="text-muted-foreground mt-1 text-sm">{chat.agentName}</p>
                <p className="text-muted-foreground mt-1 truncate text-sm">{chat.lastMessage ?? "No messages yet."}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
