import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as POST_AGENT } from "@/app/api/agents/route";
import { POST as POST_CHAT } from "@/app/api/chats/route";
import { POST as CREATE_SESSION } from "@/app/api/chats/[chatId]/agent/eve/v1/session/route";
import { POST as CONTINUE_SESSION } from "@/app/api/chats/[chatId]/agent/eve/v1/session/[sessionId]/route";
import { GET as STREAM_SESSION } from "@/app/api/chats/[chatId]/agent/eve/v1/session/[sessionId]/stream/route";
import { setDbClientForTests } from "@/db/provider";
import { createRepository } from "@/db/repository";
import { startFakeEveServer, type FakeEveServer } from "@/eve/fake-eve-server.test-helper";
import { createTestDbHandle, type TestDbHandle } from "@/test/db";

describe("Eve chat flow smoke", () => {
  let server: FakeEveServer;
  let testDb: TestDbHandle;

  beforeEach(async () => {
    testDb = await createTestDbHandle();
    setDbClientForTests(testDb.db);
    server = await startFakeEveServer();
  });

  afterEach(async () => {
    setDbClientForTests(null);
    await testDb.close();
    await server.close();
  });

  it("registers an agent and completes two turns through the per-chat Eve proxy", async () => {
    const agentResponse = await POST_AGENT(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Smoke Eve Agent",
          baseUrl: server.baseUrl,
          authType: "none",
        }),
      }),
    );
    const agent = (await agentResponse.json()) as { agent: { id: string } };
    const chatResponse = await POST_CHAT(
      new Request("http://localhost/api/chats", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: agent.agent.id, message: "Hello from the smoke test" }),
      }),
    );
    const created = (await chatResponse.json()) as { chat: { id: string } };
    const chatId = created.chat.id;

    const firstTurn = await CREATE_SESSION(
      jsonRequest(`http://localhost/api/chats/${chatId}/agent/eve/v1/session`, {
        message: "Hello from the smoke test",
      }),
      { params: Promise.resolve({ chatId }) },
    );
    expect(firstTurn.status).toBe(200);
    const firstStream = await STREAM_SESSION(
      new Request(`http://localhost/api/chats/${chatId}/agent/eve/v1/session/ses_1/stream`),
      { params: Promise.resolve({ chatId, sessionId: "ses_1" }) },
    );
    expect((await firstStream.text()).trim().split("\n")).toHaveLength(3);

    const followUp = await CONTINUE_SESSION(
      jsonRequest(`http://localhost/api/chats/${chatId}/agent/eve/v1/session/ses_1`, {
        message: "Can you continue?",
      }),
      { params: Promise.resolve({ chatId, sessionId: "ses_1" }) },
    );
    expect(followUp.status).toBe(200);
    const secondStream = await STREAM_SESSION(
      new Request(
        `http://localhost/api/chats/${chatId}/agent/eve/v1/session/ses_1/stream?startIndex=3`,
      ),
      { params: Promise.resolve({ chatId, sessionId: "ses_1" }) },
    );
    expect(secondStream.status, JSON.stringify(server.requests)).toBe(200);
    expect((await secondStream.text()).trim().split("\n")).toHaveLength(3);

    expect(server.requests.map((request) => `${request.method} ${request.path}${request.query}`)).toEqual([
      "GET /eve/v1/health",
      "GET /eve/v1/info",
      "POST /eve/v1/session",
      "GET /eve/v1/session/ses_1/stream",
      "POST /eve/v1/session/ses_1",
      "GET /eve/v1/session/ses_1/stream?startIndex=3",
    ]);
    expect(server.requests[4].body).toMatchObject({
      message: "Can you continue?",
      continuationToken: "eve:1",
    });
    await expect(createRepository(testDb.db).getChat(chatId)).resolves.toMatchObject({
      agentConnectionId: agent.agent.id,
      pendingUserMessage: null,
      sessionState: { sessionId: "ses_1", continuationToken: "eve:1", streamIndex: 6 },
      status: "active",
    });
    await expect(createRepository(testDb.db).listEvents(chatId)).resolves.toHaveLength(6);
  });
});

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
