import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getChatThreadForPage } from "@/app/chats/[chatId]/page";
import { POST as POST_CHAT } from "@/app/api/chats/route";
import { setDbClientForTests } from "@/db/provider";
import { createRepository } from "@/db/repository";
import { startFakeEveServer, type FakeEveServer } from "@/eve/fake-eve-server.test-helper";
import { createTestDbHandle, type TestDbHandle } from "@/test/db";

function createChat(agentId: string, message: string): Promise<Response> {
  return POST_CHAT(
    new Request("http://localhost/api/chats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId, message }),
    }),
  );
}

describe("chat bootstrap", () => {
  const servers: FakeEveServer[] = [];
  let testDb: TestDbHandle;

  beforeEach(async () => {
    testDb = await createTestDbHandle();
    setDbClientForTests(testDb.db);
  });

  afterEach(async () => {
    setDbClientForTests(null);
    await testDb.close();
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function createAgent(): Promise<{ id: string; server: FakeEveServer }> {
    const server = await startFakeEveServer();
    servers.push(server);
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Bootstrap Eve",
      baseUrl: server.baseUrl,
      authType: "none",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    return { id: agent.id, server };
  }

  it("creates the app chat before contacting Eve and persists the first message as pending", async () => {
    const { id: agentId, server } = await createAgent();

    const response = await createChat(agentId, "  Explain this report  ");
    const body = (await response.json()) as {
      chat: { id: string; pendingUserMessage: string | null; sessionState: unknown; status: string };
    };

    expect(response.status).toBe(201);
    expect(body.chat).toMatchObject({
      pendingUserMessage: "Explain this report",
      sessionState: null,
      status: "active",
    });
    expect(server.requests).toEqual([]);
    await expect(createRepository(testDb.db).getChat(body.chat.id)).resolves.toMatchObject({
      pendingUserMessage: "Explain this report",
      sessionState: null,
    });
  });

  it("loads raw Eve events and the pending first message for useEveAgent hydration", async () => {
    const { id: agentId } = await createAgent();
    const response = await createChat(agentId, "Start from the saved draft");
    const body = (await response.json()) as { chat: { id: string } };
    const repository = createRepository(testDb.db);
    const event = {
      type: "reasoning.completed",
      data: {
        reasoning: "Reviewed the context.",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_1",
      },
    } as const;
    await repository.appendEvent({
      chatId: body.chat.id,
      eventIndex: 4,
      type: event.type,
      payload: event,
    });
    await repository.updateChatSessionState(body.chat.id, {
      sessionId: "ses_private",
      continuationToken: "server-only-token",
      streamIndex: 5,
    });

    const pageData = await getChatThreadForPage(body.chat.id);

    expect(pageData).toMatchObject({
      chat: { id: body.chat.id, agentName: "Bootstrap Eve" },
      pendingUserMessage: "Start from the saved draft",
      events: [event],
    });
    expect(pageData?.chat.sessionState).toEqual({ sessionId: "ses_private", streamIndex: 5 });
    expect(pageData).not.toHaveProperty("messages");
  });
});
