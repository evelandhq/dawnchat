import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET, POST } from "@/app/api/chats/route";
import { setDbClientForTests } from "@/db/provider";
import { createRepository } from "@/db/repository";
import {
  CallerTokenError,
  setCallerTokenVerifierForTests,
  type CallerTokenVerifier,
} from "@/identity/server";
import { createTestDbHandle, type TestDbHandle } from "@/test/db";

function postChats(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/chats", {
      method: "POST",
      headers: {
        authorization: "Bearer user-1",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

describe("Chat API", () => {
  let testDb: TestDbHandle;

  beforeEach(async () => {
    testDb = await createTestDbHandle();
    setDbClientForTests(testDb.db);
    setCallerTokenVerifierForTests(testVerifier);
  });

  afterEach(async () => {
    setDbClientForTests(null);
    setCallerTokenVerifierForTests(null);
    await testDb.close();
  });

  async function createAgent(status: "healthy" | "unreachable" = "healthy") {
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Chat Agent",
      baseUrl: "https://agent.example.com",
      authType: "none",
      evelandProjectId: "project_support",
    });
    return repository.updateAgentHealth(agent.id, { status });
  }

  it("validates new chat requests", async () => {
    const response = await postChats({ agentId: "", message: "" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid chat request" });
  });

  it("rejects chat creation for an unreachable agent", async () => {
    const agent = await createAgent("unreachable");

    const response = await postChats({ agentId: agent.id, message: "Hello" });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Agent connection is unreachable" });
    await expect(createRepository(testDb.db).listChats()).resolves.toEqual([]);
  });

  it("lists chat summaries projected from canonical Eve events", async () => {
    const agent = await createAgent();
    const createdResponse = await postChats({ agentId: agent.id, message: "Summarize this" });
    const created = (await createdResponse.json()) as { chat: { id: string } };
    const repository = createRepository(testDb.db);
    const event = {
      type: "message.completed",
      data: {
        message: "The concise result.",
        finishReason: "stop",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_1",
      },
    } as const;
    await repository.appendEvent({
      chatId: created.chat.id,
      eventIndex: 1,
      type: event.type,
      payload: event,
    });

    const response = await GET(
      new Request("http://localhost/api/chats", {
        headers: { authorization: "Bearer user-1" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      chats: [
        expect.objectContaining({
          id: created.chat.id,
          agentConnectionId: agent.id,
          title: "Summarize this",
          status: "active",
          lastMessage: "The concise result.",
          pendingUserMessage: "Summarize this",
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        }),
      ],
    });
  });

  it("does not reveal chats across principals or realms", async () => {
    const agent = await createAgent();
    const createdResponse = await postChats({
      agentId: agent.id,
      message: "Private conversation",
    });
    const created = (await createdResponse.json()) as { chat: { id: string } };

    const otherUser = await GET(
      new Request("http://localhost/api/chats", {
        headers: { authorization: "Bearer user-2" },
      }),
    );
    await expect(otherUser.json()).resolves.toEqual({ chats: [] });

    const otherRealm = await GET(
      new Request("http://localhost/api/chats", {
        headers: { authorization: "Bearer user-1-other-realm" },
      }),
    );
    await expect(otherRealm.json()).resolves.toEqual({ chats: [] });
    await expect(
      createRepository(testDb.db).getChat(created.chat.id),
    ).resolves.toMatchObject({
      ownerIdentityPrincipalId: "ipr_user_1",
      ownerIdentityRealmId: "irl_account_1",
      evelandProjectId: "project_support",
    });
  });
});

const testVerifier: CallerTokenVerifier = {
  async verifyAuthorization(authorization, expectedProjectId) {
    const identity =
      authorization === "Bearer user-1"
        ? {
            principalId: "ipr_user_1",
            realmId: "irl_account_1",
            projectId: "project_support",
            expiresAt: 1_900_000_000,
          }
        : authorization === "Bearer user-2"
          ? {
              principalId: "ipr_user_2",
              realmId: "irl_account_1",
              projectId: "project_support",
              expiresAt: 1_900_000_000,
            }
          : authorization === "Bearer user-1-other-realm"
            ? {
                principalId: "ipr_user_1",
                realmId: "irl_account_2",
                projectId: "project_support",
                expiresAt: 1_900_000_000,
              }
            : null;
    if (!identity || (expectedProjectId && expectedProjectId !== identity.projectId)) {
      throw new CallerTokenError(
        "caller_token_invalid",
        401,
        "The Eveland Caller Token is invalid.",
      );
    }
    return identity;
  },
};
