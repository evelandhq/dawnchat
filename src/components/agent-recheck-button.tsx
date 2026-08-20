"use client";

import { useRef, useState } from "react";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";

export type CheckedAgent = {
  id: string;
  name: string;
  status: "unknown" | "healthy" | "unreachable";
};

export function AgentRecheckButton({
  agentId,
  onChecked,
}: {
  agentId: string;
  /** Receives the re-checked Agent so the page can re-render without a reload. */
  onChecked?: (agent: CheckedAgent) => void;
}): React.ReactElement {
  const isCheckingRef = useRef(false);
  const [isChecking, setIsChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onCheck(): Promise<void> {
    if (isCheckingRef.current) {
      return;
    }
    isCheckingRef.current = true;
    setError(null);
    setIsChecking(true);
    try {
      const response = await fetch(`/api/agents/${agentId}/check`, { method: "POST" });
      if (!response.ok) {
        setError("Health check failed.");
        return;
      }
      const body = (await response.json().catch(() => null)) as
        | { agent?: CheckedAgent }
        | null;
      if (body?.agent) onChecked?.(body.agent);
    } catch {
      setError("Health check failed.");
    } finally {
      isCheckingRef.current = false;
      setIsChecking(false);
    }
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <Button type="button" variant="outline" size="sm" onClick={onCheck} disabled={isChecking}>
        <RefreshCw />
        {isChecking ? "Checking…" : "Check again"}
      </Button>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
