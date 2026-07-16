"use client";

import Link from "next/link";
import type { Route } from "next";
import { usePathname } from "next/navigation";
import { ChevronDown, Info, MessageSquarePlus } from "lucide-react";

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
import type { SidebarAgentItem, SidebarChatItem } from "@/components/sidebar-nav";
import { deriveCurrentAgentId } from "@/lib/current-agent";

type AppHeaderProps = {
  agents: SidebarAgentItem[];
  chats: SidebarChatItem[];
};

export function AppHeader({ agents, chats }: AppHeaderProps): React.ReactElement {
  const pathname = usePathname();
  const { state, isMobile } = useSidebar();
  const showSidebarTrigger = isMobile || state === "collapsed";
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
