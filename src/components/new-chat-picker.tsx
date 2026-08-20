"use client";

import Link from "next/link";
import type { Route } from "next";
import { useEffect, useState } from "react";
import { Bot, CircleAlert } from "lucide-react";

import { AgentAvatar } from "@/components/agent-avatar";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

type PickerAgent = {
  id: string;
  name: string;
  status: "unknown" | "healthy" | "unreachable";
};

type PickerState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; agents: PickerAgent[] };

/** The `/chats/new` body: lists connected Agents to start a chat with. */
export function NewChatPicker(): React.ReactElement {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PickerState>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch("/api/agents", { cache: "no-store" });
        if (!response.ok) throw new Error("Unable to load Agents.");
        const body = (await response.json()) as { agents?: PickerAgent[] };
        if (active) setState({ kind: "ready", agents: body.agents ?? [] });
      } catch (error) {
        if (active) {
          setState({
            kind: "error",
            message:
              error instanceof Error ? error.message : "Unable to load Agents.",
          });
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [attempt]);

  if (state.kind === "loading") {
    return (
      <div className="flex min-h-48 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <Alert variant="destructive">
        <CircleAlert />
        <AlertTitle>Unable to load Agents</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>{state.message}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setState({ kind: "loading" });
              setAttempt((current) => current + 1);
            }}
          >
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (state.agents.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
        <div className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
          <Bot className="size-6" />
        </div>
        <p className="text-muted-foreground text-sm">No agents connected yet.</p>
        <Button asChild>
          <Link href={"/agents/new" as Route}>Connect an agent</Link>
        </Button>
      </div>
    );
  }

  return (
    <ul className="grid list-none gap-3 p-0 sm:grid-cols-2">
      {state.agents.map((agent) => (
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
  );
}
