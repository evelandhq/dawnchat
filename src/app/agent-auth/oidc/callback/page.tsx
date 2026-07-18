"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { agentAuthCallbackSearch, safeAgentAuthReturnPath } from "@/lib/agent-auth-callback";

export default function OidcAgentAuthCallbackPage(): React.ReactElement {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const search = agentAuthCallbackSearch(window.location.search);
    window.history.replaceState(null, "", window.location.pathname);
    if (!search) {
      setError("The identity provider response is missing its state parameter.");
      return;
    }
    fetch("/api/agent-auth/oidc/callback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ search }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Agent authorization could not be completed.");
        return response.json() as Promise<{ returnPath: string }>;
      })
      .then(({ returnPath }) => router.replace(safeAgentAuthReturnPath(returnPath) as Route))
      .catch((caught) => {
        setError(caught instanceof Error ? caught.message : "Agent authorization could not be completed.");
      });
  }, [router]);

  return (
    <main className="flex min-h-full items-center justify-center bg-muted/40 px-5 py-10">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Agent authorization</CardTitle>
          <CardDescription>
            Completing the OIDC grant for this Agent Connection. Tokens stay on the server.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Authorization failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : (
            <p className="text-muted-foreground text-sm">Finishing authorization…</p>
          )}
        </CardContent>
        {error ? (
          <CardFooter>
            <Button variant="outline" onClick={() => router.replace("/agents")}>Back to agents</Button>
          </CardFooter>
        ) : null}
      </Card>
    </main>
  );
}
