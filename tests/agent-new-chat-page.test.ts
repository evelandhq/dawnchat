import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getAgentForNewChatPage } from "@/app/agents/[agentId]/page";
import { createRepository } from "@/db/repository";
import { setDbClientForTests } from "@/db/provider";
import { createTestDbHandle, type TestDbHandle } from "@/test/db";

describe("getAgentForNewChatPage", () => {
  let testDb: TestDbHandle;

  beforeEach(async () => {
    testDb = await createTestDbHandle();
    setDbClientForTests(testDb.db);
  });

  afterEach(async () => {
    setDbClientForTests(null);
    await testDb.close();
  });

  it("returns id, name and status for an existing agent", async () => {
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Data Bot",
      baseUrl: "https://data-bot.example.com",
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });

    await expect(getAgentForNewChatPage(agent.id)).resolves.toEqual({
      id: agent.id,
      name: "Data Bot",
      status: "healthy",
      evelandProjectId: "project_support",
    });
  });

  it("returns null for an unknown agent id", async () => {
    await expect(getAgentForNewChatPage("agent_missing")).resolves.toBeNull();
  });
});
