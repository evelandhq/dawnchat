import Link from "next/link";
import type { Route } from "next";
import { Sparkles } from "lucide-react";

import { createRepository } from "@/db/repository";
import { getDbClient } from "@/db/provider";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { SidebarNav, type SidebarAgentItem, type SidebarChatItem } from "@/components/sidebar-nav";
import { ThemeToggle } from "@/components/theme-toggle";

export type AppNavigationData = {
  agents: SidebarAgentItem[];
  chats: SidebarChatItem[];
};

type AppSidebarProps = {
  data?: AppNavigationData;
};

export async function getAppNavigationData(): Promise<AppNavigationData> {
  const repository = createRepository(getDbClient());
  const [agents, chats] = await Promise.all([repository.listAgentConnections(), repository.listChats()]);

  return {
    agents: agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      status: agent.status,
    })),
    chats: chats
      .map((chat) => ({ id: chat.id, title: chat.title, agentConnectionId: chat.agentConnectionId }))
      .reverse(),
  };
}

export async function AppSidebar({ data }: AppSidebarProps = {}): Promise<React.ReactElement> {
  const navigationData = data ?? (await getAppNavigationData());

  return (
    <Sidebar>
      <SidebarHeader className="border-sidebar-border h-14 flex-row items-center gap-1 border-b">
        <SidebarMenu className="min-w-0 flex-1">
          <SidebarMenuItem>
            <SidebarMenuButton asChild className="h-10">
              <Link href={"/" as Route}>
                <div className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-lg">
                  <Sparkles className="size-4" />
                </div>
                <span className="text-base font-semibold">Eve Chats</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <ThemeToggle />
      </SidebarHeader>
      <SidebarContent>
        <SidebarNav agents={navigationData.agents} chats={navigationData.chats} />
      </SidebarContent>
    </Sidebar>
  );
}
