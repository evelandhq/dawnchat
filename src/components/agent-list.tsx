import Link from "next/link";
import type { Route } from "next";
import { Bot, ChevronRight, Plus } from "lucide-react";

import { AgentAvatar } from "@/components/agent-avatar";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

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

export function AgentList({ agents }: AgentListProps): React.ReactElement {
  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
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
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>URL</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {agents.map((agent) => (
              <TableRow key={agent.id}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <AgentAvatar
                      agentId={agent.id}
                      name={agent.name}
                      showUnreachableDot={agent.status === "unreachable"}
                    />
                    <span className="max-w-48 truncate font-medium">{agent.name}</span>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground max-w-64 truncate font-mono text-xs">
                  {agent.baseUrl}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-2">
                    <Button asChild variant="outline" size="sm">
                      <Link href={("/agents/" + agent.id + "/edit") as Route} aria-label={"Detail " + agent.name}>
                        Detail
                      </Link>
                    </Button>
                    <Button asChild size="sm">
                      <Link href={("/agents/" + agent.id) as Route} aria-label={"Start chat with " + agent.name}>
                        Start Chat
                        <ChevronRight data-icon="inline-end" />
                      </Link>
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
