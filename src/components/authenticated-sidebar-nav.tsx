"use client";

import { useChatList } from "@/components/chat-list-provider";
import {
  SidebarNav,
  type SidebarChatItem,
} from "@/components/sidebar-nav";

export function AuthenticatedSidebarNav({
  initialChats,
}: {
  initialChats: SidebarChatItem[];
}): React.ReactElement {
  const { state } = useChatList();

  return <SidebarNav chats={state.chats ?? initialChats} />;
}
