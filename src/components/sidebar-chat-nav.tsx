"use client";

import Link from "next/link";
import type { Route } from "next";
import { usePathname } from "next/navigation";
import { MessageSquare } from "lucide-react";

import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";

export type SidebarChatItem = {
  id: string;
  title: string;
};

export function SidebarChatNav({ chats }: { chats: SidebarChatItem[] }): React.ReactElement {
  const pathname = usePathname();

  if (chats.length === 0) {
    return <p className="text-muted-foreground px-2 py-1.5 text-sm">No chats yet.</p>;
  }

  return (
    <SidebarMenu>
      {chats.map((chat) => (
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
  );
}
