import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";

import { AppSidebar } from "@/components/app-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { renderWithChatList } from "@/test/chat-list";

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
  useEvelandIdentity: () => ({
    session: {
      authenticated: true,
      principal: { id: "iprn_user", name: "Test User", email: null },
      activeRealm: { id: "irlm_account", name: "Account" },
    },
    getAppToken,
    getSession,
    login: vi.fn(),
    logout: vi.fn(),
    switchRealm: vi.fn(),
  }),
}));

describe("AppSidebar", () => {
  beforeEach(() => {
    getAppToken.mockReset();
    getSession.mockReset();
    getSession.mockResolvedValue({
      authenticated: true,
      principal: { id: "iprn_user", name: "Test User", email: null },
      activeRealm: { id: "irlm_account", name: "Account" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ chats: [] })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("places the theme toggle beside the EveChats title without a header divider", () => {
    const { container } = renderWithChatList(
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>,
    );
    const header = container.querySelector('[data-sidebar="header"]');

    expect(header).not.toBeNull();
    expect(header).toHaveClass("h-14", "flex-row", "items-center");
    expect(header).not.toHaveClass("border-b");
    const brandLink = within(header as HTMLElement).getByRole("link", { name: "EveChats" });
    expect(brandLink).toHaveClass("h-10");
    expect(within(header as HTMLElement).getByRole("button", { name: "Toggle theme" })).toBeInTheDocument();
  });

  it("shows the signed-in account in the sidebar footer", () => {
    const { container } = renderWithChatList(
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>,
    );
    const footer = container.querySelector('[data-sidebar="footer"]');

    expect(footer).not.toBeNull();
    expect(
      within(footer as HTMLElement).getByRole("button", { name: "Account" }),
    ).toBeInTheDocument();
    expect(within(footer as HTMLElement).getByText("Test User")).toBeInTheDocument();
    expect(within(footer as HTMLElement).getByText("Account")).toBeInTheDocument();
  });

  it("offers New Chat and Agents navigation entries", () => {
    renderWithChatList(
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>,
    );

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

    renderWithChatList(
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>,
    );

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

    renderWithChatList(
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>,
    );

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
