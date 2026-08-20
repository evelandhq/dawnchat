"use client";

import { useChatList } from "@/components/chat-list-provider";
import { SidebarNav } from "@/components/sidebar-nav";

export function AuthenticatedSidebarNav(): React.ReactElement {
  const { state } = useChatList();

  return <SidebarNav chats={state.chats ?? []} />;
}
