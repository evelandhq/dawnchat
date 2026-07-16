import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { SidebarNav, type SidebarChatItem } from "@/components/sidebar-nav";
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

const chats: SidebarChatItem[] = [
  { id: "chat_3", title: "Deploy check", agentConnectionId: "agent_b" },
  { id: "chat_2", title: "Weekly report", agentConnectionId: "agent_a" },
  { id: "chat_1", title: "Sales analysis", agentConnectionId: "agent_a" },
];

function renderNav(): void {
  render(
    React.createElement(SidebarProvider, null, React.createElement(SidebarNav, { chats })),
  );
}

function MobileSidebarHarness(): React.ReactElement {
  const { openMobile, setOpenMobile } = useSidebar();

  return React.createElement(
    React.Fragment,
    null,
    React.createElement("button", { type: "button", onClick: () => setOpenMobile(true) }, "Open mobile sidebar"),
    React.createElement("output", { "data-testid": "mobile-sidebar-state" }, openMobile ? "open" : "closed"),
    React.createElement(SidebarNav, { chats }),
  );
}

function MobileSidebarTestTree(): React.ReactElement {
  return React.createElement(SidebarProvider, null, React.createElement(MobileSidebarHarness));
}

describe("SidebarNav", () => {
  afterEach(() => {
    pathname = "/";
  });

  it("renders the New Chat and Agents menu entries", () => {
    renderNav();
    expect(screen.getByRole("link", { name: "New Chat" })).toHaveAttribute("href", "/chats/new");
    expect(screen.getByRole("link", { name: "Agents" })).toHaveAttribute("href", "/agents");
  });

  it("lists chats from every agent together", () => {
    pathname = "/agents/agent_a";
    renderNav();
    expect(screen.getByText("Deploy check")).toBeInTheDocument();
    expect(screen.getByText("Weekly report")).toBeInTheDocument();
    expect(screen.getByText("Sales analysis")).toBeInTheDocument();
  });

  it("marks the open chat as active", () => {
    pathname = "/chats/chat_2";
    renderNav();
    expect(screen.getByRole("link", { name: "Weekly report" })).toHaveAttribute("data-active", "true");
    expect(screen.getByRole("link", { name: "Deploy check" })).toHaveAttribute("data-active", "false");
  });

  it("shows an empty message when there are no chats", () => {
    render(React.createElement(SidebarProvider, null, React.createElement(SidebarNav, { chats: [] })));
    expect(screen.getByText("No chats yet.")).toBeInTheDocument();
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
