"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { useEvelandIdentity } from "@/components/identity-provider";
import { Spinner } from "@/components/ui/spinner";

type HomeChat = {
  id: string;
};

export function HomeRedirect(): React.ReactElement {
  const router = useRouter();
  const { getAppToken, getSession } = useEvelandIdentity();

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const session = await getSession();
        const token = session.authenticated ? await getAppToken("/") : null;
        const response = await fetch("/api/chats", {
          ...(token
            ? { headers: { authorization: `Bearer ${token}` } }
            : {}),
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Unable to load chats.");
        const body = (await response.json()) as { chats?: HomeChat[] };
        if (!active) return;
        const recentChat = body.chats?.[0];
        router.replace(
          (recentChat
            ? `/chats/${encodeURIComponent(recentChat.id)}`
            : "/agents") as Route,
        );
      } catch {
        if (active) router.replace("/agents");
      }
    })();
    return () => {
      active = false;
    };
  }, [getAppToken, getSession, router]);

  return (
    <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
      <Spinner />
      Opening conversation…
    </div>
  );
}
