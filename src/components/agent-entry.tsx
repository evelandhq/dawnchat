"use client";

import { useEffect, useState } from "react";
import { CircleAlert } from "lucide-react";

import { AgentRecheckButton } from "@/components/agent-recheck-button";
import { IdentityAgentAccess } from "@/components/identity-agent-access";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export type EntryAgent = {
  id: string;
  name: string;
  status: "unknown" | "healthy" | "unreachable";
};

type EntryState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "error"; message: string }
  | { kind: "ready"; agent: EntryAgent };

/** The `/agents/[agentId]` body: loads the Agent client-side and offers a first message. */
export function AgentEntry({ agentId }: { agentId: string }): React.ReactElement {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<EntryState>({ kind: "loading" });

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
        const body = (await response.json()) as { agent?: EntryAgent };
        if (!body.agent) throw new Error("Unable to load this Agent.");
        if (active) setState({ kind: "ready", agent: body.agent });
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
  const isHealthy = agent.status === "healthy";

  return (
    <>
      {isHealthy ? null : (
        <div className="flex flex-col items-center gap-3">
          <p className="text-muted-foreground text-center text-sm">
            This agent is not available right now. Run a health check before starting a chat.
          </p>
          <AgentRecheckButton
            agentId={agent.id}
            onChecked={(checked) =>
              setState({ kind: "ready", agent: checked })
            }
          />
        </div>
      )}
      <IdentityAgentAccess
        agentId={agent.id}
        agentName={agent.name}
        disabled={!isHealthy}
      />
    </>
  );
}
