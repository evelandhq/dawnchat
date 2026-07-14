import { notFound } from "next/navigation";

import {
  getAgentConnectionEditDefaults,
  type AgentConnectionEditDefaults,
} from "@/app/api/agents/api";
import { AgentConnectionForm } from "@/components/agent-connection-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getDbClient } from "@/db/provider";
import { createRepository } from "@/db/repository";

export const dynamic = "force-dynamic";

type EditAgentPageProps = {
  params: Promise<{ agentId: string }>;
};

export async function getAgentForEditPage(
  agentId: string,
): Promise<AgentConnectionEditDefaults | null> {
  const repository = createRepository(getDbClient());
  const agent = await repository.getAgentConnection(agentId);
  return agent ? getAgentConnectionEditDefaults(agent) : null;
}

export default async function EditAgentPage({
  params,
}: EditAgentPageProps): Promise<React.ReactElement> {
  const { agentId } = await params;
  const agent = await getAgentForEditPage(agentId);
  if (!agent) {
    notFound();
  }

  return (
    <section className="mx-auto w-full max-w-xl p-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="text-xl font-semibold tracking-tight">Edit agent</h1>
          </CardTitle>
          <CardDescription>
            Update this connection and run a new health check.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AgentConnectionForm initialAgent={agent} />
        </CardContent>
      </Card>
    </section>
  );
}
