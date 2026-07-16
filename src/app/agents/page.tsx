import type { Metadata } from "next";

import { createRepository } from "@/db/repository";
import { getDbClient } from "@/db/provider";
import { redactAgentConnection } from "@/app/api/agents/api";
import { AgentList, type AgentListItem } from "@/components/agent-list";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Agents",
};

export async function getAgentsForPage(): Promise<AgentListItem[]> {
  const repository = createRepository(getDbClient());
  const agents = await repository.listAgentConnections();
  return agents.map(redactAgentConnection);
}

export default async function AgentsPage(): Promise<React.ReactElement> {
  const agents = await getAgentsForPage();
  return <AgentList agents={agents} />;
}
