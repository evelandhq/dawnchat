"use client";

import Link from "next/link";
import type { Route } from "next";
import { useEffect, useState } from "react";
import { CircleAlert, ShieldCheck } from "lucide-react";

import { NewChatComposer } from "@/components/new-chat-composer";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useEvelandIdentity } from "@/components/identity-provider";
import { EvelandIdentityError } from "@/identity/client";

type RecentChat = {
  id: string;
  title: string;
  agentConnectionId: string;
  lastMessage: string | null;
};

export function IdentityAgentAccess({
  agentId,
  agentName,
  disabled,
}: {
  agentId: string;
  agentName: string;
  disabled: boolean;
}): React.ReactElement {
  const {
    getAppToken,
    getSession,
    switchRealm,
  } = useEvelandIdentity();
  const returnPath = `/agents/${agentId}`;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; chats: RecentChat[]; authenticated: boolean }
    | { kind: "forbidden"; message: string }
    | { kind: "error"; message: string }
  >({ kind: "loading" });

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const session = await getSession();
        const token = session.authenticated
          ? await getAppToken(returnPath)
          : null;
        const response = await fetch("/api/chats", {
          ...(token
            ? { headers: { authorization: `Bearer ${token}` } }
            : {}),
          cache: "no-store",
        });
        if (!response.ok) throw await localApiError(response);
        const body = (await response.json()) as { chats?: RecentChat[] };
        if (active) {
          setState({
            kind: "ready",
            chats: (body.chats ?? []).filter(
              (chat) => chat.agentConnectionId === agentId,
            ),
            authenticated: session.authenticated,
          });
        }
      } catch (error) {
        if (!active || isRedirecting(error)) return;
        if (error instanceof EvelandIdentityError && error.status === 403) {
          setState({ kind: "forbidden", message: error.message });
        } else {
          setState({
            kind: "error",
            message:
              error instanceof Error
                ? error.message
                : "Unable to verify your Eveland identity.",
          });
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [agentId, attempt, getAppToken, getSession, returnPath]);

  if (state.kind === "loading") {
    return (
      <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        Checking access…
      </div>
    );
  }

  if (state.kind === "forbidden") {
    return (
      <Alert variant="destructive">
        <CircleAlert />
        <AlertTitle>Eveland rejected access to {agentName}</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>{state.message}</p>
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

  if (state.kind === "error") {
    return (
      <Alert variant="destructive">
        <CircleAlert />
        <AlertTitle>Identity check failed</AlertTitle>
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

  return (
    <div className="grid w-full gap-8">
      {state.authenticated ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
          <div className="flex min-w-0 items-center gap-2">
            <ShieldCheck className="size-4 text-primary" />
            <span className="truncate text-sm font-medium">
              Eveland identity
            </span>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => switchRealm(returnPath)}
          >
            Switch scope
          </Button>
        </div>
      ) : null}

      <NewChatComposer
        agentId={agentId}
        agentName={agentName}
        disabled={disabled}
        getAccessToken={
          state.authenticated
            ? () => getAppToken(returnPath)
            : undefined
        }
      />

      {state.chats.length > 0 ? (
        <section className="grid gap-3" aria-labelledby="recent-chats-title">
          <h2 id="recent-chats-title" className="text-sm font-medium">
            Recent conversations
          </h2>
          <ul className="grid list-none gap-1 p-0">
            {[...state.chats].reverse().slice(0, 6).map((chat) => (
              <li key={chat.id}>
                <Button asChild variant="ghost" className="h-auto w-full justify-start px-3 py-2">
                  <Link href={`/chats/${chat.id}` as Route}>
                    <span className="min-w-0 text-left">
                      <span className="block truncate text-sm font-medium">{chat.title}</span>
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

async function localApiError(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as
    | { error?: unknown }
    | null;
  return new Error(
    typeof body?.error === "string" ? body.error : "Unable to load conversations.",
  );
}
