import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { SidebarNav, type SidebarAgentItem, type SidebarChatItem } from "@/components/sidebar-nav";
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar";

let pathname = "/";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    React.createElement("a", { href, ...props }, children),
}));

const agents: SidebarAgentItem[] = [
  { id: "agent_a", name: "Data Bot", status: "healthy" },
  { id: "agent_b", name: "Ops Bot", status: "unreachable" },
];

const chats: SidebarChatItem[] = [
  { id: "chat_3", title: "Deploy check", agentConnectionId: "agent_b" },
  { id: "chat_2", title: "Weekly report", agentConnectionId: "agent_a" },
  { id: "chat_1", title: "Sales analysis", agentConnectionId: "agent_a" },
];

function renderNav(): void {
  render(
    React.createElement(SidebarProvider, null, React.createElement(SidebarNav, { agents, chats })),
  );
}

function MobileSidebarHarness(): React.ReactElement {
  const { openMobile, setOpenMobile } = useSidebar();

  return React.createElement(
    React.Fragment,
    null,
    React.createElement("button", { type: "button", onClick: () => setOpenMobile(true) }, "Open mobile sidebar"),
    React.createElement("output", { "data-testid": "mobile-sidebar-state" }, openMobile ? "open" : "closed"),
    React.createElement(SidebarNav, { agents, chats }),
  );
}

function MobileSidebarTestTree(): React.ReactElement {
  return React.createElement(SidebarProvider, null, React.createElement(MobileSidebarHarness));
}

describe("SidebarNav", () => {
  afterEach(() => {
    pathname = "/";
  });

  it("renders one entry per agent plus a compact New agent link", () => {
    renderNav();
    expect(screen.getByRole("link", { name: /Data Bot/ })).toHaveAttribute("href", "/agents/agent_a");
    expect(screen.getByRole("link", { name: /Ops Bot/ })).toHaveAttribute("href", "/agents/agent_b");
    const newAgentLink = screen.getByRole("link", { name: "New agent" });
    expect(newAgentLink).toHaveAttribute("href", "/agents/new");
    expect(newAgentLink).toHaveTextContent(/^New$/);
    expect(screen.getByRole("link", { name: "View all" })).toHaveAttribute("href", "/agents");
  });

  it("marks unreachable agents with a dot", () => {
    renderNav();
    expect(screen.getByText("unreachable")).toBeInTheDocument();
  });

  it("scopes the chat list to the agent in the path", () => {
    pathname = "/agents/agent_a";
    renderNav();
    expect(screen.getByText("Weekly report")).toBeInTheDocument();
    expect(screen.getByText("Sales analysis")).toBeInTheDocument();
    expect(screen.queryByText("Deploy check")).not.toBeInTheDocument();
  });

  it("scopes the chat list to the open chat's agent", () => {
    pathname = "/chats/chat_2";
    renderNav();
    expect(screen.getByText("Weekly report")).toBeInTheDocument();
    expect(screen.queryByText("Deploy check")).not.toBeInTheDocument();
  });

  it("points the group + action at the current agent's new chat page", () => {
    pathname = "/agents/agent_b";
    renderNav();
    expect(screen.getByRole("link", { name: "New chat" })).toHaveAttribute("href", "/agents/agent_b");
  });

  it("keeps the selected agent when View all navigates to the agent list", () => {
    pathname = "/agents/agent_a";
    const tree = (): React.ReactElement =>
      React.createElement(SidebarProvider, null, React.createElement(SidebarNav, { agents, chats }));
    const { rerender } = render(tree());

    expect(screen.getByRole("link", { name: /Data Bot/ })).toHaveClass("bg-sidebar-accent");
    expect(screen.getByText("Weekly report")).toBeInTheDocument();

    pathname = "/agents";
    rerender(tree());

    expect(screen.getByRole("link", { name: /Data Bot/ })).toHaveClass("bg-sidebar-accent");
    expect(screen.getByRole("link", { name: /Ops Bot/ })).not.toHaveClass("bg-sidebar-accent");
    expect(screen.getByText("Weekly report")).toBeInTheDocument();
    expect(screen.queryByText("Deploy check")).not.toBeInTheDocument();
  });

  it("falls back to the most recent chat's agent on a direct unrelated route load", () => {
    pathname = "/agents";
    renderNav();
    expect(screen.getByText("Deploy check")).toBeInTheDocument();
    expect(screen.queryByText("Weekly report")).not.toBeInTheDocument();
  });

  it("closes the mobile sidebar when the pathname changes", async () => {
    pathname = "/agents/agent_a";
    const { rerender } = render(React.createElement(MobileSidebarTestTree));

    fireEvent.click(screen.getByRole("button", { name: "Open mobile sidebar" }));
    expect(screen.getByTestId("mobile-sidebar-state")).toHaveTextContent("open");

    pathname = "/chats/chat_2";
    rerender(React.createElement(MobileSidebarTestTree));

    await waitFor(() => expect(screen.getByTestId("mobile-sidebar-state")).toHaveTextContent("closed"));
  });
});
