"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

import { useEvelandIdentity } from "@/components/identity-provider";
import {
  SidebarNav,
  type SidebarChatItem,
} from "@/components/sidebar-nav";

export function AuthenticatedSidebarNav({
  initialChats,
}: {
  initialChats: SidebarChatItem[];
}): React.ReactElement {
  const pathname = usePathname();
  const { getAppToken, getSession } = useEvelandIdentity();
  const [chats, setChats] = useState(initialChats);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const session = await getSession();
        const token = session.authenticated
          ? await getAppToken(pathname)
          : null;
        const response = await fetch("/api/chats", {
          ...(token
            ? { headers: { authorization: `Bearer ${token}` } }
            : {}),
          cache: "no-store",
        });
        if (!response.ok) return;
        const body = (await response.json()) as {
          chats?: SidebarChatItem[];
        };
        if (active) setChats(body.chats ?? []);
      } catch {
        // Identity navigation and transient failures leave the last known
        // navigation state in place. The next route change retries the load.
      }
    })();
    return () => {
      active = false;
    };
  }, [getAppToken, getSession, pathname]);

  return <SidebarNav chats={chats} />;
}
