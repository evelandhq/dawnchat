import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import AgentNewChatPage from "@/app/agents/[agentId]/page";
import { createRepository } from "@/db/repository";
import { setDbClientForTests } from "@/db/provider";
import { createTestDbHandle, type TestDbHandle } from "@/test/db";

vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

describe("AgentNewChatPage presentation", () => {
  let testDb: TestDbHandle;

  beforeEach(async () => {
    testDb = await createTestDbHandle();
    setDbClientForTests(testDb.db);
  });

  afterEach(async () => {
    setDbClientForTests(null);
    await testDb.close();
  });

  it("leaves agent identity and health to the shared app header", async () => {
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Data Bot",
      baseUrl: "https://data-bot.example.com",
      authType: "none",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });

    const page = await AgentNewChatPage({ params: Promise.resolve({ agentId: agent.id }) });
    const { container } = render(page);

    expect(screen.queryByRole("heading", { name: "Data Bot" })).not.toBeInTheDocument();
    expect(screen.queryByText("healthy")).not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="avatar"]')).not.toBeInTheDocument();
    expect(screen.getByLabelText("First message")).toBeEnabled();
  });
});
