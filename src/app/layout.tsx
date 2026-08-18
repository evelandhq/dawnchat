import type { Metadata } from "next";
import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { Inter } from "next/font/google";

import "./globals.css";

import { AppHeader } from "@/components/app-header";
import { AppSidebar, getAppNavigationData } from "@/components/app-sidebar";
import { ThemeProvider } from "@/components/theme-provider";
import { IdentityGate } from "@/components/identity-gate";
import { IdentityProvider } from "@/components/identity-provider";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: {
    default: "EveChats",
    template: "%s · EveChats",
  },
  description: "Connect Eve agents and start chats.",
};

export default async function RootLayout({ children }: { children: ReactNode }): Promise<React.ReactElement> {
  const [cookieStore, navigationData] = await Promise.all([cookies(), getAppNavigationData()]);
  const defaultOpen = cookieStore.get("sidebar_state")?.value !== "false";

  return (
    <html lang="en" className={cn("font-sans", inter.variable)} suppressHydrationWarning>
      <body className="antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <IdentityProvider
            baseUrl={
              process.env.NEXT_PUBLIC_EVELAND_IDENTITY_URL ??
              "http://localhost:4000"
            }
            returnTarget={
              process.env.NEXT_PUBLIC_EVELAND_IDENTITY_RETURN_TARGET ??
              "eve-chats"
            }
          >
            <IdentityGate>
              <SidebarProvider defaultOpen={defaultOpen}>
                <AppSidebar data={navigationData} />
                <SidebarInset className="h-svh overflow-hidden">
                  <AppHeader {...navigationData} />
                  <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
                </SidebarInset>
              </SidebarProvider>
            </IdentityGate>
          </IdentityProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
