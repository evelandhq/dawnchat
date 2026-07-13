"use client";

import { type FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge, type StatusValue } from "@/components/status-badge";

type DiscoveredAgent = {
  name: string;
  url: string;
  connected: boolean;
};

type ConnectionState =
  | { phase: "connecting" }
  | { phase: "connected"; health: StatusValue }
  | { phase: "error" };

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function AgentDiscovery(): React.ReactElement {
  const router = useRouter();
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [agents, setAgents] = useState<DiscoveredAgent[] | null>(null);
  const [connections, setConnections] = useState<Record<string, ConnectionState>>({});

  async function handleDiscover(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (!isValidHttpUrl(gatewayUrl.trim())) {
      setError("Gateway URL must be a valid http(s) URL.");
      return;
    }

    setError(null);
    setIsDiscovering(true);
    try {
      const response = await fetch("/api/agents/discover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gatewayUrl: gatewayUrl.trim() }),
      });

      if (!response.ok) {
        setAgents(null);
        setError("Unable to discover agents. Please check the gateway URL and try again.");
        return;
      }

      const body = (await response.json()) as { agents: DiscoveredAgent[] };
      setAgents(body.agents);
      setConnections({});
    } catch {
      setAgents(null);
      setError("Unable to discover agents. Please check the gateway URL and try again.");
    } finally {
      setIsDiscovering(false);
    }
  }

  async function handleConnect(agent: DiscoveredAgent): Promise<void> {
    setConnections((previous) => ({ ...previous, [agent.url]: { phase: "connecting" } }));
    try {
      const response = await fetch("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: agent.name, baseUrl: agent.url, authType: "none" }),
      });

      if (!response.ok) {
        setConnections((previous) => ({ ...previous, [agent.url]: { phase: "error" } }));
        return;
      }

      const body = (await response.json()) as { agent?: { id?: unknown; status?: StatusValue } };
      const agentId = body.agent?.id;
      const health = body.agent?.status;
      if (typeof agentId !== "string" || health === undefined) {
        setConnections((previous) => ({ ...previous, [agent.url]: { phase: "error" } }));
        return;
      }

      setConnections((previous) => ({
        ...previous,
        [agent.url]: { phase: "connected", health },
      }));
      router.push(`/agents/${agentId}`);
      router.refresh();
    } catch {
      setConnections((previous) => ({ ...previous, [agent.url]: { phase: "error" } }));
    }
  }

  return (
    <div className="grid gap-5">
      <form onSubmit={handleDiscover} className="grid gap-2" noValidate>
        <Label htmlFor="gateway-url">Gateway URL</Label>
        <div className="flex gap-2">
          <Input
            id="gateway-url"
            name="gatewayUrl"
            placeholder="https://eveland.example.com"
            value={gatewayUrl}
            onChange={(event) => setGatewayUrl(event.target.value)}
          />
          <Button type="submit" disabled={isDiscovering}>
            {isDiscovering ? "Discovering…" : "Discover"}
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
      </form>

      {agents !== null ? (
        agents.length === 0 ? (
          <p className="text-muted-foreground text-sm">No running agents found at this gateway.</p>
        ) : (
          <ul className="grid gap-3">
            {agents.map((agent) => {
              const connection = connections[agent.url];
              return (
                <li key={agent.url} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{agent.name}</p>
                    <p className="text-muted-foreground truncate text-xs">{agent.url}</p>
                    {connection?.phase === "error" ? (
                      <p role="alert" className="text-destructive text-sm">
                        Unable to connect this agent.
                      </p>
                    ) : null}
                  </div>
                  {connection?.phase === "connected" ? (
                    <StatusBadge status={connection.health} />
                  ) : agent.connected ? (
                    <span className="text-muted-foreground text-sm">Connected</span>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={connection?.phase === "connecting"}
                      aria-label={`Connect ${agent.name}`}
                      onClick={() => handleConnect(agent)}
                    >
                      {connection?.phase === "connecting" ? "Connecting…" : "Connect"}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )
      ) : null}
    </div>
  );
}
