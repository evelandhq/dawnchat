import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { resolveAppBrowserSession } from "@/app-session";
import { chats } from "@/db/schema";
import { setDbClientForTests } from "@/db/provider";
import { createRepository } from "@/db/repository";
import { startFakeEveServer, type FakeEveServer } from "@/eve/fake-eve-server.test-helper";
import { EVE_PROXY_CONTINUATION_TOKEN } from "@/eve/proxy-contract";
import {
  CallerTokenError,
  setCallerTokenVerifierForTests,
  type CallerTokenVerifier,
} from "@/identity/server";
import { createTestDbHandle, type TestDbHandle } from "@/test/db";
import { encryptAuthConfig } from "@/eve/auth";

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

type SessionOperationRoute = (
  request: Request,
  context: {
    params: Promise<{ chatId: string; sessionPath: string[] }>;
  },
) => Promise<Response>;

async function loadProxyRoutes(): Promise<{
  createSession: PostRoute<{ chatId: string }>;
  continueSession: PostRoute<{ chatId: string; sessionId: string }>;
  cancelSession: PostRoute<{ chatId: string; sessionId: string }>;
  streamSession: GetRoute<{ chatId: string; sessionId: string }>;
}> {
  const modules = await Promise.all([
    loadRouteModule("../src/app/api/chats/[chatId]/agent/eve/v1/session/route.ts"),
    loadRouteModule("../src/app/api/chats/[chatId]/agent/eve/v1/session/[...sessionPath]/route.ts"),
  ]);

  expect(
    modules.every(Boolean),
    "the create-session and catch-all session operation routes should exist",
  ).toBe(true);
  const [createModule, sessionOperationModule] = modules;
  if (!createModule || !sessionOperationModule) {
    throw new Error("Per-chat Eve proxy routes are missing");
  }
  const postSessionOperation =
    sessionOperationModule.POST as SessionOperationRoute;
  const getSessionOperation =
    sessionOperationModule.GET as SessionOperationRoute;

  return {
    createSession: createModule.POST as PostRoute<{ chatId: string }>,
    continueSession: (request, context) =>
      context.params.then(({ chatId, sessionId }) =>
        postSessionOperation(request, {
          params: Promise.resolve({ chatId, sessionPath: [sessionId] }),
        }),
      ),
    cancelSession: (request, context) =>
      context.params.then(({ chatId, sessionId }) =>
        postSessionOperation(request, {
          params: Promise.resolve({
            chatId,
            sessionPath: [sessionId, "cancel"],
          }),
        }),
      ),
    streamSession: (request, context) =>
      context.params.then(({ chatId, sessionId }) =>
        getSessionOperation(request, {
          params: Promise.resolve({
            chatId,
            sessionPath: [sessionId, "stream"],
          }),
        }),
      ),
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
    setCallerTokenVerifierForTests(testVerifier);
  });

  afterEach(async () => {
    setDbClientForTests(null);
    setCallerTokenVerifierForTests(null);
    await testDb.close();
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function fakeServer(options?: Parameters<typeof startFakeEveServer>[0]): Promise<FakeEveServer> {
    const server = await startFakeEveServer(options);
    servers.push(server);
    return server;
  }

  async function turnFixture(
    name: string,
    options?: Parameters<typeof startFakeEveServer>[0],
  ) {
    const server = await fakeServer(options);
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name,
      baseUrl: server.baseUrl,
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: name,
      ...chatIdentity,
    });
    const routes = await loadProxyRoutes();
    const turnRequest = (path: string, message: string): Request =>
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session${path}`, {
        method: "POST",
        headers: callerHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ message }),
      });

    return {
      chat,
      repository,
      server,
      chatState: () => repository.getChat(chat.id),
      upstreamTurns: () =>
        server.requests.filter(
          (captured) => captured.method === "POST" && !captured.path.endsWith("/cancel"),
        ),
      expireTurnLease: async () => {
        await testDb.db
          .update(chats)
          .set({ updatedAt: new Date(Date.now() - 10 * 60_000) })
          .where(eq(chats.id, chat.id));
      },
      create: (message: string) =>
        routes.createSession(turnRequest("", message), {
          params: Promise.resolve({ chatId: chat.id }),
        }),
      continue: (message: string, sessionId = "ses_1") =>
        routes.continueSession(turnRequest(`/${sessionId}`, message), {
          params: Promise.resolve({ chatId: chat.id, sessionId }),
        }),
      stream: (sessionId = "ses_1") =>
        routes.streamSession(
          new Request(
            `http://localhost/api/chats/${chat.id}/agent/eve/v1/session/${sessionId}/stream`,
            { headers: callerHeaders() },
          ),
          { params: Promise.resolve({ chatId: chat.id, sessionId }) },
        ),
      cancel: (sessionId = "ses_1") =>
        routes.cancelSession(
          new Request(
            `http://localhost/api/chats/${chat.id}/agent/eve/v1/session/${sessionId}/cancel`,
            {
              method: "POST",
              headers: callerHeaders({ "content-type": "application/json" }),
              body: "{}",
            },
          ),
          { params: Promise.resolve({ chatId: chat.id, sessionId }) },
        ),
    };
  }

  it("proxies an anonymous browser-session chat without an Eveland token", async () => {
    const server = await fakeServer();
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Public Eve",
      baseUrl: server.baseUrl,
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const session = resolveAppBrowserSession(
      new Request("http://localhost/api/chats"),
    );
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Hello",
      pendingUserMessage: "Hello",
      ownerClientId: session.clientId,
      evelandProjectId: "project_support",
    });
    const routes = await loadProxyRoutes();

    const response = await routes.createSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session`, {
        method: "POST",
        headers: {
          cookie: session.setCookie!.split(";")[0]!,
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: "Hello" }),
      }),
      { params: Promise.resolve({ chatId: chat.id }) },
    );

    expect(response.status).toBe(200);
    expect(server.requests[0]?.headers.authorization).toBeUndefined();
  });

  it("uses the App Token only for local ownership and does not infer Agent auth from Project ID", async () => {
    const server = await fakeServer();
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Secured Eve",
      baseUrl: server.baseUrl,
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Inspect file",
      pendingUserMessage: "Inspect this file",
      ...chatIdentity,
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
        headers: {
          authorization: "Bearer app-token",
          "content-type": "application/json",
        },
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
    expect(server.requests[0].headers.authorization).toBeUndefined();
    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      status: "active",
      pendingUserMessage: null,
      sessionState: { sessionId: "ses_1", continuationToken: "eve:1", streamIndex: 0 },
    });
  });

  it("forwards an Eveland authentication challenge, then sends a Caller Token only on retry", async () => {
    const challenge =
      'Bearer realm="eveland", authorization_uri="https://identity.example.com/identity/login", project_id="project_support", display_name="Eveland"';
    const server = await fakeServer({
      authenticationChallenge: {
        header: challenge,
        body: {
          code: "authentication_required",
          error: "Eveland authentication is required.",
        },
        acceptedAuthorization: "Bearer caller-token",
        headers: {
          "set-cookie": "agent_session=attacker; Path=/; HttpOnly",
          "x-agent-private": "must-not-cross-proxy",
        },
      },
    });
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Secured Eve",
      baseUrl: server.baseUrl,
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Authenticate",
      pendingUserMessage: "Hello",
      ...chatIdentity,
    });
    const routes = await loadProxyRoutes();
    const create = (authorization: string) =>
      routes.createSession(
        new Request(
          `http://localhost/api/chats/${chat.id}/agent/eve/v1/session`,
          {
            method: "POST",
            headers: {
              authorization,
              "content-type": "application/json",
            },
            body: JSON.stringify({ message: "Hello" }),
          },
        ),
        { params: Promise.resolve({ chatId: chat.id }) },
      );

    const challenged = await create("Bearer app-token");

    expect(challenged.status).toBe(401);
    expect(challenged.headers.get("www-authenticate")).toBe(challenge);
    expect(challenged.headers.get("cache-control")).toBe("no-store");
    expect(challenged.headers.get("set-cookie")).toBeNull();
    expect(challenged.headers.get("x-agent-private")).toBeNull();
    await expect(challenged.json()).resolves.toEqual({
      code: "authentication_required",
      error: "Eveland authentication is required.",
    });
    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      status: "active",
      pendingUserMessage: "Hello",
      sessionState: null,
    });

    const retried = await create("Bearer caller-token");

    expect(retried.status).toBe(200);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]?.headers.authorization).toBeUndefined();
    expect(server.requests[1]?.headers.authorization).toBe(
      "Bearer caller-token",
    );
  });

  it("uses the App Token only for local ownership and preserves external Agent auth", async () => {
    const server = await fakeServer();
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "External Eve",
      baseUrl: server.baseUrl,
      authType: "bearer",
      authConfigEncrypted: encryptAuthConfig({ bearerToken: "external-secret" }),
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "External turn",
      pendingUserMessage: "Hello",
      ownerIdentityIssuer: "https://identity.example.com",
      ownerIdentityPrincipalId: "ipr_user_1",
      ownerIdentityRealmId: "irl_account_1",
    });
    const routes = await loadProxyRoutes();

    const response = await routes.createSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session`, {
        method: "POST",
        headers: {
          authorization: "Bearer app-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: "Hello" }),
      }),
      { params: Promise.resolve({ chatId: chat.id }) },
    );

    expect(response.status).toBe(200);
    expect(server.requests[0]?.headers.authorization).toBe(
      "Bearer external-secret",
    );
  });

  it("keeps Eve 0.24 v18 sessions resumable without exposing a continuation token", async () => {
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
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Structured turn",
      ...chatIdentity,
    });
    const routes = await loadProxyRoutes();

    await routes.createSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session`, {
        method: "POST",
        headers: callerHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ message: "Read this" }),
      }),
      { params: Promise.resolve({ chatId: chat.id }) },
    );

    const stream = () =>
      routes.streamSession(
        new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1/stream`, {
          headers: callerHeaders(),
        }),
        { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
      );
    const firstResponse = await stream();

    expect(firstResponse.status).toBe(200);
    expect(firstResponse.headers.get("content-type")).toContain("application/x-ndjson");
    const forwardedEvents = (await firstResponse.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    const browserEvents = streamEvents.map((event) =>
      event.type === "session.waiting"
        ? {
            ...event,
            data: { ...event.data, continuationToken: EVE_PROXY_CONTINUATION_TOKEN },
          }
        : event,
    );
    expect(forwardedEvents).toEqual(browserEvents);

    const stored = await repository.listEvents(chat.id);
    expect(stored).toHaveLength(streamEvents.length);
    expect(stored.map((event) => event.payload)).toEqual(browserEvents);
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

  it("stores Eve 0.25 v19 continuation tokens server-side and replaces them in the browser stream", async () => {
    const streamEvents = [
      {
        type: "message.completed",
        data: {
          message: "Done",
          finishReason: "stop",
          sequence: 1,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      {
        type: "session.waiting",
        data: { wait: "next-user-message", continuationToken: "eve:rotated" },
      },
    ] as const;
    const server = await fakeServer({ streamEvents, streamVersion: 19 });
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Eve 0.25",
      baseUrl: server.baseUrl,
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Rotating token",
      ...chatIdentity,
    });
    await repository.updateChatSessionState(chat.id, {
      sessionId: "ses_1",
      continuationToken: "eve:1",
      streamIndex: 0,
    });
    const routes = await loadProxyRoutes();

    const response = await routes.streamSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1/stream`, {
        headers: callerHeaders(),
      }),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );

    expect(response.status).toBe(200);
    const forwardedEvents = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    expect(forwardedEvents).toEqual([
      streamEvents[0],
      {
        type: "session.waiting",
        data: {
          wait: "next-user-message",
          continuationToken: EVE_PROXY_CONTINUATION_TOKEN,
        },
      },
    ]);
    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      sessionState: {
        sessionId: "ses_1",
        continuationToken: "eve:rotated",
        streamIndex: 2,
      },
    });
  });

  it("injects the stored continuation token for HITL responses and rejects another session id", async () => {
    const server = await fakeServer();
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Approval Eve",
      baseUrl: server.baseUrl,
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Approval",
      ...chatIdentity,
    });
    await repository.updateChatSessionState(chat.id, {
      sessionId: "ses_1",
      continuationToken: "eve:1",
      streamIndex: 7,
      turnGeneration: 1,
      turnState: "waiting",
    });
    const routes = await loadProxyRoutes();

    const response = await routes.continueSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1`, {
        method: "POST",
        headers: callerHeaders({ "content-type": "application/json" }),
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
        headers: callerHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ message: "wrong session" }),
      }),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_2" }) },
    );

    expect(mismatched.status).toBe(409);
    await expect(mismatched.json()).resolves.toEqual({ error: "Eve session does not belong to this chat" });
    expect(server.requests).toHaveLength(1);
  });

  it("authenticates cancel with the same Caller Token and forwards only the turn guard", async () => {
    const server = await fakeServer();
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Cancelable Eve",
      baseUrl: server.baseUrl,
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Cancelable",
      ...chatIdentity,
    });
    await repository.updateChatSessionState(chat.id, {
      sessionId: "ses_1",
      continuationToken: "eve:1",
      streamIndex: 3,
    });
    const routes = await loadProxyRoutes();

    const response = await routes.cancelSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1/cancel`, {
        method: "POST",
        headers: callerHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          turnId: "turn_1",
          continuationToken: "must-not-forward",
        }),
      }),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      sessionId: "ses_1",
      status: "accepted",
    });
    const posted = server.requests.filter((captured) => captured.method === "POST");
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      method: "POST",
      path: "/eve/v1/session/ses_1/cancel",
      body: { turnId: "turn_1" },
    });
    expect(posted[0].headers.authorization).toBe("Bearer caller-token");
    // Cancelling also drains eve's confirmation, which is where the continuation
    // token the next turn needs arrives. That read carries the caller's token too.
    const streamed = server.requests.filter((captured) => captured.method === "GET");
    expect(streamed).toMatchObject([{ path: "/eve/v1/session/ses_1/stream" }]);
    expect(streamed[0].headers.authorization).toBe("Bearer caller-token");
  });

  it("returns 404 instead of revealing another principal's chat", async () => {
    const server = await fakeServer();
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Private Eve",
      baseUrl: server.baseUrl,
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Private",
      ...chatIdentity,
    });
    const routes = await loadProxyRoutes();

    const response = await routes.createSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session`, {
        method: "POST",
        headers: callerHeaders(
          { "content-type": "application/json" },
          "other-caller-token",
        ),
        body: JSON.stringify({ message: "Steal this chat" }),
      }),
      { params: Promise.resolve({ chatId: chat.id }) },
    );

    expect(response.status).toBe(404);
    expect(server.requests).toEqual([]);
  });

  it("routes a duplicate create onto the stored session and rejects it only while a turn is live", async () => {
    const turn = await turnFixture("Resumable Eve");

    const first = await turn.create("Hello");

    expect(first.status).toBe(200);
    await expect(turn.chatState()).resolves.toMatchObject({
      status: "active",
      sessionState: { sessionId: "ses_1", continuationToken: "eve:1", turnState: "running" },
    });

    const duplicate = await turn.create("Hello");

    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toEqual({
      error: "Eve is still working on the previous message",
    });
    expect(turn.upstreamTurns()).toHaveLength(1);
    await expect(turn.chatState()).resolves.toMatchObject({
      sessionState: { turnGeneration: 1, turnState: "running" },
    });

    await (await turn.stream()).text();

    await expect(turn.chatState()).resolves.toMatchObject({
      status: "active",
      sessionState: { turnGeneration: 1, turnState: "waiting" },
    });

    const parked = await turn.create("Are you there?");

    expect(parked.status).toBe(200);
    expect(turn.upstreamTurns()).toHaveLength(2);
    expect(turn.server.requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/eve/v1/session/ses_1",
      body: { message: "Are you there?", continuationToken: "eve:1" },
    });
    await expect(turn.chatState()).resolves.toMatchObject({
      status: "active",
      sessionState: { turnGeneration: 2, turnState: "running" },
    });
  });

  it("accepts the next message once a stale running turn stops being observed", async () => {
    const turn = await turnFixture("Abandoned Eve");
    await turn.create("Hello");

    const tooSoon = await turn.continue("Still there?");

    expect(tooSoon.status).toBe(409);
    expect(turn.upstreamTurns()).toHaveLength(1);

    await turn.expireTurnLease();
    const afterLease = await turn.continue("Still there?");

    expect(afterLease.status).toBe(200);
    expect(turn.server.requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/eve/v1/session/ses_1",
      body: { message: "Still there?", continuationToken: "eve:1" },
    });
    await expect(turn.chatState()).resolves.toMatchObject({
      status: "active",
      sessionState: { turnGeneration: 2, turnState: "running" },
    });
  });

  it("releases the turn when the browser disconnects from the stream", async () => {
    const turn = await turnFixture("Detaching Eve", { holdStreamOpen: true });
    await turn.create("Hello");

    const streamResponse = await turn.stream();
    const reader = streamResponse.body!.getReader();
    await reader.read();
    await reader.cancel();

    await expect(turn.chatState()).resolves.toMatchObject({
      status: "active",
      sessionState: { turnState: "detached" },
    });

    const next = await turn.continue("Never mind, do this instead");

    expect(next.status).toBe(200);
    expect(turn.server.requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/eve/v1/session/ses_1",
      body: { message: "Never mind, do this instead", continuationToken: "eve:1" },
    });
  });

  it("parks the session after a cancelled turn so the next message is accepted", async () => {
    const turn = await turnFixture("Cancelling Eve", { holdStreamOpen: true });
    await turn.create("Hello");

    const cancelled = await turn.cancel();

    expect(cancelled.status).toBe(200);
    await expect(turn.chatState()).resolves.toMatchObject({
      status: "active",
      sessionState: { sessionId: "ses_1", continuationToken: "eve:1", turnState: "waiting" },
    });

    const next = await turn.continue("Do this instead");

    expect(next.status).toBe(200);
    expect(turn.server.requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/eve/v1/session/ses_1",
      body: { message: "Do this instead", continuationToken: "eve:1" },
    });
  });

  it("starts a fresh Eve session when a failed chat receives another message", async () => {
    const turn = await turnFixture("Recovering Eve", { emptyStream: true });
    await turn.create("Hello");
    await (await turn.stream()).text();

    await expect(turn.chatState()).resolves.toMatchObject({
      status: "failed",
      sessionState: { sessionId: "ses_1", turnState: "failed" },
    });

    const recovered = await turn.create("Let us try again");

    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toMatchObject({ sessionId: "ses_2" });
    expect(turn.server.requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/eve/v1/session",
      body: { message: "Let us try again" },
    });
    expect(turn.server.requests.at(-1)?.body).not.toHaveProperty("continuationToken");
    await expect(turn.chatState()).resolves.toMatchObject({
      status: "active",
      sessionState: {
        sessionId: "ses_2",
        continuationToken: "eve:2",
        streamIndex: 0,
        turnGeneration: 1,
        turnState: "running",
      },
    });
  });

  it("reads the turn boundary from persisted events for sessions stored before turn tracking", async () => {
    const turn = await turnFixture("Legacy Eve");
    await turn.create("Hello");
    await (await turn.stream()).text();
    // A session state written before turnGeneration/turnState existed.
    await turn.repository.updateChatSessionState(
      turn.chat.id,
      { sessionId: "ses_1", continuationToken: "eve:1", streamIndex: 3 },
      "active",
    );

    const next = await turn.continue("Anything else?");

    expect(next.status).toBe(200);
    expect(turn.server.requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/eve/v1/session/ses_1",
      body: { message: "Anything else?", continuationToken: "eve:1" },
    });
    await expect(turn.chatState()).resolves.toMatchObject({
      status: "active",
      sessionState: { streamIndex: 3, turnGeneration: 1, turnState: "running" },
    });
  });

  it("marks the chat failed when the agent's stream dies mid-turn without a boundary event", async () => {
    const server = await fakeServer({ emptyStream: true });
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Flaky Eve",
      baseUrl: server.baseUrl,
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Dies mid-turn",
      ...chatIdentity,
    });
    const routes = await loadProxyRoutes();

    await routes.createSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session`, {
        method: "POST",
        headers: callerHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ message: "Hello" }),
      }),
      { params: Promise.resolve({ chatId: chat.id }) },
    );

    const streamResponse = await routes.streamSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1/stream`, {
        headers: callerHeaders(),
      }),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );

    expect(streamResponse.status).toBe(200);
    await streamResponse.text();

    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      status: "failed",
      sessionState: { turnState: "failed" },
    });
  });

  it("marks the chat failed when the stream throws before its first event", async () => {
    const server = await fakeServer({ malformedStream: true });
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Malformed Eve",
      baseUrl: server.baseUrl,
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Fails before streaming",
      ...chatIdentity,
    });
    const routes = await loadProxyRoutes();

    await routes.createSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session`, {
        method: "POST",
        headers: callerHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ message: "Hello" }),
      }),
      { params: Promise.resolve({ chatId: chat.id }) },
    );

    const response = await routes.streamSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1/stream`, {
        headers: callerHeaders(),
      }),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );

    expect(response.status).toBe(502);
    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      status: "failed",
      sessionState: { turnState: "failed" },
    });
  });

  it("streams past an earlier turn's boundary when a reset client replays from the start", async () => {
    // A full session replay: turn 1 ended at index 2, turn 2 is still running.
    const server = await fakeServer({
      streamEvents: [
        {
          type: "message.appended",
          data: { messageDelta: "One", messageSoFar: "One", sequence: 1, stepIndex: 0, turnId: "turn_1" },
        },
        {
          type: "message.completed",
          data: { message: "One", finishReason: "stop", sequence: 2, stepIndex: 0, turnId: "turn_1" },
        },
        { type: "session.waiting", data: { wait: "next-user-message", continuationToken: "eve:stale" } },
        {
          type: "message.appended",
          data: { messageDelta: "Two", messageSoFar: "Two", sequence: 1, stepIndex: 0, turnId: "turn_2" },
        },
        { type: "session.waiting", data: { wait: "next-user-message", continuationToken: "eve:live" } },
      ],
    });
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Replaying Eve",
      baseUrl: server.baseUrl,
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Full replay",
      ...chatIdentity,
    });
    await repository.updateChatSessionState(
      chat.id,
      {
        sessionId: "ses_1",
        continuationToken: "eve:current",
        streamIndex: 3,
        turnGeneration: 2,
        turnState: "running",
      },
      "active",
    );
    const routes = await loadProxyRoutes();

    const response = await routes.streamSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1/stream`, {
        headers: callerHeaders(),
      }),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );
    const forwarded = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));

    // The replayed boundary at index 2 must not end the stream before turn 2.
    expect(forwarded).toHaveLength(5);
    expect(forwarded.at(-1)).toMatchObject({ type: "session.waiting" });
    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      status: "active",
      sessionState: {
        continuationToken: "eve:live",
        streamIndex: 5,
        turnGeneration: 2,
        turnState: "waiting",
      },
    });
  });

  it("keeps a parked chat active when replay starts after its persisted boundary", async () => {
    const server = await fakeServer({ respectStreamStartIndex: true });
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Replayable Eve",
      baseUrl: server.baseUrl,
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Replay boundary",
      ...chatIdentity,
    });
    const routes = await loadProxyRoutes();

    await routes.createSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session`, {
        method: "POST",
        headers: callerHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ message: "Hello" }),
      }),
      { params: Promise.resolve({ chatId: chat.id }) },
    );
    const first = await routes.streamSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1/stream`, {
        headers: callerHeaders(),
      }),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );
    await first.text();

    const replay = await routes.streamSession(
      new Request(
        `http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1/stream?startIndex=3`,
        { headers: callerHeaders() },
      ),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );

    expect(replay.status).toBe(200);
    await expect(replay.text()).resolves.toBe("");
    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      status: "active",
      sessionState: {
        sessionId: "ses_1",
        streamIndex: 3,
        turnGeneration: 1,
        turnState: "waiting",
      },
    });
  });

  it("keeps a chat active when the agent parks a turn awaiting authorization", async () => {
    // eve parks a turn on an OAuth callback and resumes it after the user signs
    // in. That park emits no `session.*` boundary, so the stream ending here is
    // not a crash and must not cost the user the turn they can still complete.
    const turn = await turnFixture("Authorizing Eve", {
      streamEvents: [
        {
          type: "message.appended",
          data: { messageDelta: "Signing", messageSoFar: "Signing", sequence: 1, stepIndex: 0, turnId: "turn_1" },
        },
        {
          type: "authorization.required",
          data: {
            name: "linear",
            description: "Authorization required for linear",
            sequence: 2,
            stepIndex: 0,
            turnId: "turn_1",
          },
        },
      ],
    });
    await turn.create("Read my Linear issues");

    await (await turn.stream()).text();

    await expect(turn.chatState()).resolves.toMatchObject({
      status: "active",
      sessionState: { sessionId: "ses_1", continuationToken: "eve:1", turnState: "parked" },
    });

    const next = await turn.continue("I signed in");

    expect(next.status).toBe(200);
    expect(turn.server.requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/eve/v1/session/ses_1",
      body: { message: "I signed in", continuationToken: "eve:1" },
    });
  });

  it("stores the continuation token eve confirms when a turn is cancelled", async () => {
    const turn = await turnFixture("Confirming Eve", {
      holdStreamOpen: true,
      streamEvents: [
        {
          type: "message.appended",
          data: { messageDelta: "Working", messageSoFar: "Working", sequence: 1, stepIndex: 0, turnId: "turn_1" },
        },
      ],
      cancelledStreamEvents: [
        {
          type: "message.appended",
          data: { messageDelta: "Working", messageSoFar: "Working", sequence: 1, stepIndex: 0, turnId: "turn_1" },
        },
        { type: "turn.cancelled", data: { sequence: 2, turnId: "turn_1" } },
        {
          type: "session.waiting",
          data: { wait: "next-user-message", continuationToken: "eve:after-cancel" },
        },
      ],
    });
    await turn.create("Hello");
    const streamResponse = await turn.stream();
    const reader = streamResponse.body!.getReader();
    await reader.read();
    await reader.cancel();

    const cancelled = await turn.cancel();

    expect(cancelled.status).toBe(200);
    await expect(turn.chatState()).resolves.toMatchObject({
      status: "active",
      sessionState: {
        sessionId: "ses_1",
        continuationToken: "eve:after-cancel",
        streamIndex: 3,
        turnState: "waiting",
      },
    });

    const next = await turn.continue("Do this instead");

    expect(next.status).toBe(200);
    expect(turn.server.requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/eve/v1/session/ses_1",
      body: { message: "Do this instead", continuationToken: "eve:after-cancel" },
    });
  });

  it("parks a cancelled turn anyway when eve never confirms on the stream", async () => {
    const turn = await turnFixture("Silent Eve", {
      holdStreamOpen: true,
      cancelledStreamEvents: [],
    });
    await turn.create("Hello");

    const cancelled = await turn.cancel();

    expect(cancelled.status).toBe(200);
    await expect(turn.chatState()).resolves.toMatchObject({
      status: "active",
      sessionState: { sessionId: "ses_1", continuationToken: "eve:1", turnState: "waiting" },
    });

    const next = await turn.continue("Do this instead");

    expect(next.status).toBe(200);
  });

  it("starts a fresh Eve session when a failed chat is continued rather than recreated", async () => {
    const turn = await turnFixture("Retrying Eve", { emptyStream: true });
    await turn.create("Hello");
    await (await turn.stream()).text();
    await expect(turn.chatState()).resolves.toMatchObject({ status: "failed" });

    const recovered = await turn.continue("Let us try again");

    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toMatchObject({ sessionId: "ses_2" });
    expect(turn.server.requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/eve/v1/session",
      body: { message: "Let us try again" },
    });
    expect(turn.server.requests.at(-1)?.body).not.toHaveProperty("continuationToken");
    await expect(turn.chatState()).resolves.toMatchObject({
      status: "active",
      sessionState: { sessionId: "ses_2", turnGeneration: 1, turnState: "running" },
    });
  });

  it("forwards a replay in full but yields the live turn to a newer one", async () => {
    const turn = await turnFixture("Contended Eve", {
      streamEvents: [
        {
          type: "message.appended",
          data: { messageDelta: "One", messageSoFar: "One", sequence: 1, stepIndex: 0, turnId: "turn_1" },
        },
        {
          type: "message.completed",
          data: { message: "One", finishReason: "stop", sequence: 2, stepIndex: 0, turnId: "turn_1" },
        },
        { type: "session.waiting", data: { wait: "next-user-message", continuationToken: "eve:stale" } },
        {
          type: "message.appended",
          data: { messageDelta: "Two", messageSoFar: "Two", sequence: 1, stepIndex: 0, turnId: "turn_2" },
        },
        { type: "session.waiting", data: { wait: "next-user-message", continuationToken: "eve:live" } },
      ],
    });
    await turn.repository.updateChatSessionState(
      turn.chat.id,
      {
        sessionId: "ses_1",
        continuationToken: "eve:current",
        streamIndex: 3,
        turnGeneration: 2,
        turnState: "running",
      },
      "active",
    );

    // The route reads the session before the body is pulled, so bumping the
    // generation here is a turn taking over mid-replay.
    const response = await turn.stream();
    await turn.repository.updateChatSessionState(
      turn.chat.id,
      {
        sessionId: "ses_1",
        continuationToken: "eve:current",
        streamIndex: 3,
        turnGeneration: 3,
        turnState: "running",
      },
      "active",
    );
    const forwarded = (await response.text())
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));

    // Events 0-2 are below the persisted cursor, so they never contend for the
    // session and the replaying client still receives all of them.
    expect(forwarded).toHaveLength(3);
    expect(forwarded.map((event) => event.type)).toEqual([
      "message.appended",
      "message.completed",
      "session.waiting",
    ]);
    await expect(turn.chatState()).resolves.toMatchObject({
      status: "active",
      sessionState: { turnGeneration: 3, turnState: "running", continuationToken: "eve:current" },
    });
  });
});

const chatIdentity = {
  ownerIdentityIssuer: "https://identity.example.com",
  ownerIdentityPrincipalId: "ipr_user_1",
  ownerIdentityRealmId: "irl_account_1",
  evelandProjectId: "project_support",
} as const;

function callerHeaders(
  headers: Record<string, string> = {},
  token = "caller-token",
): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...headers };
}

const testVerifier: CallerTokenVerifier = {
  async verifyAuthorization(authorization, expectedProjectId) {
    const principalId =
      authorization === "Bearer caller-token"
        ? "ipr_user_1"
        : authorization === "Bearer other-caller-token"
          ? "ipr_user_2"
          : null;
    if (!principalId || (expectedProjectId && expectedProjectId !== "project_support")) {
      throw new CallerTokenError(
        "caller_token_invalid",
        401,
        "The Eveland Caller Token is invalid.",
      );
    }
    return {
      issuer: "https://identity.example.com",
      principalId,
      realmId: "irl_account_1",
      projectId: "project_support",
      agentUrl: null,
      expiresAt: 1_900_000_000,
    };
  },
  async verifyAppAuthorization(authorization, expectedTarget) {
    if (authorization !== "Bearer app-token" || expectedTarget !== "eve-chats") {
      throw new CallerTokenError(
        "caller_token_invalid",
        401,
        "The Eveland App Token is invalid.",
      );
    }
    return {
      issuer: "https://identity.example.com",
      principalId: "ipr_user_1",
      realmId: "irl_account_1",
      expiresAt: 1_900_000_000,
    };
  },
};
