import type { Metadata } from "next";
import Link from "next/link";
import type { Route } from "next";
import { Bot } from "lucide-react";

import { createRepository } from "@/db/repository";
import { getDbClient } from "@/db/provider";
import { AgentAvatar } from "@/components/agent-avatar";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "New Chat",
};

export default async function NewChatPage(): Promise<React.ReactElement> {
  const repository = createRepository(getDbClient());
  const agents = await repository.listAgentConnections();

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">New chat</h1>
        <p className="text-muted-foreground text-sm">Choose an agent to start a new chat with.</p>
      </div>

      {agents.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
          <div className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
            <Bot className="size-6" />
          </div>
          <p className="text-muted-foreground text-sm">No agents connected yet.</p>
          <Button asChild>
            <Link href={"/agents/new" as Route}>Connect an agent</Link>
          </Button>
        </div>
      ) : (
        <ul className="grid list-none gap-3 p-0 sm:grid-cols-2">
          {agents.map((agent) => (
            <li key={agent.id}>
              <Link
                href={`/agents/${agent.id}` as Route}
                className="hover:bg-accent flex items-center gap-3 rounded-xl border p-4 transition-colors"
              >
                <AgentAvatar
                  agentId={agent.id}
                  name={agent.name}
                  size="lg"
                  showUnreachableDot={agent.status === "unreachable"}
                />
                <span className="min-w-0 flex-1 truncate font-medium">{agent.name}</span>
                <StatusBadge status={agent.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
