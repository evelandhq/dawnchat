import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetAgentAuthModuleForTests } from "@/agent-auth/runtime.server";
import { setDbClientForTests } from "@/db/provider";
import { createRepository } from "@/db/repository";
import { startFakeEveServer, type FakeEveServer } from "@/eve/fake-eve-server.test-helper";
import { EVE_PROXY_CONTINUATION_TOKEN } from "@/eve/proxy-contract";
import { createTestDbHandle, type TestDbHandle } from "@/test/db";

type RouteContext<TParams extends Record<string, string>> = {
  params: Promise<TParams>;
};

type PostRoute<TParams extends Record<string, string>> = (
  request: Request,
  context: RouteContext<TParams>,
) => Promise<Response>;

type GetRoute<TParams extends Record<string, string>> = (
  request: Request,
  context: RouteContext<TParams>,
) => Promise<Response>;

async function loadProxyRoutes(): Promise<{
  createSession: PostRoute<{ chatId: string }>;
  continueSession: PostRoute<{ chatId: string; sessionId: string }>;
  streamSession: GetRoute<{ chatId: string; sessionId: string }>;
}> {
  const modules = await Promise.all([
    loadRouteModule("../src/app/api/chats/[chatId]/agent/eve/v1/session/route.ts"),
    loadRouteModule("../src/app/api/chats/[chatId]/agent/eve/v1/session/[sessionId]/route.ts"),
    loadRouteModule("../src/app/api/chats/[chatId]/agent/eve/v1/session/[sessionId]/stream/route.ts"),
  ]);

  expect(modules.every(Boolean), "per-chat Eve proxy routes should exist").toBe(true);
  const [createModule, continueModule, streamModule] = modules;
  if (!createModule || !continueModule || !streamModule) {
    throw new Error("Per-chat Eve proxy routes are missing");
  }

  return {
    createSession: createModule.POST as PostRoute<{ chatId: string }>,
    continueSession: continueModule.POST as PostRoute<{ chatId: string; sessionId: string }>,
    streamSession: streamModule.GET as GetRoute<{ chatId: string; sessionId: string }>,
  };
}

async function loadRouteModule(relativePath: string): Promise<Record<string, unknown> | null> {
  try {
    return (await import(/* @vite-ignore */ new URL(relativePath, import.meta.url).href)) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && /Cannot find|Unknown file extension|Failed to load/i.test(error.message)) {
      return null;
    }
    throw error;
  }
}

describe("per-chat Eve protocol proxy", () => {
  const servers: FakeEveServer[] = [];
  let testDb: TestDbHandle;

  beforeEach(async () => {
    testDb = await createTestDbHandle();
    setDbClientForTests(testDb.db);
    resetAgentAuthModuleForTests();
  });

  afterEach(async () => {
    resetAgentAuthModuleForTests();
    setDbClientForTests(null);
    await testDb.close();
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function fakeServer(options?: Parameters<typeof startFakeEveServer>[0]): Promise<FakeEveServer> {
    const server = await startFakeEveServer(options);
    servers.push(server);
    return server;
  }

  it("forwards multimodal turns with server-side auth and persists the remote session cursor", async () => {
    const server = await fakeServer();
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Secured Eve",
      baseUrl: server.baseUrl,
      authType: "bearer",
      authConfigEncrypted: JSON.stringify({ bearerToken: "server-secret" }),
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Inspect file",
      pendingUserMessage: "Inspect this file",
    });
    const routes = await loadProxyRoutes();
    const message = [
      { type: "text", text: "Inspect this file" },
      {
        type: "file",
        data: "data:text/plain;base64,aGVsbG8=",
        filename: "hello.txt",
        mediaType: "text/plain",
      },
    ];

    const response = await routes.createSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, clientContext: { surface: "eve-chats" } }),
      }),
      { params: Promise.resolve({ chatId: chat.id }) },
    );

    expect(response.status).toBe(200);
    const responseBody = (await response.json()) as Record<string, unknown>;
    expect(responseBody).toMatchObject({ sessionId: "ses_1" });
    expect(responseBody.continuationToken).toBe(EVE_PROXY_CONTINUATION_TOKEN);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      path: "/eve/v1/session",
      body: { message, clientContext: { surface: "eve-chats" } },
    });
    expect(server.requests[0].headers.authorization).toBe("Bearer server-secret");
    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      status: "active",
      pendingUserMessage: null,
      sessionState: { sessionId: "ses_1", continuationToken: "eve:1", streamIndex: 0 },
    });
  });

  it("passes raw structured events through unchanged and persists them idempotently", async () => {
    const streamEvents = [
      {
        type: "message.received",
        data: {
          message: "Read this\n[file: report.pdf (application/pdf)]",
          parts: [
            { type: "text", text: "Read this" },
            { type: "file", filename: "report.pdf", mediaType: "application/pdf", size: 42 },
          ],
          sequence: 1,
          turnId: "turn_1",
        },
      },
      {
        type: "reasoning.appended",
        data: {
          reasoningDelta: "Checking",
          reasoningSoFar: "Checking",
          sequence: 2,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      {
        type: "actions.requested",
        data: {
          actions: [{ kind: "tool-call", callId: "call_1", toolName: "read_report", input: { page: 1 } }],
          sequence: 3,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      {
        type: "input.requested",
        data: {
          requests: [
            {
              requestId: "req_1",
              prompt: "Allow reading the report?",
              display: "confirmation",
              options: [
                { id: "approve", label: "Allow", style: "primary" },
                { id: "deny", label: "Deny", style: "danger" },
              ],
              action: { kind: "tool-call", callId: "call_1", toolName: "read_report", input: { page: 1 } },
            },
          ],
          sequence: 4,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      { type: "session.waiting", data: { wait: "next-user-message" } },
    ] as const;
    const server = await fakeServer({ streamEvents });
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Structured Eve",
      baseUrl: server.baseUrl,
      authType: "none",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({ agentConnectionId: agent.id, title: "Structured turn" });
    const routes = await loadProxyRoutes();

    await routes.createSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Read this" }),
      }),
      { params: Promise.resolve({ chatId: chat.id }) },
    );

    const stream = () =>
      routes.streamSession(
        new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1/stream`),
        { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
      );
    const firstResponse = await stream();

    expect(firstResponse.status).toBe(200);
    expect(firstResponse.headers.get("content-type")).toContain("application/x-ndjson");
    const forwardedEvents = (await firstResponse.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    expect(forwardedEvents).toEqual(streamEvents);

    const stored = await repository.listEvents(chat.id);
    expect(stored).toHaveLength(streamEvents.length);
    expect(stored.map((event) => event.payload)).toEqual(streamEvents);
    expect(stored.map((event) => event.eventIndex)).toEqual([1, 2, 3, 4, 5]);
    expect(stored).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: "ses_1", streamIndex: 0, type: "message.received" }),
        expect.objectContaining({ sessionId: "ses_1", streamIndex: 4, type: "session.waiting" }),
      ]),
    );
    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      status: "active",
      sessionState: { sessionId: "ses_1", continuationToken: "eve:1", streamIndex: 5 },
    });

    const replayResponse = await stream();
    expect(replayResponse.status).toBe(200);
    await replayResponse.text();
    await expect(repository.listEvents(chat.id)).resolves.toHaveLength(streamEvents.length);
  });

  it("injects the stored continuation token for HITL responses and rejects another session id", async () => {
    const server = await fakeServer();
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Approval Eve",
      baseUrl: server.baseUrl,
      authType: "none",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({ agentConnectionId: agent.id, title: "Approval" });
    await repository.updateChatSessionState(chat.id, {
      sessionId: "ses_1",
      continuationToken: "eve:1",
      streamIndex: 7,
    });
    const routes = await loadProxyRoutes();

    const response = await routes.continueSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          continuationToken: "untrusted-browser-token",
          inputResponses: [{ requestId: "req_1", optionId: "approve" }],
        }),
      }),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );

    expect(response.status).toBe(200);
    expect(server.requests[0].body).toEqual({
      continuationToken: "eve:1",
      inputResponses: [{ requestId: "req_1", optionId: "approve" }],
    });

    const mismatched = await routes.continueSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_2`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "wrong session" }),
      }),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_2" }) },
    );

    expect(mismatched.status).toBe(409);
    await expect(mismatched.json()).resolves.toEqual({ error: "Eve session does not belong to this chat" });
    expect(server.requests).toHaveLength(1);
  });
});
