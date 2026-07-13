"use client";

import { usePathname } from "next/navigation";

import { StatusBadge } from "@/components/status-badge";
import { SidebarTrigger } from "@/components/ui/sidebar";
import type { SidebarAgentItem, SidebarChatItem } from "@/components/sidebar-nav";
import { deriveCurrentAgentId } from "@/lib/current-agent";

type AppHeaderProps = {
  agents: SidebarAgentItem[];
  chats: SidebarChatItem[];
};

export function AppHeader({ agents, chats }: AppHeaderProps): React.ReactElement {
  const pathname = usePathname();
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
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ml-1" />
      {currentAgent ? (
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{currentAgent.name}</span>
          <StatusBadge status={currentAgent.status} />
        </div>
      ) : (
        <span className="text-sm font-medium">Eve Chats</span>
      )}
    </header>
  );
}
