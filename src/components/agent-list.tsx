import Link from "next/link";
import { Bot, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";

export type AgentListItem = {
  id: string;
  name: string;
  baseUrl: string;
  authType: "none" | "bearer" | "header";
  hasAuth: boolean;
  status: "unknown" | "healthy" | "unreachable";
  lastCheckedAt: string | null;
};

type AgentListProps = {
  agents: AgentListItem[];
};

function authLabel(authType: AgentListItem["authType"]): string {
  if (authType === "bearer") {
    return "Bearer Token";
  }
  if (authType === "header") {
    return "Custom Header";
  }
  return "None";
}

export function AgentList({ agents }: AgentListProps): React.ReactElement {
  return (
    <section className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
          <p className="text-muted-foreground text-sm">Register Eve agents that chats can connect to.</p>
        </div>
        <Button asChild>
          <Link href="/agents/new">
            <Plus />
            Connect an agent
          </Link>
        </Button>
      </div>

      {agents.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
          <div className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
            <Bot className="size-6" />
          </div>
          <p className="text-muted-foreground text-sm">No agents connected yet.</p>
        </div>
      ) : (
        <ul className="grid list-none gap-4 p-0 sm:grid-cols-2 xl:grid-cols-3">
          {agents.map((agent) => (
            <li key={agent.id}>
              <Card className="h-full">
                <CardHeader>
                  <CardTitle className="flex items-center justify-between gap-2">
                    <span className="truncate">{agent.name}</span>
                    <StatusBadge status={agent.status} />
                  </CardTitle>
                  <CardDescription className="truncate font-mono text-xs">{agent.baseUrl}</CardDescription>
                </CardHeader>
                <CardContent>
                  <dl className="grid gap-2 text-sm">
                    <div className="flex items-center justify-between gap-4">
                      <dt className="text-muted-foreground">Auth Type</dt>
                      <dd>{authLabel(agent.authType)}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <dt className="text-muted-foreground">Auth</dt>
                      <dd>{agent.hasAuth ? "Auth configured" : "No auth configured"}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <dt className="text-muted-foreground">Last checked</dt>
                      <dd className="truncate">{agent.lastCheckedAt ?? "Never"}</dd>
                    </div>
                  </dl>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
