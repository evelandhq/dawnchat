import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as POST_AGENT } from "@/app/api/agents/route";
import { POST as POST_CHAT } from "@/app/api/chats/route";
import { POST as POST_MESSAGE } from "@/app/api/chats/[chatId]/messages/route";
import { setDbClientForTests } from "@/db/provider";
import { createRepository } from "@/db/repository";
import { startFakeEveServer, type FakeEveServer } from "@/eve/fake-eve-server.test-helper";
import { createTestDbHandle, type TestDbHandle } from "@/test/db";

async function readJson(response: Response): Promise<unknown> {
  return response.json();
}

function postAgent(body: unknown): Promise<Response> {
  return POST_AGENT(
    new Request("http://localhost/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function postChat(body: unknown): Promise<Response> {
  return POST_CHAT(
    new Request("http://localhost/api/chats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function postFollowUp(chatId: string, body: unknown): Promise<Response> {
  return POST_MESSAGE(
    new Request(`http://localhost/api/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ chatId }) },
  );
}

describe("Eve chat flow smoke", () => {
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

  async function fakeServer(): Promise<FakeEveServer> {
    const server = await startFakeEveServer();
    servers.push(server);
    return server;
  }

  it("registers a fake Eve agent, creates a chat, and sends a follow-up with persisted state", async () => {
    const server = await fakeServer();

    const createdAgentResponse = await postAgent({
      name: "Smoke Eve Agent",
      baseUrl: server.baseUrl,
      authType: "none",
    });
    const createdAgent = (await readJson(createdAgentResponse)) as { agent: { id: string } };

    expect(createdAgentResponse.status).toBe(201);
    expect(createdAgent.agent.id).toEqual(expect.stringMatching(/^agent_[a-f0-9]{16}$/));

    const createdChatResponse = await postChat({
      agentId: createdAgent.agent.id,
      message: "Hello from the smoke test",
    });
    const createdChat = (await readJson(createdChatResponse)) as { chat: { id: string } };

    expect(createdChatResponse.status).toBe(201);
    expect(createdChat.chat.id).toEqual(expect.stringMatching(/^chat_[a-f0-9]{16}$/));

    const followUpResponse = await postFollowUp(createdChat.chat.id, { message: "Can you continue?" });
    const followUp = (await readJson(followUpResponse)) as {
      chat: { sessionState: unknown };
      messages: Array<{ role: string; content: string }>;
    };

    expect(followUpResponse.status).toBe(200);
    expect(server.requests.map((request) => `${request.method} ${request.path}${request.query}`)).toEqual([
      "GET /eve/v1/health",
      "GET /eve/v1/info",
      "POST /eve/v1/session",
      "GET /eve/v1/session/ses_1/stream",
      "POST /eve/v1/session/ses_1",
      "GET /eve/v1/session/ses_1/stream?startIndex=3",
    ]);
    expect(server.requests[4].body).toMatchObject({ message: "Can you continue?", continuationToken: "eve:1" });
    expect(followUp.chat.sessionState).toEqual({ sessionId: "ses_1", continuationToken: "eve:1", streamIndex: 6 });
    expect(followUp.messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      "user:Hello from the smoke test",
      "assistant:Hello",
      "user:Can you continue?",
      "assistant:Hello",
    ]);

    const repository = createRepository(testDb.db);
    await expect(repository.getChat(createdChat.chat.id)).resolves.toMatchObject({
      agentConnectionId: createdAgent.agent.id,
      sessionState: { sessionId: "ses_1", continuationToken: "eve:1", streamIndex: 6 },
      status: "active",
    });
    await expect(repository.listMessages(createdChat.chat.id)).resolves.toEqual([
      expect.objectContaining({ role: "user", content: "Hello from the smoke test" }),
      expect.objectContaining({ role: "assistant", content: "Hello" }),
      expect.objectContaining({ role: "user", content: "Can you continue?" }),
      expect.objectContaining({ role: "assistant", content: "Hello" }),
    ]);
  });
});
