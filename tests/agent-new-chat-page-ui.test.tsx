import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";

import AgentNewChatPage from "@/app/agents/[agentId]/page";
import { renderWithChatList } from "@/test/chat-list";

const getAppToken = vi.fn(async () => "app-token");
const getSession = vi.fn(async () => ({
  authenticated: true as const,
  principal: { id: "ipr_1", name: "Test User", email: null },
  activeRealm: { id: "irl_1", name: "Account 1" },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/agents/agent_1",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/components/identity-provider", () => ({
  useEvelandIdentity: () => ({
    session: {
      authenticated: true,
      principal: { id: "ipr_1", name: "Test User", email: null },
      activeRealm: { id: "irl_1", name: "Account 1" },
    },
    getCallerToken: async () => "caller-token",
    getAppToken,
    getSession,
    switchRealm: vi.fn(),
  }),
}));

describe("AgentNewChatPage presentation", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).startsWith("/api/agents/")
          ? Response.json({
              agent: { id: "agent_1", name: "Data Bot", status: "healthy" },
            })
          : Response.json({ chats: [] }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("leaves agent identity and health to the shared app header", async () => {
    const page = await AgentNewChatPage({
      params: Promise.resolve({ agentId: "agent_1" }),
    });
    const { container } = renderWithChatList(page);

    expect(await screen.findByLabelText("First message")).toBeEnabled();
    expect(screen.queryByRole("heading", { name: "Data Bot" })).not.toBeInTheDocument();
    expect(screen.queryByText("healthy")).not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="avatar"]')).not.toBeInTheDocument();
  });

  it("offers a health re-check instead of the composer for an unreachable agent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).startsWith("/api/agents/")
          ? Response.json({
              agent: { id: "agent_1", name: "Data Bot", status: "unreachable" },
            })
          : Response.json({ chats: [] }),
      ),
    );

    const page = await AgentNewChatPage({
      params: Promise.resolve({ agentId: "agent_1" }),
    });
    renderWithChatList(page);

    expect(
      await screen.findByRole("button", { name: "Check again" }),
    ).toBeEnabled();
    expect(await screen.findByLabelText("First message")).toBeDisabled();
  });

  it("reports a missing agent without a composer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).startsWith("/api/agents/")
          ? Response.json({ error: "Agent connection not found" }, { status: 404 })
          : Response.json({ chats: [] }),
      ),
    );

    const page = await AgentNewChatPage({
      params: Promise.resolve({ agentId: "agent_missing" }),
    });
    renderWithChatList(page);

    expect(await screen.findByText("Agent not found")).toBeInTheDocument();
    expect(screen.queryByLabelText("First message")).not.toBeInTheDocument();
  });
});
