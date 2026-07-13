"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { usePathname } from "next/navigation";
import { MessageSquare, Plus } from "lucide-react";

import { AgentAvatar } from "@/components/agent-avatar";
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { deriveCurrentAgentId } from "@/lib/current-agent";
import { cn } from "@/lib/utils";

export type SidebarAgentItem = {
  id: string;
  name: string;
  status: "unknown" | "healthy" | "unreachable";
};

export type SidebarChatItem = {
  id: string;
  title: string;
  agentConnectionId: string;
};

type SidebarNavProps = {
  agents: SidebarAgentItem[];
  chats: SidebarChatItem[];
};

export function SidebarNav({ agents, chats }: SidebarNavProps): React.ReactElement {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();

  useEffect(() => {
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);

  const derivedAgentId = deriveCurrentAgentId(
    pathname,
    chats,
    agents.map((agent) => agent.id),
  );
  const routedAgentId =
    derivedAgentId !== null &&
    (pathname === `/agents/${derivedAgentId}` ||
      chats.some(
        (chat) => pathname === `/chats/${chat.id}` && chat.agentConnectionId === derivedAgentId,
      ))
      ? derivedAgentId
      : null;
  const [selectedAgentId, setSelectedAgentId] = useState(derivedAgentId);

  useEffect(() => {
    if (routedAgentId) {
      setSelectedAgentId(routedAgentId);
    } else if (selectedAgentId !== null && !agents.some((agent) => agent.id === selectedAgentId)) {
      setSelectedAgentId(derivedAgentId);
    }
  }, [agents, derivedAgentId, routedAgentId, selectedAgentId]);

  const currentAgentId =
    routedAgentId ??
    (selectedAgentId !== null && agents.some((agent) => agent.id === selectedAgentId)
      ? selectedAgentId
      : derivedAgentId);
  const currentAgentChats = chats.filter((chat) => chat.agentConnectionId === currentAgentId);

  return (
    <>
      <SidebarGroup>
        <SidebarGroupLabel>Agents</SidebarGroupLabel>
        <SidebarGroupAction asChild className="h-5 w-auto aspect-auto px-1.5 text-xs font-medium">
          <Link href={"/agents" as Route}>View all</Link>
        </SidebarGroupAction>
        <SidebarGroupContent>
          <div className="flex flex-wrap gap-1 px-1 py-1">
            {agents.map((agent) => (
              <Link
                key={agent.id}
                href={`/agents/${agent.id}` as Route}
                title={agent.name}
                className={cn(
                  "hover:bg-sidebar-accent flex w-16 flex-col items-center gap-1 rounded-lg p-2 transition-colors",
                  agent.id === currentAgentId && "bg-sidebar-accent",
                )}
              >
                <AgentAvatar
                  agentId={agent.id}
                  name={agent.name}
                  size="lg"
                  showUnreachableDot={agent.status === "unreachable"}
                />
                <span className="text-sidebar-foreground/80 w-full truncate text-center text-xs">{agent.name}</span>
              </Link>
            ))}
            <Link
              href={"/agents/new" as Route}
              aria-label="New agent"
              className="hover:bg-sidebar-accent flex w-16 flex-col items-center gap-1 rounded-lg p-2 transition-colors"
            >
              <span className="border-sidebar-foreground/30 text-sidebar-foreground/60 flex size-10 items-center justify-center rounded-full border border-dashed">
                <Plus className="size-4" />
              </span>
              <span className="text-sidebar-foreground/60 w-full truncate text-center text-xs">New</span>
            </Link>
          </div>
        </SidebarGroupContent>
      </SidebarGroup>
      <SidebarGroup>
        <SidebarGroupLabel>Chats</SidebarGroupLabel>
        {currentAgentId ? (
          <SidebarGroupAction asChild title="New chat">
            <Link href={`/agents/${currentAgentId}` as Route} aria-label="New chat">
              <Plus />
            </Link>
          </SidebarGroupAction>
        ) : null}
        <SidebarGroupContent>
          {currentAgentChats.length === 0 ? (
            <p className="text-muted-foreground px-2 py-1.5 text-sm">No chats yet.</p>
          ) : (
            <SidebarMenu>
              {currentAgentChats.map((chat) => (
                <SidebarMenuItem key={chat.id}>
                  <SidebarMenuButton asChild isActive={pathname === `/chats/${chat.id}`} title={chat.title}>
                    <Link href={`/chats/${chat.id}` as Route}>
                      <MessageSquare />
                      <span className="truncate">{chat.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          )}
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  );
}
