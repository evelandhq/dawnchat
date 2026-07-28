import Link from "next/link";
import type { Route } from "next";

import { AuthenticatedSidebarNav } from "@/components/authenticated-sidebar-nav";
import { createRepository } from "@/db/repository";
import { getDbClient } from "@/db/provider";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import type {
  SidebarAgentItem,
  SidebarChatItem,
} from "@/components/sidebar-nav";
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
  const agents = await repository.listAgentConnections();

  return {
    agents: agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      status: agent.status,
    })),
    // Identity-scoped chat history is loaded in the browser with an App Token.
    chats: [],
  };
}

export async function AppSidebar({ data }: AppSidebarProps = {}): Promise<React.ReactElement> {
  const navigationData = data ?? (await getAppNavigationData());

  return (
    <Sidebar>
      <SidebarHeader className="h-14 flex-row items-center gap-1">
        <SidebarMenu className="min-w-0 flex-1">
          <SidebarMenuItem>
            <SidebarMenuButton asChild className="h-10">
              <Link href={"/" as Route}>
                <span className="text-base font-semibold">EveChats</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <ThemeToggle />
        <SidebarTrigger />
      </SidebarHeader>
      <SidebarContent>
        <AuthenticatedSidebarNav initialChats={navigationData.chats} />
      </SidebarContent>
    </Sidebar>
  );
}
