import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as GET_CHAT } from "@/app/api/chats/[chatId]/route";
import { POST as POST_CHAT } from "@/app/api/chats/route";
import { setDbClientForTests } from "@/db/provider";
import { createRepository } from "@/db/repository";
import { startFakeEveServer, type FakeEveServer } from "@/eve/fake-eve-server.test-helper";
import { createTestDbHandle, type TestDbHandle } from "@/test/db";
import {
  setCallerTokenVerifierForTests,
  type CallerTokenVerifier,
} from "@/identity/server";

function createChat(agentId: string, message: string): Promise<Response> {
  return POST_CHAT(
    new Request("http://localhost/api/chats", {
      method: "POST",
      headers: {
        authorization: "Bearer caller-token",
        "content-type": "application/json",
      },
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
    setCallerTokenVerifierForTests(testVerifier);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setDbClientForTests(null);
    setCallerTokenVerifierForTests(null);
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
      evelandProjectId: "project_support",
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
      ownerIdentityPrincipalId: "ipr_user_1",
      ownerIdentityRealmId: "irl_account_1",
      evelandProjectId: "project_support",
    });
  });

  it("serves the Eveland Project a chat belongs to, so the browser wires its Caller Token flow", async () => {
    const { id: agentId } = await createAgent();
    const response = await createChat(agentId, "Start managed chat");
    const body = (await response.json()) as { chat: { id: string } };

    const read = await GET_CHAT(
      new Request(`http://localhost/api/chats/${body.chat.id}`, {
        headers: { authorization: "Bearer caller-token" },
      }),
      { params: Promise.resolve({ chatId: body.chat.id }) },
    );

    expect(read.status).toBe(200);
    const payload = (await read.json()) as { chat: { evelandProjectId: string | null } };
    expect(payload.chat.evelandProjectId).toBe("project_support");
  });

  // The database decides when a claim expires, so a reader on a drifted clock
  // must not reach the opposite conclusion about the same row: it would stop
  // watching a create the database still refuses to let anyone else take, or
  // keep waiting on one it would.
  for (const skew of [
    { name: "ahead of", offsetMs: 120_000 },
    { name: "behind", offsetMs: -120_000 },
  ]) {
    it(`reports a live create claim to a reader whose clock runs ${skew.name} the database`, async () => {
      const { id: agentId } = await createAgent();
      const response = await createChat(agentId, "Start managed chat");
      const body = (await response.json()) as { chat: { id: string } };
      const repository = createRepository(testDb.db);
      await repository.claimSessionCreate(body.chat.id, 60_000);
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + skew.offsetMs);

      const read = await GET_CHAT(
        new Request(`http://localhost/api/chats/${body.chat.id}`, {
          headers: { authorization: "Bearer caller-token" },
        }),
        { params: Promise.resolve({ chatId: body.chat.id }) },
      );

      const payload = (await read.json()) as {
        chat: { sessionCreateInProgress: boolean };
      };
      expect(payload.chat.sessionCreateInProgress).toBe(true);
    });

    it(`reports an expired create claim to a reader whose clock runs ${skew.name} the database`, async () => {
      const { id: agentId } = await createAgent();
      const response = await createChat(agentId, "Start managed chat");
      const body = (await response.json()) as { chat: { id: string } };
      const repository = createRepository(testDb.db);
      await repository.claimSessionCreate(body.chat.id, -1_000);
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + skew.offsetMs);

      const read = await GET_CHAT(
        new Request(`http://localhost/api/chats/${body.chat.id}`, {
          headers: { authorization: "Bearer caller-token" },
        }),
        { params: Promise.resolve({ chatId: body.chat.id }) },
      );

      const payload = (await read.json()) as {
        chat: { sessionCreateInProgress: boolean };
      };
      expect(payload.chat.sessionCreateInProgress).toBe(false);
    });
  }

  it("loads raw Eve events with the browser-safe session cursor", async () => {
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
      streamIndex: 5,
    });

    const responseData = await GET_CHAT(
      new Request(`http://localhost/api/chats/${body.chat.id}`, {
        headers: { authorization: "Bearer caller-token" },
      }),
      { params: Promise.resolve({ chatId: body.chat.id }) },
    );
    const pageData = await responseData.json();

    expect(pageData).toMatchObject({
      chat: {
        id: body.chat.id,
        agentName: "Bootstrap Eve",
        pendingUserMessage: "Start from the saved draft",
      },
      events: [event],
    });
    expect(pageData?.chat.sessionState).toEqual({ sessionId: "ses_private", streamIndex: 5 });
    expect(pageData).not.toHaveProperty("messages");
  });
});

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
