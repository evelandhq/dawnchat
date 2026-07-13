"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";

export function AgentRecheckButton({ agentId }: { agentId: string }): React.ReactElement {
  const router = useRouter();
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
      router.refresh();
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
