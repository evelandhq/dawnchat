import Link from "next/link";
import type { Route } from "next";

import { AuthenticatedSidebarNav } from "@/components/authenticated-sidebar-nav";
import { SidebarAccount } from "@/components/sidebar-account";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";

export function AppSidebar(): React.ReactElement {
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
        <AuthenticatedSidebarNav />
      </SidebarContent>
      <SidebarFooter>
        <SidebarAccount />
      </SidebarFooter>
    </Sidebar>
  );
}
