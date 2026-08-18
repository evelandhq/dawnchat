import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { GET, POST } from "@/app/api/chats/route";
import { POST as POST_CLAIM } from "@/app/api/chats/claim/route";
import { setDbClientForTests } from "@/db/provider";
import { createRepository } from "@/db/repository";
import { chats } from "@/db/schema";
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
        authorization: "Bearer app-user-1",
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

  async function createExternalAgent() {
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "External Agent",
      baseUrl: "https://external.example.com",
      authType: "none",
    });
    return repository.updateAgentHealth(agent.id, { status: "healthy" });
  }

  it("validates new chat requests", async () => {
    const response = await postChats({ agentId: "", message: "" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid chat request" });
  });

  it("creates and lists a chat in an anonymous browser session without Eveland login", async () => {
    const agent = await createAgent();
    const createdResponse = await POST(
      new Request("http://localhost/api/chats", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: agent.id, message: "Hello anonymously" }),
      }),
    );

    expect(createdResponse.status).toBe(201);
    const sessionCookie = createdResponse.headers.get("set-cookie");
    expect(sessionCookie).toMatch(/^eve_chats_session=/);
    const created = (await createdResponse.json()) as { chat: { id: string } };

    const listedResponse = await GET(
      new Request("http://localhost/api/chats", {
        headers: { cookie: sessionCookie!.split(";")[0]! },
      }),
    );

    expect(listedResponse.status).toBe(200);
    await expect(listedResponse.json()).resolves.toMatchObject({
      chats: [
        {
          id: created.chat.id,
          title: "Hello anonymously",
        },
      ],
    });
  });

  it("claims this browser's anonymous chats into the signed-in identity", async () => {
    const agent = await createAgent();
    const createdResponse = await POST(
      new Request("http://localhost/api/chats", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: agent.id, message: "Claim me" }),
      }),
    );
    expect(createdResponse.status).toBe(201);
    const sessionCookie = createdResponse.headers
      .get("set-cookie")!
      .split(";")[0]!;
    const created = (await createdResponse.json()) as { chat: { id: string } };

    const claimResponse = await POST_CLAIM(
      new Request("http://localhost/api/chats/claim", {
        method: "POST",
        headers: {
          authorization: "Bearer app-user-1",
          cookie: sessionCookie,
        },
      }),
    );
    expect(claimResponse.status).toBe(200);
    await expect(claimResponse.json()).resolves.toEqual({ claimed: 1 });

    // The chat now follows the identity: listing without the browser session
    // cookie still returns it.
    const listedResponse = await GET(
      new Request("http://localhost/api/chats", {
        headers: { authorization: "Bearer app-user-1" },
      }),
    );
    expect(listedResponse.status).toBe(200);
    await expect(listedResponse.json()).resolves.toMatchObject({
      chats: [{ id: created.chat.id }],
    });

    // Claiming is idempotent and never re-owns identity-owned chats.
    const secondClaim = await POST_CLAIM(
      new Request("http://localhost/api/chats/claim", {
        method: "POST",
        headers: {
          authorization: "Bearer app-user-2",
          cookie: sessionCookie,
        },
      }),
    );
    expect(secondClaim.status).toBe(200);
    await expect(secondClaim.json()).resolves.toEqual({ claimed: 0 });
  });

  it("rejects claiming chats without an Eveland App Token", async () => {
    const response = await POST_CLAIM(
      new Request("http://localhost/api/chats/claim", { method: "POST" }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Eveland Identity is required to claim chats",
    });
  });

  it("persists attachments as structured pending user content", async () => {
    const agent = await createAgent();
    const response = await postChats({
      agentId: agent.id,
      message: [
        { type: "text", text: "Review this" },
        {
          type: "file",
          data: "data:text/plain;base64,aGVsbG8=",
          filename: "report.txt",
          mediaType: "text/plain",
        },
      ],
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      chat: {
        title: "Review this",
        pendingUserMessage: [
          { type: "text", text: "Review this" },
          {
            type: "file",
            data: "data:text/plain;base64,aGVsbG8=",
            filename: "report.txt",
            mediaType: "text/plain",
          },
        ],
      },
    });
  });

  it("lists the newest chats first", async () => {
    const agent = await createAgent();
    const olderResponse = await postChats({
      agentId: agent.id,
      message: "Older conversation",
    });
    const newerResponse = await postChats({
      agentId: agent.id,
      message: "Newer conversation",
    });
    const older = (await olderResponse.json()) as { chat: { id: string } };
    const newer = (await newerResponse.json()) as { chat: { id: string } };
    await testDb.db
      .update(chats)
      .set({ createdAt: new Date("2026-07-27T00:00:00.000Z") })
      .where(eq(chats.id, older.chat.id));
    await testDb.db
      .update(chats)
      .set({ createdAt: new Date("2026-07-28T00:00:00.000Z") })
      .where(eq(chats.id, newer.chat.id));

    const response = await GET(
      new Request("http://localhost/api/chats", {
        headers: { authorization: "Bearer app-user-1" },
      }),
    );
    const body = (await response.json()) as { chats: Array<{ id: string }> };

    expect(body.chats.map((chat) => chat.id)).toEqual([
      newer.chat.id,
      older.chat.id,
    ]);
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
        headers: { authorization: "Bearer app-user-1" },
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
        headers: { authorization: "Bearer app-user-2" },
      }),
    );
    await expect(otherUser.json()).resolves.toEqual({ chats: [] });

    const otherRealm = await GET(
      new Request("http://localhost/api/chats", {
        headers: { authorization: "Bearer app-user-1-other-realm" },
      }),
    );
    await expect(otherRealm.json()).resolves.toEqual({ chats: [] });
    await expect(
      createRepository(testDb.db).getChat(created.chat.id),
    ).resolves.toMatchObject({
      ownerIdentityPrincipalId: "ipr_user_1",
      ownerIdentityRealmId: "irl_account_1",
      ownerIdentityIssuer: "https://identity.example.com",
      evelandProjectId: "project_support",
    });
  });

  it("keeps managed chat history readable with an app token after the Agent leaves the Catalog", async () => {
    const agent = await createAgent();
    const createdResponse = await postChats({
      agentId: agent.id,
      message: "Remember this",
    });
    expect(createdResponse.status).toBe(201);

    const response = await GET(
      new Request("http://localhost/api/chats", {
        headers: { authorization: "Bearer app-user-1" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      chats: [
        {
          agentConnectionId: agent.id,
          title: "Remember this",
        },
      ],
    });
  });

  it("creates chats for manually connected external Agents with an app token", async () => {
    const agent = await createExternalAgent();

    const response = await POST(
      new Request("http://localhost/api/chats", {
        method: "POST",
        headers: {
          authorization: "Bearer app-user-1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ agentId: agent.id, message: "Hello outside" }),
      }),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { chat: { id: string } };
    await expect(createRepository(testDb.db).getChat(body.chat.id)).resolves.toMatchObject({
      ownerIdentityIssuer: "https://identity.example.com",
      ownerIdentityPrincipalId: "ipr_user_1",
      ownerIdentityRealmId: "irl_account_1",
      evelandProjectId: null,
    });
  });
});

const testVerifier: CallerTokenVerifier = {
  async verifyAuthorization(authorization, expectedProjectId) {
    const identity =
      authorization === "Bearer user-1"
        ? {
            issuer: "https://identity.example.com",
            principalId: "ipr_user_1",
            realmId: "irl_account_1",
            projectId: "project_support",
            agentUrl: "https://agent.example.com",
            expiresAt: 1_900_000_000,
          }
        : authorization === "Bearer user-2"
          ? {
              issuer: "https://identity.example.com",
              principalId: "ipr_user_2",
              realmId: "irl_account_1",
              projectId: "project_support",
              agentUrl: "https://agent.example.com",
              expiresAt: 1_900_000_000,
            }
          : authorization === "Bearer user-1-other-realm"
            ? {
                issuer: "https://identity.example.com",
                principalId: "ipr_user_1",
                realmId: "irl_account_2",
                projectId: "project_support",
                agentUrl: "https://agent.example.com",
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
  async verifyAppAuthorization(authorization, expectedTarget) {
    const identity =
      authorization === "Bearer app-user-1"
        ? {
            issuer: "https://identity.example.com",
            principalId: "ipr_user_1",
            realmId: "irl_account_1",
            expiresAt: 1_900_000_000,
          }
        : authorization === "Bearer app-user-2"
          ? {
              issuer: "https://identity.example.com",
              principalId: "ipr_user_2",
              realmId: "irl_account_1",
              expiresAt: 1_900_000_000,
            }
          : authorization === "Bearer app-user-1-other-realm"
            ? {
                issuer: "https://identity.example.com",
                principalId: "ipr_user_1",
                realmId: "irl_account_2",
                expiresAt: 1_900_000_000,
              }
            : null;
    if (!identity || expectedTarget !== "eve-chats") {
      throw new CallerTokenError(
        "caller_token_invalid",
        401,
        "The Eveland App Token is invalid.",
      );
    }
    return identity;
  },
};
