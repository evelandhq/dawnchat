"use client";

import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { Bot, CircleAlert, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AgentAvatar } from "@/components/agent-avatar";
import { useEvelandIdentity } from "@/components/identity-provider";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { IdentityCatalog } from "@/identity/client";
import { cn } from "@/lib/utils";

type HistoricalChat = {
  id: string;
  agentConnectionId: string;
  agentName: string;
  evelandProjectId: string | null;
  title: string;
  lastMessage: string | null;
};

type ExternalAgent = {
  id: string;
  name: string;
  baseUrl: string;
  evelandProjectId?: string;
  status: "unknown" | "healthy" | "unreachable";
};

type CatalogState =
  | { kind: "loading" }
  | {
      kind: "ready";
      catalog: IdentityCatalog;
      chats: HistoricalChat[];
      externalAgents: ExternalAgent[];
    }
  | { kind: "error"; message: string };

export function AgentCatalog(): React.ReactElement {
  const router = useRouter();
  const { getAppToken, getCatalog, getSession } = useEvelandIdentity();
  const returnPath = "/agents";
  const [state, setState] = useState<CatalogState>({ kind: "loading" });
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [catalog, session] = await Promise.all([
          getCatalog(returnPath),
          getSession(),
        ]);
        const appToken = session.authenticated
          ? await getAppToken(returnPath)
          : null;
        const [response, agentsResponse] = await Promise.all([
          fetch("/api/chats", {
            ...(appToken
              ? { headers: { authorization: `Bearer ${appToken}` } }
              : {}),
            cache: "no-store",
          }),
          fetch("/api/agents", { cache: "no-store" }),
        ]);
        if (!response.ok) throw new Error("Unable to load conversation history.");
        const body = (await response.json()) as { chats?: HistoricalChat[] };
        if (!agentsResponse.ok) throw new Error("Unable to load external Agents.");
        const agentsBody = (await agentsResponse.json()) as {
          agents?: ExternalAgent[];
        };
        if (active) {
          setState({
            kind: "ready",
            catalog,
            chats: body.chats ?? [],
            externalAgents: (agentsBody.agents ?? []).filter(
              (agent) => !agent.evelandProjectId,
            ),
          });
        }
      } catch (error) {
        if (active) {
          setState({
            kind: "error",
            message:
              error instanceof Error ? error.message : "Unable to load Agents.",
          });
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [getAppToken, getCatalog, getSession]);

  const unavailableAgents = useMemo(() => {
    if (state.kind !== "ready") return [];
    const availableProjects = new Set(
      state.catalog.agents.map((agent) => agent.projectId),
    );
    const byProject = new Map<
      string,
      { name: string; chats: HistoricalChat[] }
    >();
    for (const chat of state.chats) {
      if (!chat.evelandProjectId || availableProjects.has(chat.evelandProjectId)) {
        continue;
      }
      const existing = byProject.get(chat.evelandProjectId);
      if (existing) {
        existing.chats.push(chat);
      } else {
        byProject.set(chat.evelandProjectId, {
          name: chat.agentName,
          chats: [chat],
        });
      }
    }
    return [...byProject.entries()].map(([projectId, value]) => ({
      projectId,
      ...value,
    }));
  }, [state]);

  async function openAgent(
    catalog: IdentityCatalog,
    agent: IdentityCatalog["agents"][number],
  ): Promise<void> {
    setOpeningProjectId(agent.projectId);
    setOpenError(null);
    try {
      const response = await fetch("/api/agents/catalog", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ issuer: catalog.issuer, ...agent }),
      });
      const body = (await response.json().catch(() => null)) as
        | { agent?: { id?: unknown }; error?: unknown }
        | null;
      const agentId = body?.agent?.id;
      if (!response.ok || typeof agentId !== "string") {
        throw new Error(
          typeof body?.error === "string"
            ? body.error
            : "Unable to open this Agent.",
        );
      }
      router.push(`/agents/${agentId}` as Route);
    } catch (error) {
      setOpeningProjectId(null);
      setOpenError(
        error instanceof Error ? error.message : "Unable to open this Agent.",
      );
    }
  }

  if (state.kind === "loading") {
    return (
      <div className="flex min-h-72 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        Loading your Agents…
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <section className="mx-auto w-full max-w-2xl p-6">
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>Unable to load your Agents</AlertTitle>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      </section>
    );
  }

  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Your Agents</h1>
          <p className="text-muted-foreground text-sm">
            Routable chat-enabled Agents published by Eveland.
          </p>
        </div>
        <Link
          href={"/agents/new" as Route}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
        >
          <Plus />
          Add external Agent
        </Link>
      </header>

      {openError ? (
        <p role="alert" className="text-destructive text-sm">
          {openError}
        </p>
      ) : null}

      {state.catalog.agents.length === 0 &&
      state.externalAgents.length === 0 &&
      unavailableAgents.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed px-6 py-16 text-center">
          <div className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
            <Bot className="size-6" />
          </div>
          <p className="font-medium">No chat-enabled Agents are available.</p>
          <p className="text-muted-foreground max-w-sm text-sm">
            Deploy and route an Eve Channel Project in Eveland, or add an
            external Eve Agent manually.
          </p>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {state.catalog.agents.map((agent) => (
          <button
            key={agent.projectId}
            type="button"
            aria-label={`Chat with ${agent.name}`}
            disabled={openingProjectId !== null}
            onClick={() => void openAgent(state.catalog, agent)}
            className="hover:bg-muted/50 focus-visible:ring-ring flex min-h-32 items-start gap-4 rounded-2xl border p-5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:opacity-60"
          >
            <AgentAvatar agentId={agent.projectId} name={agent.name} />
            <span className="min-w-0 flex-1 space-y-2">
              <span className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{agent.name}</span>
                <Badge variant="outline">Eveland</Badge>
              </span>
              <span className="text-muted-foreground line-clamp-2 block text-sm">
                {agent.description ?? "Ready to chat."}
              </span>
              {openingProjectId === agent.projectId ? (
                <span className="text-muted-foreground block text-xs">Opening…</span>
              ) : null}
            </span>
          </button>
        ))}
        {state.externalAgents.map((agent) => (
          <Link
            key={agent.id}
            href={`/agents/${agent.id}` as Route}
            aria-label={`Chat with ${agent.name}`}
            className="hover:bg-muted/50 focus-visible:ring-ring flex min-h-32 items-start gap-4 rounded-2xl border p-5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2"
          >
            <AgentAvatar
              agentId={agent.id}
              name={agent.name}
              showUnreachableDot={agent.status === "unreachable"}
            />
            <span className="min-w-0 flex-1 space-y-2">
              <span className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{agent.name}</span>
                <Badge variant="secondary">External</Badge>
              </span>
              <span className="text-muted-foreground line-clamp-2 block text-sm">
                {agent.baseUrl}
              </span>
            </span>
          </Link>
        ))}
      </div>

      {unavailableAgents.length > 0 ? (
        <section className="space-y-3" aria-labelledby="unavailable-agents">
          <h2 id="unavailable-agents" className="text-sm font-medium">
            Conversation history
          </h2>
          {unavailableAgents.map((agent) => (
            <div key={agent.projectId} className="rounded-xl border p-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="font-medium">{agent.name}</span>
                <Badge variant="secondary">Unavailable</Badge>
              </div>
              <ul className="space-y-1">
                {[...agent.chats].reverse().map((chat) => (
                  <li key={chat.id}>
                    <Link
                      href={`/chats/${chat.id}` as Route}
                      aria-label={`Open ${chat.title}`}
                      className="text-muted-foreground hover:text-foreground block truncate text-sm"
                    >
                      {chat.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ) : null}
    </section>
  );
}
