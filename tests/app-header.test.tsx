import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { AppHeader } from "@/components/app-header";
import { SidebarProvider } from "@/components/ui/sidebar";

const pathnameState = vi.hoisted(() => ({ value: "/" }));

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameState.value,
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    React.createElement("a", { href, ...props }, children),
}));

const agents = [
  { id: "agent_a", name: "Data Bot", status: "healthy" as const },
  { id: "agent_b", name: "Ops Bot", status: "unreachable" as const },
];

const chats = [
  { id: "chat_a", title: "Data chat", agentConnectionId: "agent_a", agentName: "Data Bot", evelandProjectId: null, lastMessage: null },
  { id: "chat_b", title: "Ops chat", agentConnectionId: "agent_b", agentName: "Ops Bot", evelandProjectId: null, lastMessage: null },
];

vi.mock("@/components/chat-list-provider", () => ({
  useChatList: () => ({
    state: { status: "ready", chats, authenticated: false, error: null },
    refresh: vi.fn(),
  }),
}));

function renderHeader(pathname: string): ReturnType<typeof render> {
  pathnameState.value = pathname;
  return render(
    <SidebarProvider>
      <AppHeader />
    </SidebarProvider>,
  );
}

describe("AppHeader", () => {
  beforeEach(() => {
    // The header loads the Agent directory itself; pages pass it nothing.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ agents })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the current agent name and health on an agent route", async () => {
    renderHeader("/agents/agent_b");

    expect(await screen.findByText("Ops Bot")).toBeInTheDocument();
    expect(screen.getByText("unreachable")).toBeInTheDocument();
    expect(screen.queryByText("Eve Chats")).not.toBeInTheDocument();
  });

  it("derives the current agent from an open chat", async () => {
    renderHeader("/chats/chat_a");

    expect(await screen.findByText("Data Bot")).toBeInTheDocument();
    expect(screen.getByText("healthy")).toBeInTheDocument();
  });

  it("offers Agent Info and New Chat from the agent menu", async () => {
    renderHeader("/agents/agent_a");

    fireEvent.keyDown(await screen.findByRole("button", { name: /Data Bot/ }), { key: "Enter" });

    expect(screen.getByRole("menuitem", { name: "Agent Info" })).toHaveAttribute("href", "/agents/agent_a/edit");
    expect(screen.getByRole("menuitem", { name: "New Chat" })).toHaveAttribute("href", "/agents/agent_a");
  });

  it("shows no title outside an explicit agent or chat route", async () => {
    const { rerender } = renderHeader("/agents");

    expect(screen.queryByText("Eve Chats")).not.toBeInTheDocument();
    expect(screen.queryByText("healthy")).not.toBeInTheDocument();

    pathnameState.value = "/agents/new";
    rerender(
      <SidebarProvider>
        <AppHeader />
      </SidebarProvider>,
    );

    expect(screen.queryByText("Eve Chats")).not.toBeInTheDocument();
    expect(screen.queryByText("healthy")).not.toBeInTheDocument();
  });
});
