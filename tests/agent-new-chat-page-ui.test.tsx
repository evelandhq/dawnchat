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

  it("offers the OIDC authorization flow when authorization is required", async () => {
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Private Bot",
      baseUrl: "https://private-bot.example.com",
      authType: "oidc",
    });
    await repository.updateAgentHealth(agent.id, { status: "authorization_required" });

    const page = await AgentNewChatPage({ params: Promise.resolve({ agentId: agent.id }) });
    render(page);

    expect(screen.getByText("Authorization is required before starting a chat with this agent.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Authorize with identity provider" })).toHaveAttribute(
      "href",
      `/api/agents/${agent.id}/auth/oidc/start?returnPath=${encodeURIComponent(`/agents/${agent.id}/edit`)}`,
    );
    expect(screen.queryByRole("button", { name: "Check again" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("First message")).toBeDisabled();
  });
});
