import Link from "next/link";
import type { Route } from "next";
import { Bot, MessageSquarePlus, Sparkles } from "lucide-react";

import { createRepository } from "@/db/repository";
import { getDbClient } from "@/db/provider";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { SidebarChatNav, type SidebarChatItem } from "@/components/sidebar-chat-nav";
import { ThemeToggle } from "@/components/theme-toggle";

export async function AppSidebar(): Promise<React.ReactElement> {
  const repository = createRepository(getDbClient());
  const chats = await repository.listChats();
  const items: SidebarChatItem[] = chats
    .map((chat) => ({ id: chat.id, title: chat.title }))
    .reverse();

  return (
    <Sidebar>
      <SidebarHeader className="gap-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg">
              <Link href={"/chats" as Route}>
                <div className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-lg">
                  <Sparkles className="size-4" />
                </div>
                <span className="text-base font-semibold">Eve Chats</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <Button asChild variant="outline" className="justify-start">
          <Link href={"/chats" as Route}>
            <MessageSquarePlus />
            New chat
          </Link>
        </Button>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Chats</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarChatNav chats={items} />
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <div className="flex items-center justify-between gap-2">
          <SidebarMenu className="flex-1">
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <Link href="/agents">
                  <Bot />
                  Agents
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <ThemeToggle />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
