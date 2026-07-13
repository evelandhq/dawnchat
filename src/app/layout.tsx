import type { Metadata } from "next";
import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { Geist } from "next/font/google";

import "./globals.css";

import { AppHeader } from "@/components/app-header";
import { AppSidebar, getAppNavigationData } from "@/components/app-sidebar";
import { ThemeProvider } from "@/components/theme-provider";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "Eve Chats",
  description: "Connect Eve agents and start chats.",
};

export default async function RootLayout({ children }: { children: ReactNode }): Promise<React.ReactElement> {
  const [cookieStore, navigationData] = await Promise.all([cookies(), getAppNavigationData()]);
  const defaultOpen = cookieStore.get("sidebar_state")?.value !== "false";

  return (
    <html lang="en" className={cn("font-sans", geist.variable)} suppressHydrationWarning>
      <body className="antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <SidebarProvider defaultOpen={defaultOpen}>
            <AppSidebar data={navigationData} />
            <SidebarInset className="h-svh overflow-hidden">
              <AppHeader {...navigationData} />
              <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
            </SidebarInset>
          </SidebarProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
