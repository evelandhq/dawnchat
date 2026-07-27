import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { createRepository } from "@/db/repository";
import { getDbClient } from "@/db/provider";
import { AgentRecheckButton } from "@/components/agent-recheck-button";
import { IdentityAgentAccess } from "@/components/identity-agent-access";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CircleAlert } from "lucide-react";

export const dynamic = "force-dynamic";

type AgentNewChatPageProps = {
  params: Promise<{ agentId: string }>;
};

type AgentNewChatPageData = {
  id: string;
  name: string;
  status: "unknown" | "healthy" | "unreachable";
  evelandProjectId: string | null;
};

export async function getAgentForNewChatPage(agentId: string): Promise<AgentNewChatPageData | null> {
  const repository = createRepository(getDbClient());
  const agent = await repository.getAgentConnection(agentId);
  if (!agent) {
    return null;
  }

  return {
    id: agent.id,
    name: agent.name,
    status: agent.status,
    evelandProjectId: agent.evelandProjectId,
  };
}

export async function generateMetadata({ params }: AgentNewChatPageProps): Promise<Metadata> {
  const { agentId } = await params;
  const agent = await getAgentForNewChatPage(agentId);
  return { title: agent ? `New Chat · ${agent.name}` : "New Chat" };
}

export default async function AgentNewChatPage({ params }: AgentNewChatPageProps): Promise<React.ReactElement> {
  const { agentId } = await params;
  const agent = await getAgentForNewChatPage(agentId);
  if (!agent) {
    notFound();
  }

  const isHealthy = agent.status === "healthy";

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col items-center gap-6 px-6 py-12 sm:py-20">
      {isHealthy ? null : (
        <div className="flex flex-col items-center gap-3">
          <p className="text-muted-foreground text-center text-sm">
            This agent is not available right now. Run a health check before starting a chat.
          </p>
          <AgentRecheckButton agentId={agent.id} />
        </div>
      )}
      {agent.evelandProjectId ? (
        <IdentityAgentAccess
          agentId={agent.id}
          agentName={agent.name}
          disabled={!isHealthy}
          evelandProjectId={agent.evelandProjectId}
        />
      ) : (
        <Alert>
          <CircleAlert />
          <AlertTitle>Eveland Identity is not configured</AlertTitle>
          <AlertDescription>
            Add this Agent&apos;s Eveland Project ID before starting a chat.
          </AlertDescription>
        </Alert>
      )}
    </section>
  );
}
