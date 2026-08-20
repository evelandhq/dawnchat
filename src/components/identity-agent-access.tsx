"use client";

import Link from "next/link";
import type { Route } from "next";
import { useCallback, useMemo } from "react";
import { CircleAlert, ShieldCheck } from "lucide-react";

import { NewChatComposer } from "@/components/new-chat-composer";
import { useChatList } from "@/components/chat-list-provider";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useEvelandIdentity } from "@/components/identity-provider";
import { EvelandIdentityError } from "@/identity/client";
import { cn } from "@/lib/utils";

export function IdentityAgentAccess({
  agentId,
  agentName,
  disabled,
}: {
  agentId: string;
  agentName: string;
  disabled: boolean;
}): React.ReactElement {
  const { getAppToken, getSession, switchRealm } = useEvelandIdentity();
  const returnPath = `/agents/${agentId}`;
  const { state, refresh } = useChatList();
  const agentChats = useMemo(
    () =>
      (state.chats ?? []).filter(
        (chat) => chat.agentConnectionId === agentId,
      ),
    [agentId, state.chats],
  );
  // Resolved when the user actually sends, so composing never waits on
  // Identity. Both reads are memoised by the Identity client.
  const getAccessToken = useCallback(async (): Promise<string | null> => {
    const session = await getSession();
    return session.authenticated ? getAppToken(returnPath) : null;
  }, [getAppToken, getSession, returnPath]);

  // A login redirect is already navigating away; it is not a failed check.
  if (state.status === "error" && isRedirecting(state.error)) {
    return (
      <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        Checking access…
      </div>
    );
  }

  if (state.status === "error") {
    if (state.error instanceof EvelandIdentityError && state.error.status === 403) {
      return (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>Eveland rejected access to {agentName}</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>{state.error.message}</p>
            <Button
              type="button"
              variant="outline"
              onClick={() => switchRealm(returnPath)}
            >
              Switch identity scope
            </Button>
          </AlertDescription>
        </Alert>
      );
    }
    return (
      <Alert variant="destructive">
        <CircleAlert />
        <AlertTitle>Identity check failed</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>
            {state.error instanceof Error
              ? state.error.message
              : "Unable to verify your Eveland identity."}
          </p>
          <Button type="button" variant="outline" onClick={() => void refresh()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)] gap-8">
      {/* Holds its box while the scope resolves so the composer never moves. */}
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-3 border-b pb-4",
          state.status === "loading" && "invisible",
          state.status !== "loading" && !state.authenticated && "hidden",
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <ShieldCheck className="size-4 text-primary" />
          <span className="truncate text-sm font-medium">Eveland identity</span>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={state.status === "loading"}
          onClick={() => switchRealm(returnPath)}
        >
          Switch scope
        </Button>
      </div>

      <NewChatComposer
        agentId={agentId}
        agentName={agentName}
        disabled={disabled}
        getAccessToken={getAccessToken}
      />

      {agentChats.length > 0 ? (
        <section
          className="grid min-w-0 gap-3"
          aria-labelledby="recent-chats-title"
        >
          <h2 id="recent-chats-title" className="text-sm font-medium">
            Recent conversations
          </h2>
          <ul className="grid min-w-0 list-none gap-1 p-0">
            {[...agentChats].reverse().slice(0, 6).map((chat) => (
              <li key={chat.id} className="min-w-0">
                <Button
                  asChild
                  variant="ghost"
                  className="h-auto w-full min-w-0 justify-start px-3 py-2"
                >
                  <Link className="min-w-0" href={`/chats/${chat.id}` as Route}>
                    <span className="min-w-0 text-left">
                      <span className="block truncate text-sm font-medium">
                        {chat.title}
                      </span>
                      {chat.lastMessage ? (
                        <span className="text-muted-foreground block truncate text-xs">
                          {chat.lastMessage}
                        </span>
                      ) : null}
                    </span>
                  </Link>
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function isRedirecting(error: unknown): boolean {
  return (
    error instanceof EvelandIdentityError &&
    error.code === "identity_redirecting"
  );
}
