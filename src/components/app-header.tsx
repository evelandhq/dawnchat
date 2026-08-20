"use client";

import Link from "next/link";
import type { Route } from "next";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ChevronDown, Info, MessageSquarePlus } from "lucide-react";

import { useChatList } from "@/components/chat-list-provider";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import type { SidebarAgentItem } from "@/components/sidebar-nav";
import { deriveCurrentAgentId } from "@/lib/current-agent";

export function AppHeader(): React.ReactElement {
  const pathname = usePathname();
  const { state, isMobile } = useSidebar();
  const { state: chatList } = useChatList();
  const [agents, setAgents] = useState<SidebarAgentItem[]>([]);
  const showSidebarTrigger = isMobile || state === "collapsed";

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch("/api/agents", { cache: "no-store" });
        if (!response.ok) return;
        const body = (await response.json()) as { agents?: SidebarAgentItem[] };
        if (active && body.agents) setAgents(body.agents);
      } catch {
        // The header falls back to showing nothing; the next route change retries.
      }
    })();
    return () => {
      active = false;
    };
  }, [pathname]);

  const chats = chatList.chats ?? [];
  const currentAgentId = deriveCurrentAgentId(
    pathname,
    chats,
    agents.map((agent) => agent.id),
  );
  const isExplicitAgentRoute = currentAgentId !== null && pathname === `/agents/${currentAgentId}`;
  const isExplicitChatRoute =
    currentAgentId !== null &&
    chats.some((chat) => pathname === `/chats/${chat.id}` && chat.agentConnectionId === currentAgentId);
  const currentAgent =
    isExplicitAgentRoute || isExplicitChatRoute ? agents.find((agent) => agent.id === currentAgentId) : undefined;

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 px-4">
      {showSidebarTrigger ? <SidebarTrigger className="-ml-1" /> : null}
      {currentAgent ? (
        <div className="flex min-w-0 items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="min-w-0 px-2">
                <span className="truncate text-sm font-medium">{currentAgent.name}</span>
                <ChevronDown data-icon="inline-end" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuGroup>
                <DropdownMenuItem asChild>
                  <Link href={`/agents/${currentAgent.id}/edit` as Route}>
                    <Info />
                    Agent Info
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href={`/agents/${currentAgent.id}` as Route}>
                    <MessageSquarePlus />
                    New Chat
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <StatusBadge status={currentAgent.status} />
        </div>
      ) : null}
    </header>
  );
}
