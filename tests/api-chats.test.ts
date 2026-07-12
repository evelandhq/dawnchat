import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET, POST } from "@/app/api/chats/route";
import { POST as POST_MESSAGE } from "@/app/api/chats/[chatId]/messages/route";
import { setDbClientForTests } from "@/db/provider";
import { createRepository } from "@/db/repository";
import { createTestDbHandle, type TestDbHandle } from "@/test/db";
import { readNdjsonLines } from "@/test/ndjson";
import { startFakeEveServer, type FakeEveServer } from "@/eve/fake-eve-server.test-helper";

async function readJson(response: Response): Promise<unknown> {
  return response.json();
}

function postChats(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/chats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function postMessage(chatId: string, body: unknown): Promise<Response> {
  return POST_MESSAGE(
    new Request(`http://localhost/api/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ chatId }) },
  );
}

describe("Chat API", () => {
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

  async function fakeServer(options?: Parameters<typeof startFakeEveServer>[0]): Promise<FakeEveServer> {
    const server = await startFakeEveServer(options);
    servers.push(server);
    return server;
  }

  async function createAgent(baseUrl: string, status: "healthy" | "unreachable" = "healthy") {
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({ name: "Chat Agent", baseUrl, authType: "none" });
    return repository.updateAgentHealth(agent.id, { status, lastCheckedAt: new Date("2026-07-10T00:00:00.000Z") });
  }

  it("creates a chat bound to one agent and stores session state", async () => {
    const server = await fakeServer();
    const agent = await createAgent(server.baseUrl);

    const response = await postChats({ agentId: agent.id, message: "Hello Eve" });
    const body = (await readJson(response)) as { chat: { id: string; agentConnectionId: string; sessionState: unknown }; messages: unknown[] };

    expect(response.status).toBe(201);
    expect(body.chat).toMatchObject({
      id: expect.stringMatching(/^chat_[a-f0-9]{16}$/),
      agentConnectionId: agent.id,
      title: "Hello Eve",
      status: "active",
      sessionState: { sessionId: "ses_1", continuationToken: "eve:1", streamIndex: 3 },
    });
    expect(body.messages).toEqual([
      expect.objectContaining({ role: "user", content: "Hello Eve" }),
      expect.objectContaining({ role: "assistant", content: "Hello" }),
    ]);
    await expect(createRepository(testDb.db).getChat(body.chat.id)).resolves.toMatchObject({
      agentConnectionId: agent.id,
      sessionState: { sessionId: "ses_1", continuationToken: "eve:1", streamIndex: 3 },
    });
  });

  it("continues a chat using the saved continuation token", async () => {
    const server = await fakeServer({ omitContinuationTokenOnContinue: true });
    const agent = await createAgent(server.baseUrl);
    const created = (await readJson(await postChats({ agentId: agent.id, message: "Hello Eve" }))) as { chat: { id: string } };

    const response = await postMessage(created.chat.id, { message: "Follow up" });
    expect(response.status).toBe(200);
    const lines = await readNdjsonLines(response);
    const done = lines.at(-1);

    expect(server.requests.map((request) => `${request.method} ${request.path}${request.query}`)).toEqual([
      "POST /eve/v1/session",
      "GET /eve/v1/session/ses_1/stream",
      "POST /eve/v1/session/ses_1",
      "GET /eve/v1/session/ses_1/stream?startIndex=3",
    ]);
    expect(server.requests[2].body).toMatchObject({ message: "Follow up", continuationToken: "eve:1" });
    expect(done).toMatchObject({
      type: "done",
      chat: { sessionState: { sessionId: "ses_1", continuationToken: "eve:1", streamIndex: 6 } },
    });
    expect(done?.messages?.map((message) => `${message.role}:${message.content}`)).toEqual([
      "user:Hello Eve",
      "assistant:Hello",
      "user:Follow up",
      "assistant:Hello",
    ]);
  });

  it("stores assistant message from message.completed and persists raw Eve events", async () => {
    const server = await fakeServer();
    const agent = await createAgent(server.baseUrl);

    const response = await postChats({ agentId: agent.id, message: "Please answer" });
    const body = (await readJson(response)) as { chat: { id: string } };
    const repository = createRepository(testDb.db);

    expect(response.status).toBe(201);
    await expect(repository.listMessages(body.chat.id)).resolves.toEqual([
      expect.objectContaining({ role: "user", content: "Please answer" }),
      expect.objectContaining({ role: "assistant", content: "Hello", eventIndex: 2 }),
    ]);
    await expect(repository.listEvents(body.chat.id)).resolves.toEqual([
      expect.objectContaining({ eventIndex: 1, type: "message.appended", payload: expect.objectContaining({ type: "message.appended" }) }),
      expect.objectContaining({ eventIndex: 2, type: "message.completed", payload: expect.objectContaining({ type: "message.completed" }) }),
      expect.objectContaining({ eventIndex: 3, type: "session.waiting", payload: expect.objectContaining({ type: "session.waiting" }) }),
    ]);
  });

  it("rejects chat creation for unreachable agent", async () => {
    const server = await fakeServer();
    const agent = await createAgent(server.baseUrl, "unreachable");

    const response = await postChats({ agentId: agent.id, message: "Hello" });
    const body = await readJson(response);

    expect(response.status).toBe(409);
    expect(body).toEqual({ error: "Agent connection is unreachable" });
    await expect(createRepository(testDb.db).listChats()).resolves.toEqual([]);
  });

  it("marks a new chat failed when Eve session creation fails", async () => {
    const server = await fakeServer({ failCreateSession: true });
    const agent = await createAgent(server.baseUrl);

    const response = await postChats({ agentId: agent.id, message: "This will fail" });
    const body = (await readJson(response)) as { chat: { id: string; status: string; sessionState: unknown }; messages: unknown[]; error: string };

    expect(response.status).toBe(502);
    expect(body).toMatchObject({
      chat: { status: "failed", sessionState: null },
      messages: [expect.objectContaining({ role: "user", content: "This will fail" })],
      error: "Eve turn failed",
    });
    await expect(createRepository(testDb.db).getChat(body.chat.id)).resolves.toMatchObject({ status: "failed", sessionState: null });
  });

  it("marks a chat failed when Eve emits session.failed without session state", async () => {
    const server = await fakeServer({
      streamEvents: [{ type: "session.failed", data: { message: "boom", code: "fake_failure" } }],
    });
    const agent = await createAgent(server.baseUrl);

    const response = await postChats({ agentId: agent.id, message: "Fail gracefully" });
    const body = (await readJson(response)) as { chat: { id: string; status: string; sessionState: unknown }; messages: unknown[] };

    expect(response.status).toBe(201);
    expect(body.chat).toMatchObject({ status: "failed", sessionState: { sessionId: "ses_1", continuationToken: "eve:1", streamIndex: 1 } });
    expect(body.messages).toEqual([expect.objectContaining({ role: "user", content: "Fail gracefully" })]);
    await expect(createRepository(testDb.db).listEvents(body.chat.id)).resolves.toEqual([
      expect.objectContaining({ eventIndex: 1, type: "session.failed" }),
    ]);
  });

  it("rejects follow-up messages for completed chats", async () => {
    const server = await fakeServer();
    const agent = await createAgent(server.baseUrl);
    const created = (await readJson(await postChats({ agentId: agent.id, message: "Hello Eve" }))) as { chat: { id: string } };
    await createRepository(testDb.db).updateChatStatus(created.chat.id, "completed");

    const response = await postMessage(created.chat.id, { message: "Should be rejected" });
    const body = await readJson(response);

    expect(response.status).toBe(409);
    expect(body).toEqual({ error: "Chat is completed" });
  });

  it("accepts a new message on a failed chat and reactivates it on success", async () => {
    const server = await fakeServer();
    const agent = await createAgent(server.baseUrl);
    const created = (await readJson(await postChats({ agentId: agent.id, message: "Hello Eve" }))) as { chat: { id: string } };
    await createRepository(testDb.db).updateChatStatus(created.chat.id, "failed");

    const response = await postMessage(created.chat.id, { message: "Trying again" });
    expect(response.status).toBe(200);
    const done = (await readNdjsonLines(response)).at(-1);

    expect(done).toMatchObject({ type: "done", chat: { status: "active" } });
    expect(done?.messages?.at(-2)).toMatchObject({ role: "user", content: "Trying again" });
    expect(done?.messages?.at(-1)).toMatchObject({ role: "assistant" });
  });

  it("accepts a resend on a chat whose first turn never created a session", async () => {
    const server = await fakeServer({ failCreateSession: true });
    const agent = await createAgent(server.baseUrl);
    const created = (await readJson(await postChats({ agentId: agent.id, message: "First try" }))) as { chat: { id: string; status: string } };
    expect(created.chat.status).toBe("failed");

    const response = await postMessage(created.chat.id, { message: "Second try" });
    expect(response.status).toBe(200);
    const last = (await readNdjsonLines(response)).at(-1);

    expect(last).toMatchObject({ type: "error", error: "Eve turn failed", chat: { status: "failed" } });
    expect(last?.messages).toHaveLength(2);
  });

  it("streams assistant deltas before the terminal done line", async () => {
    const server = await fakeServer({
      streamEvents: [
        {
          type: "message.appended",
          data: { messageDelta: "Hel", messageSoFar: "Hel", sequence: 1, stepIndex: 0, turnId: "turn_1" },
        },
        {
          type: "message.appended",
          data: { messageDelta: "lo", messageSoFar: "Hello", sequence: 2, stepIndex: 0, turnId: "turn_1" },
        },
        {
          type: "message.completed",
          data: { message: "Hello", finishReason: "stop", sequence: 3, stepIndex: 0, turnId: "turn_1" },
        },
        { type: "session.waiting", data: { wait: "next-user-message" } },
      ],
    });
    const agent = await createAgent(server.baseUrl);
    const created = (await readJson(await postChats({ agentId: agent.id, message: "Hello Eve" }))) as { chat: { id: string } };

    const response = await postMessage(created.chat.id, { message: "Follow up" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    const lines = await readNdjsonLines(response);

    expect(lines.map((line) => line.type)).toEqual(["delta", "delta", "message", "done"]);
    expect(lines[0]).toMatchObject({ type: "delta", message: "Hel" });
    expect(lines[1]).toMatchObject({ type: "delta", message: "Hello" });
    expect(lines[2]).toMatchObject({ type: "message", message: "Hello" });
    expect(lines.at(-1)).toMatchObject({ type: "done", chat: { status: "active" } });
  });

  it("lists chat summaries", async () => {
    const server = await fakeServer();
    const agent = await createAgent(server.baseUrl);
    const created = (await readJson(await postChats({ agentId: agent.id, message: "Summarize this" }))) as { chat: { id: string } };

    const response = await GET();
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(body).toEqual({
      chats: [
        expect.objectContaining({
          id: created.chat.id,
          agentConnectionId: agent.id,
          title: "Summarize this",
          status: "active",
          lastMessage: "Hello",
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        }),
      ],
    });
  });
});
