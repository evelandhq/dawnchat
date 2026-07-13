import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { AppHeader } from "@/components/app-header";
import { SidebarProvider } from "@/components/ui/sidebar";

const pathnameState = vi.hoisted(() => ({ value: "/" }));

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameState.value,
}));

const agents = [
  { id: "agent_a", name: "Data Bot", status: "healthy" as const },
  { id: "agent_b", name: "Ops Bot", status: "unreachable" as const },
];

const chats = [
  { id: "chat_a", title: "Data chat", agentConnectionId: "agent_a" },
  { id: "chat_b", title: "Ops chat", agentConnectionId: "agent_b" },
];

function renderHeader(pathname: string): void {
  pathnameState.value = pathname;
  render(
    <SidebarProvider>
      <AppHeader agents={agents} chats={chats} />
    </SidebarProvider>,
  );
}

describe("AppHeader", () => {
  it("shows the current agent name and health on an agent route", () => {
    renderHeader("/agents/agent_b");

    expect(screen.getByText("Ops Bot")).toBeInTheDocument();
    expect(screen.getByText("unreachable")).toBeInTheDocument();
    expect(screen.queryByText("Eve Chats")).not.toBeInTheDocument();
  });

  it("derives the current agent from an open chat", () => {
    renderHeader("/chats/chat_a");

    expect(screen.getByText("Data Bot")).toBeInTheDocument();
    expect(screen.getByText("healthy")).toBeInTheDocument();
  });

  it("falls back to the product title outside an explicit agent or chat route", () => {
    pathnameState.value = "/agents";
    const { rerender } = render(
      <SidebarProvider>
        <AppHeader agents={agents} chats={chats} />
      </SidebarProvider>,
    );

    expect(screen.getByText("Eve Chats")).toBeInTheDocument();
    expect(screen.queryByText("healthy")).not.toBeInTheDocument();

    pathnameState.value = "/agents/new";
    rerender(
      <SidebarProvider>
        <AppHeader agents={agents} chats={chats} />
      </SidebarProvider>,
    );

    expect(screen.getByText("Eve Chats")).toBeInTheDocument();
  });
});
