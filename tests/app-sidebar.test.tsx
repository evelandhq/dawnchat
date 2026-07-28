import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";

import { AppSidebar } from "@/components/app-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { setDbClientForTests } from "@/db/provider";
import { createTestDbHandle, type TestDbHandle } from "@/test/db";

const { getAppToken, getSession } = vi.hoisted(() => ({
  getAppToken: vi.fn<() => Promise<string>>(),
  getSession: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "dark", setTheme: vi.fn() }),
}));

vi.mock("@/components/identity-provider", () => ({
  useEvelandIdentity: () => ({ getAppToken, getSession }),
}));

describe("AppSidebar", () => {
  let testDb: TestDbHandle;

  beforeEach(async () => {
    testDb = await createTestDbHandle();
    setDbClientForTests(testDb.db);
    getAppToken.mockReset();
    getSession.mockReset();
    getSession.mockResolvedValue({
      authenticated: true,
      principal: { id: "iprn_user", name: "Test User", email: null },
      activeRealm: { id: "irlm_account", name: "Account" },
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    setDbClientForTests(null);
    await testDb.close();
  });

  it("places the theme toggle beside the EveChats title without a header divider", async () => {
    const sidebar = await AppSidebar();
    const { container } = render(<SidebarProvider>{sidebar}</SidebarProvider>);
    const header = container.querySelector('[data-sidebar="header"]');

    expect(header).not.toBeNull();
    expect(header).toHaveClass("h-14", "flex-row", "items-center");
    expect(header).not.toHaveClass("border-b");
    const brandLink = within(header as HTMLElement).getByRole("link", { name: "EveChats" });
    expect(brandLink).toHaveClass("h-10");
    expect(within(header as HTMLElement).getByRole("button", { name: "Toggle theme" })).toBeInTheDocument();
    expect(container.querySelector('[data-sidebar="footer"]')).not.toBeInTheDocument();
  });

  it("offers New Chat and Agents navigation entries", async () => {
    const sidebar = await AppSidebar();
    render(<SidebarProvider>{sidebar}</SidebarProvider>);

    expect(screen.getByRole("link", { name: "New Chat" })).toHaveAttribute("href", "/chats/new");
    expect(screen.getByRole("link", { name: "Agents" })).toHaveAttribute("href", "/agents");
  });

  it("loads identity-scoped chats with an App Token", async () => {
    getAppToken.mockResolvedValue("app-token");
    const fetchMock = vi.fn(async () =>
      Response.json({
        chats: [
          {
            id: "chat_history",
            title: "Previous conversation",
            agentConnectionId: "agent_support",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const sidebar = await AppSidebar();
    render(<SidebarProvider>{sidebar}</SidebarProvider>);

    expect(
      await screen.findByRole("link", { name: "Previous conversation" }),
    ).toHaveAttribute("href", "/chats/chat_history");
    expect(getAppToken).toHaveBeenCalledWith("/");
    expect(fetchMock).toHaveBeenCalledWith("/api/chats", {
      headers: { authorization: "Bearer app-token" },
      cache: "no-store",
    });
  });

  it("loads browser-session chats without starting login for an unauthenticated visitor", async () => {
    getSession.mockResolvedValue({ authenticated: false });
    getAppToken.mockResolvedValue("unexpected-app-token");
    const fetchMock = vi.fn(async () =>
      Response.json({
        chats: [
          {
            id: "chat_guest",
            title: "Anonymous conversation",
            agentConnectionId: "agent_support",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const sidebar = await AppSidebar();
    render(<SidebarProvider>{sidebar}</SidebarProvider>);

    await waitFor(() => expect(getSession).toHaveBeenCalledOnce());
    expect(getAppToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith("/api/chats", {
      cache: "no-store",
    });
    expect(
      await screen.findByRole("link", { name: "Anonymous conversation" }),
    ).toHaveAttribute("href", "/chats/chat_guest");
  });
});
