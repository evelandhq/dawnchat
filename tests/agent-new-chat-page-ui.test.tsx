import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";

import AgentNewChatPage from "@/app/agents/[agentId]/page";
import { createRepository } from "@/db/repository";
import { setDbClientForTests } from "@/db/provider";
import { renderWithChatList } from "@/test/chat-list";
import { createTestDbHandle, type TestDbHandle } from "@/test/db";

const getAppToken = vi.fn(async () => "app-token");
const getSession = vi.fn(async () => ({
  authenticated: true as const,
  principal: { id: "ipr_1", name: "Test User", email: null },
  activeRealm: { id: "irl_1", name: "Account 1" },
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
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
  let testDb: TestDbHandle;

  beforeEach(async () => {
    testDb = await createTestDbHandle();
    setDbClientForTests(testDb.db);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    setDbClientForTests(null);
    await testDb.close();
  });

  it("leaves agent identity and health to the shared app header", async () => {
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Data Bot",
      baseUrl: "https://data-bot.example.com",
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ chats: [] })),
    );
    const page = await AgentNewChatPage({ params: Promise.resolve({ agentId: agent.id }) });
    const { container } = renderWithChatList(page);

    expect(screen.queryByRole("heading", { name: "Data Bot" })).not.toBeInTheDocument();
    expect(screen.queryByText("healthy")).not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="avatar"]')).not.toBeInTheDocument();
    expect(await screen.findByLabelText("First message")).toBeEnabled();
  });
});
