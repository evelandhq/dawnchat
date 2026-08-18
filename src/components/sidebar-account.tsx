"use client";

import { ChevronsUpDown, LogOut, Repeat2 } from "lucide-react";
import { usePathname } from "next/navigation";

import { useEvelandIdentity } from "@/components/identity-provider";
import { EvelandIdentityError } from "@/identity/client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

function ignoreLoginRedirect(error: unknown): void {
  if (
    error instanceof EvelandIdentityError &&
    error.code === "identity_redirecting"
  ) {
    return;
  }
  throw error;
}

export function SidebarAccount(): React.ReactElement | null {
  const pathname = usePathname();
  const { session, login, logout, switchRealm } = useEvelandIdentity();

  if (!session?.authenticated) {
    return null;
  }

  const displayName =
    session.principal.name ?? session.principal.email ?? session.principal.id;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton className="h-12" aria-label="Account">
              <div className="flex min-w-0 flex-1 flex-col text-left leading-tight">
                <span className="truncate text-sm font-medium">
                  {displayName}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {session.activeRealm.name}
                </span>
              </div>
              <ChevronsUpDown className="size-4 shrink-0" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-56">
            <DropdownMenuLabel className="flex flex-col">
              <span className="truncate">{displayName}</span>
              {session.principal.email ? (
                <span className="truncate text-xs font-normal text-muted-foreground">
                  {session.principal.email}
                </span>
              ) : null}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                try {
                  switchRealm(pathname);
                } catch (error) {
                  ignoreLoginRedirect(error);
                }
              }}
            >
              <Repeat2 className="size-4" />
              Switch identity scope
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                void (async () => {
                  await logout();
                  try {
                    // The app requires a signed-in identity, so signing out
                    // lands on the Eveland login page.
                    login(pathname);
                  } catch (error) {
                    ignoreLoginRedirect(error);
                  }
                })();
              }}
            >
              <LogOut className="size-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
