"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { useChatList } from "@/components/chat-list-provider";
import { Spinner } from "@/components/ui/spinner";

export function HomeRedirect(): React.ReactElement {
  const router = useRouter();
  const { state } = useChatList();

  useEffect(() => {
    if (state.status === "loading") return;
    const recentChat = state.chats?.[0];
    router.replace(
      (recentChat
        ? `/chats/${encodeURIComponent(recentChat.id)}`
        : "/agents") as Route,
    );
  }, [router, state]);

  return (
    <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
      <Spinner />
      Opening conversation…
    </div>
  );
}
