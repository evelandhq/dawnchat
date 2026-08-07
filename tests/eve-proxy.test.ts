import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveAppBrowserSession } from "@/app-session";
import { setDbClientForTests } from "@/db/provider";
import { createRepository } from "@/db/repository";
import { startFakeEveServer, type FakeEveServer } from "@/eve/fake-eve-server.test-helper";
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

    expect(response.status).toBe(202);
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

    expect(response.status).toBe(202);
    const responseBody = (await response.json()) as Record<string, unknown>;
    expect(responseBody).toMatchObject({ sessionId: "ses_1" });
    expect(responseBody).not.toHaveProperty("continuationToken");
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      path: "/eve/v1/session",
      body: { message, clientContext: { surface: "eve-chats" } },
    });
    expect(server.requests[0].headers.authorization).toBeUndefined();
    const stored = await repository.getChat(chat.id);
    expect(stored).toMatchObject({ status: "active", pendingUserMessage: null });
    // Eve 0.31 answers without a token; the absent field marks the session
    // ID-addressed for every later turn.
    expect(stored?.sessionState).toEqual({ sessionId: "ses_1", streamIndex: 0 });
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

    expect(retried.status).toBe(202);
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

    expect(response.status).toBe(202);
    expect(server.requests[0]?.headers.authorization).toBe(
      "Bearer external-secret",
    );
  });

  it("keeps Eve 0.29 v20 sessions resumable without exposing a continuation token", async () => {
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
    const server = await fakeServer({ generation: "0.29", streamEvents });
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
    // The parked session is reported to the browser by ID, never by the token
    // that would let it continue the conversation directly.
    const browserEvents = streamEvents.map((event) =>
      event.type === "session.waiting"
        ? { ...event, data: { ...event.data, continuationToken: "ses_1" } }
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

  it("stores Eve 0.30 continuation tokens server-side and strips them from the browser stream", async () => {
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
    const server = await fakeServer({ generation: "0.30", streamEvents });
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Eve 0.30",
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
        data: { wait: "next-user-message", continuationToken: "ses_1" },
      },
    ]);
    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      sessionState: {
        sessionId: "ses_1",
        continuationToken: "eve:rotated",
        streamIndex: 2,
      },
    });

    const continued = await routes.continueSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1`, {
        method: "POST",
        headers: callerHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ message: "And again" }),
      }),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );

    expect(continued.status).toBe(200);
    expect(server.requests.at(-1)).toMatchObject({
      path: "/eve/v1/session/ses_1",
      body: { message: "And again", continuationToken: "eve:rotated" },
    });
  });

  it("addresses an Eve 0.31 follow-up by session id alone", async () => {
    const server = await fakeServer({ generation: "0.31" });
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Eve 0.31",
      baseUrl: server.baseUrl,
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Fixed session",
      ...chatIdentity,
    });
    await repository.updateChatSessionState(chat.id, {
      sessionId: "ses_1",
      streamIndex: 4,
    });
    const routes = await loadProxyRoutes();

    const response = await routes.continueSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1`, {
        method: "POST",
        headers: callerHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          continuationToken: "untrusted-browser-token",
          message: "Keep going",
        }),
      }),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );

    expect(response.status).toBe(202);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0].body).toEqual({ message: "Keep going" });
    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      sessionState: { sessionId: "ses_1", streamIndex: 4 },
    });
  });

  it("drops a stale continuation token when the Agent upgrades to Eve 0.31", async () => {
    const server = await fakeServer({ generation: "0.31" });
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Upgraded Eve",
      baseUrl: server.baseUrl,
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Upgraded mid-session",
      ...chatIdentity,
    });
    // Opened while the Agent still ran Eve 0.30.
    await repository.updateChatSessionState(chat.id, {
      sessionId: "ses_1",
      continuationToken: "eve:1",
      streamIndex: 2,
    });
    const routes = await loadProxyRoutes();

    const response = await routes.continueSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1`, {
        method: "POST",
        headers: callerHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ message: "Still there?" }),
      }),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );

    expect(response.status).toBe(202);
    expect(server.requests.map((entry) => entry.body)).toEqual([
      { message: "Still there?", continuationToken: "eve:1" },
      { message: "Still there?" },
    ]);
    const stored = await repository.getChat(chat.id);
    expect(stored?.sessionState).toEqual({ sessionId: "ses_1", streamIndex: 2 });
  });

  it("injects the stored continuation token for HITL responses and rejects another session id", async () => {
    const server = await fakeServer({ generation: "0.30" });
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
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      path: "/eve/v1/session/ses_1/cancel",
      body: { turnId: "turn_1" },
    });
    expect(server.requests[0].headers.authorization).toBe("Bearer caller-token");
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
