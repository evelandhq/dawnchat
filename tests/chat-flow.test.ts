import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as POST_AGENT } from "@/app/api/agents/route";
import { POST as POST_CHAT } from "@/app/api/chats/route";
import { POST as CREATE_SESSION } from "@/app/api/chats/[chatId]/agent/eve/v1/session/route";
import {
  GET as GET_SESSION_OPERATION,
  POST as POST_SESSION_OPERATION,
} from "@/app/api/chats/[chatId]/agent/eve/v1/session/[...sessionPath]/route";
import { setDbClientForTests } from "@/db/provider";
import { createRepository } from "@/db/repository";
import {
  startFakeEveServer,
  SUPPORTED_EVE_GENERATIONS,
  type FakeEveServer,
} from "@/eve/fake-eve-server.test-helper";
import { createTestDbHandle, type TestDbHandle } from "@/test/db";
import {
  setCallerTokenVerifierForTests,
  type CallerTokenVerifier,
} from "@/identity/server";

describe.each(SUPPORTED_EVE_GENERATIONS)("Eve %s chat flow smoke", (generation) => {
  let server: FakeEveServer;
  let testDb: TestDbHandle;

  beforeEach(async () => {
    testDb = await createTestDbHandle();
    setDbClientForTests(testDb.db);
    setCallerTokenVerifierForTests(testVerifier);
    server = await startFakeEveServer({ generation });
  });

  afterEach(async () => {
    setDbClientForTests(null);
    setCallerTokenVerifierForTests(null);
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
          evelandProjectId: "project_support",
        }),
      }),
    );
    const agent = (await agentResponse.json()) as { agent: { id: string } };
    const chatResponse = await POST_CHAT(
      new Request("http://localhost/api/chats", {
        method: "POST",
        headers: {
          authorization: "Bearer app-token",
          "content-type": "application/json",
        },
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
    expect(firstTurn.status).toBe(202);
    const firstStream = await GET_SESSION_OPERATION(
      new Request(`http://localhost/api/chats/${chatId}/agent/eve/v1/session/ses_1/stream`, {
        headers: { authorization: "Bearer app-token" },
      }),
      { params: Promise.resolve({ chatId, sessionPath: ["ses_1", "stream"] }) },
    );
    expect((await firstStream.text()).trim().split("\n")).toHaveLength(3);

    const followUp = await POST_SESSION_OPERATION(
      jsonRequest(`http://localhost/api/chats/${chatId}/agent/eve/v1/session/ses_1`, {
        message: "Can you continue?",
      }),
      { params: Promise.resolve({ chatId, sessionPath: ["ses_1"] }) },
    );
    expect(followUp.status).toBe(202);
    const secondStream = await GET_SESSION_OPERATION(
      new Request(
        `http://localhost/api/chats/${chatId}/agent/eve/v1/session/ses_1/stream?startIndex=3`,
        { headers: { authorization: "Bearer app-token" } },
      ),
      { params: Promise.resolve({ chatId, sessionPath: ["ses_1", "stream"] }) },
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
    expect(server.requests[4].body).toEqual({ message: "Can you continue?" });
    for (const request of server.requests.slice(2)) {
      expect(request.headers.authorization).toBeUndefined();
    }
    const stored = await createRepository(testDb.db).getChat(chatId);
    expect(stored).toMatchObject({
      agentConnectionId: agent.agent.id,
      pendingUserMessage: null,
      status: "active",
    });
    expect(stored?.sessionState).toEqual({
      sessionId: "ses_1",
      streamIndex: 6,
    });
    // Each turn streams three events but persists two: the message.appended
    // delta is forwarded and counted in the cursor, never stored.
    await expect(createRepository(testDb.db).listEvents(chatId)).resolves.toHaveLength(4);
  });
});

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      authorization: "Bearer app-token",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const testVerifier: CallerTokenVerifier = {
  async verifyAuthorization(_authorization, expectedProjectId) {
    return {
      issuer: "https://identity.example.com",
      principalId: "ipr_user_1",
      realmId: "irl_account_1",
      projectId: expectedProjectId ?? "project_support",
      agentUrl: null,
      expiresAt: 1_900_000_000,
    };
  },
  async verifyAppAuthorization() {
    return {
      issuer: "https://identity.example.com",
      principalId: "ipr_user_1",
      realmId: "irl_account_1",
      expiresAt: 1_900_000_000,
    };
  },
};
