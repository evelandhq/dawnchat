import Link from "next/link";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { Sparkles } from "lucide-react";

import { createRepository } from "@/db/repository";
import { getDbClient } from "@/db/provider";
import { pickDefaultAgentId } from "@/lib/current-agent";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function HomePage(): Promise<React.ReactElement> {
  const repository = createRepository(getDbClient());
  const [agents, chats] = await Promise.all([repository.listAgentConnections(), repository.listChats()]);
  const defaultAgentId = pickDefaultAgentId(
    chats.map((chat) => ({ id: chat.id, agentConnectionId: chat.agentConnectionId })).reverse(),
    agents.map((agent) => agent.id),
  );

  if (defaultAgentId) {
    redirect(`/agents/${defaultAgentId}`);
  }

  return (
    <section className="mx-auto flex w-full max-w-md flex-col items-center gap-6 px-6 py-24 text-center">
      <div className="bg-primary text-primary-foreground flex size-12 items-center justify-center rounded-2xl">
        <Sparkles className="size-6" />
      </div>
      <h1 className="text-2xl font-semibold tracking-tight">Welcome to EveChats</h1>
      <p className="text-muted-foreground text-sm">Connect your first Eve agent to start chatting.</p>
      <Button asChild>
        <Link href={"/agents/new" as Route}>Connect an agent</Link>
      </Button>
    </section>
  );
}
