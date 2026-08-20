"use client";

import type { Route } from "next";
import { useEffect, useState } from "react";
import { CircleAlert } from "lucide-react";

import type { AgentConnectionEditDefaults } from "@/app/api/agents/api";
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
import { Spinner } from "@/components/ui/spinner";

type EditorState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "error"; message: string }
  | { kind: "ready"; agent: AgentConnectionEditDefaults };

/** The `/agents/[agentId]/edit` body: loads safe edit defaults client-side. */
export function AgentEditor({ agentId }: { agentId: string }): React.ReactElement {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<EditorState>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch(
          `/api/agents/${encodeURIComponent(agentId)}`,
          { cache: "no-store" },
        );
        if (response.status === 404) {
          if (active) setState({ kind: "missing" });
          return;
        }
        if (!response.ok) throw new Error("Unable to load this Agent.");
        const body = (await response.json()) as {
          editDefaults?: AgentConnectionEditDefaults;
        };
        if (!body.editDefaults) throw new Error("Unable to load this Agent.");
        if (active) setState({ kind: "ready", agent: body.editDefaults });
      } catch (error) {
        if (active) {
          setState({
            kind: "error",
            message:
              error instanceof Error ? error.message : "Unable to load this Agent.",
          });
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [agentId, attempt]);

  if (state.kind === "loading") {
    return (
      <div className="flex min-h-48 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (state.kind === "missing") {
    return (
      <Alert>
        <CircleAlert />
        <AlertTitle>Agent not found</AlertTitle>
        <AlertDescription>
          This Agent does not exist or has been removed.
        </AlertDescription>
      </Alert>
    );
  }

  if (state.kind === "error") {
    return (
      <Alert variant="destructive">
        <CircleAlert />
        <AlertTitle>Unable to load this Agent</AlertTitle>
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

  const agent = state.agent;

  return (
    <>
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
      <div className="border-destructive/30 flex flex-wrap items-center justify-between gap-4 rounded-xl border p-4">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">Delete this agent</p>
          <p className="text-muted-foreground text-sm">
            Permanently removes the agent and all of its chats.
          </p>
        </div>
        <AgentDeleteDialog
          agentId={agent.id}
          agentName={agent.name}
          redirectTo={"/agents" as Route}
        />
      </div>
    </>
  );
}
