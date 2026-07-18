'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { usePathname } from 'next/navigation';
import { Box, SquarePen } from 'lucide-react';

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';

export type SidebarAgentItem = {
  id: string;
  name: string;
  status: 'unknown' | 'healthy' | 'unreachable' | 'authorization_required';
};

export type SidebarChatItem = {
  id: string;
  title: string;
  agentConnectionId: string;
};

type SidebarNavProps = {
  chats: SidebarChatItem[];
};

export function SidebarNav({ chats }: SidebarNavProps): React.ReactElement {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();

  useEffect(() => {
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);

  return (
    <>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={pathname === '/chats/new'}>
                <Link href={'/chats/new' as Route}>
                  <SquarePen />
                  <span>New Chat</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={pathname === '/agents'}>
                <Link href={'/agents' as Route}>
                  <Box />
                  <span>Agents</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      <SidebarGroup>
        <SidebarGroupLabel>Chats</SidebarGroupLabel>
        <SidebarGroupContent>
          {chats.length === 0 ? (
            <p className="text-muted-foreground px-2 py-1.5 text-sm">No chats yet.</p>
          ) : (
            <SidebarMenu className="gap-[1px]">
              {chats.map((chat) => (
                <SidebarMenuItem key={chat.id}>
                  <SidebarMenuButton
                    asChild
                    isActive={pathname === `/chats/${chat.id}`}
                    title={chat.title}
                  >
                    <Link href={`/chats/${chat.id}` as Route}>
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
