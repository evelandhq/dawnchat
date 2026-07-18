import type { Metadata, Route } from "next";
import { notFound } from "next/navigation";

import {
  getAgentConnectionEditDefaults,
  type AgentConnectionEditDefaults,
} from "@/app/api/agents/api";
import { AgentConnectionForm } from "@/components/agent-connection-form";
import { AgentDeleteDialog } from "@/components/agent-delete-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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

export async function generateMetadata({ params }: EditAgentPageProps): Promise<Metadata> {
  const { agentId } = await params;
  const agent = await getAgentForEditPage(agentId);
  return { title: agent ? `Edit ${agent.name}` : "Edit agent" };
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
    <section className="mx-auto flex w-full max-w-xl flex-col gap-6 p-6">
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
          {agent.authType === "oidc" && agent.status === "authorization_required" ? (
            <Alert className="mb-6">
              <AlertTitle>Authorization required</AlertTitle>
              <AlertDescription className="flex flex-col items-start gap-3">
                <span>Authorize this Agent Connection before starting a chat.</span>
                <Button asChild variant="outline" size="sm">
                  <a href={`/api/agents/${agent.id}/auth/oidc/start?returnPath=${encodeURIComponent(`/agents/${agent.id}/edit`)}`}>
                    Authorize with identity provider
                  </a>
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          <AgentConnectionForm initialAgent={agent} />
        </CardContent>
      </Card>
      <div className="border-destructive/30 flex flex-wrap items-center justify-between gap-4 rounded-xl border p-4">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">Delete this agent</p>
          <p className="text-muted-foreground text-sm">
            Permanently removes the agent and all of its chats.
          </p>
        </div>
        <AgentDeleteDialog agentId={agent.id} agentName={agent.name} redirectTo={"/agents" as Route} />
      </div>
    </section>
  );
}
