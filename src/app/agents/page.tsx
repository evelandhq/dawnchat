import type { Metadata } from "next";

import { createRepository } from "@/db/repository";
import { getDbClient } from "@/db/provider";
import { redactAgentConnection } from "@/app/api/agents/api";
import { AgentCatalog } from "@/components/agent-catalog";
import type { AgentListItem } from "@/components/agent-list";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Agents",
};

export async function getAgentsForPage(): Promise<AgentListItem[]> {
  const repository = createRepository(getDbClient());
  const agents = await repository.listAgentConnections();
  return agents.map(redactAgentConnection);
}

export default function AgentsPage(): React.ReactElement {
  return <AgentCatalog />;
}
