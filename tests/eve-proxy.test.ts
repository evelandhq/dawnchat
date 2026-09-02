import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveAppBrowserSession } from "@/app-session";
import { setDbClientForTests } from "@/db/provider";
import { createRepository } from "@/db/repository";
import { chats } from "@/db/schema";
import { defaultMessageReducer, type MessageStreamEvent } from "eve/client";

import {
  startFakeEveServer,
  SUPPORTED_EVE_GENERATIONS,
  type FakeEveServer,
} from "@/eve/fake-eve-server.test-helper";
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
    vi.restoreAllMocks();
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

  it("logs and forwards an upstream Eve error id without logging the message", async () => {
    const server = await fakeServer({ failCreateSession: true });
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Failing Eve",
      baseUrl: server.baseUrl,
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Failure observability",
      pendingUserMessage: "sensitive prompt must not be logged",
      ...chatIdentity,
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const routes = await loadProxyRoutes();

    const response = await routes.createSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session`, {
        method: "POST",
        headers: callerHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ message: "sensitive prompt must not be logged" }),
      }),
      { params: Promise.resolve({ chatId: chat.id }) },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Failed to create fake session Error ID: err_fake_session_create",
      errorId: "err_fake_session_create",
      ok: false,
    });
    expect(consoleError).toHaveBeenCalledWith("Eve agent request failed", {
      chatId: chat.id,
      status: 500,
      errorId: "err_fake_session_create",
    });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
      "sensitive prompt must not be logged",
    );
    await expect(repository.getChat(chat.id)).resolves.toMatchObject({ status: "failed" });
  });

  it("logs an error id from a streamed session failure after accepting creation", async () => {
    const sessionFailure = {
      type: "session.failed",
      data: {
        code: "MODEL_CALL_FAILED",
        details: { errorId: "err_streamed_session_failure" },
        message: "Forbidden",
        sessionId: "ses_1",
      },
    } as const;
    const server = await fakeServer({
      generation: "0.47",
      streamEvents: [sessionFailure],
    });
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Stream-failing Eve",
      baseUrl: server.baseUrl,
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Stream failure observability",
      pendingUserMessage: "sensitive streamed prompt",
      ...chatIdentity,
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const routes = await loadProxyRoutes();

    const created = await routes.createSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session`, {
        method: "POST",
        headers: callerHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ message: "sensitive streamed prompt" }),
      }),
      { params: Promise.resolve({ chatId: chat.id }) },
    );
    expect(created.status).toBe(202);

    const streamed = await routes.streamSession(
      new Request(
        `http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1/stream`,
        { headers: callerHeaders() },
      ),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );

    expect(streamed.status).toBe(200);
    await expect(streamed.json()).resolves.toEqual(sessionFailure);
    expect(consoleError).toHaveBeenCalledWith("Eve agent session failed", {
      chatId: chat.id,
      sessionId: "ses_1",
      errorId: "err_streamed_session_failure",
    });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
      "sensitive streamed prompt",
    );
    await expect(repository.getChat(chat.id)).resolves.toMatchObject({ status: "failed" });
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
    // Supported sessions are ID-addressed and persist only their stream cursor.
    expect(stored?.sessionState).toEqual({ sessionId: "ses_1", streamIndex: 0 });
  });

  it("forwards an Eveland authentication challenge, then sends a Caller Token only on retry", async () => {
    const challenge =
      'Bearer realm="eveland", authorization_uri="https://identity.example.com/api/identity/login", project_id="project_support", display_name="Eveland"';
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

  it("forwards a structured v24 stream without exposing its waiting capability", async () => {
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
              kind: "tool-approval",
              prompt: "Allow reading the report?",
              display: "confirmation",
              options: [
                { id: "approve", label: "Allow", style: "primary" },
                { id: "cancel", label: "Cancel", style: "danger" },
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
    const server = await fakeServer({ generation: "0.47", streamEvents });
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
    // The parked session is reported to the browser by ID, never by the
    // channel-local capability that could answer it directly.
    const browserEvents = streamEvents.map((event) =>
      event.type === "session.waiting"
        ? { ...event, data: { ...event.data, continuationToken: "ses_1" } }
        : event,
    );
    expect(forwardedEvents).toEqual(browserEvents);

    // Deltas are forwarded but never persisted; the stored stream keeps each
    // event's true position so a replay still dedupes by (session, index).
    const persistedEvents = browserEvents.filter(
      (event) => event.type !== "reasoning.appended",
    );
    const stored = await repository.listEvents(chat.id);
    expect(stored).toHaveLength(persistedEvents.length);
    expect(stored.map((event) => event.payload)).toEqual(persistedEvents);
    expect(stored.map((event) => event.eventIndex)).toEqual([1, 2, 3, 4]);
    expect(stored).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: "ses_1", streamIndex: 0, type: "message.received" }),
        expect.objectContaining({ sessionId: "ses_1", streamIndex: 4, type: "session.waiting" }),
      ]),
    );
    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      status: "active",
      sessionState: { sessionId: "ses_1", streamIndex: 5 },
    });

    const replayResponse = await stream();
    expect(replayResponse.status).toBe(200);
    await replayResponse.text();
    await expect(repository.listEvents(chat.id)).resolves.toHaveLength(persistedEvents.length);
  });

  it("persists a projection-equivalent stream without its deltas", async () => {
    const streamEvents = [
      { type: "message.received", data: { message: "Hi", sequence: 1, turnId: "turn_1" } },
      { type: "step.started", data: { sequence: 2, stepIndex: 0, turnId: "turn_1" } },
      ...["He", "Hell", "Hello"].map((messageSoFar, index) => ({
        type: "message.appended",
        data: { messageSoFar, sequence: 3 + index, stepIndex: 0, turnId: "turn_1" },
      })),
      {
        type: "message.completed",
        data: { message: "Hello", finishReason: "tool-calls", sequence: 6, stepIndex: 0, turnId: "turn_1" },
      },
      {
        type: "action.input.appended",
        data: {
          callId: "call_1",
          inputTextDelta: '{"city":"Shang',
          inputTextOffset: 0,
          sequence: 7,
          stepIndex: 0,
          toolName: "weather",
          turnId: "turn_1",
        },
      },
      {
        type: "action.input.appended",
        data: {
          callId: "call_1",
          inputTextDelta: 'hai"}',
          inputTextOffset: 14,
          sequence: 8,
          stepIndex: 0,
          toolName: "weather",
          turnId: "turn_1",
        },
      },
      {
        type: "actions.requested",
        data: {
          actions: [
            {
              kind: "tool-call",
              callId: "call_1",
              toolName: "weather",
              input: { city: "Shanghai" },
            },
          ],
          sequence: 9,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      { type: "turn.completed", data: { sequence: 10, turnId: "turn_1" } },
      { type: "session.waiting", data: { wait: "next-user-message" } },
    ] as const;
    const server = await fakeServer({ generation: "0.47", streamEvents });
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Streaming Eve",
      baseUrl: server.baseUrl,
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Delta persistence",
      ...chatIdentity,
    });
    const routes = await loadProxyRoutes();
    await routes.createSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session`, {
        method: "POST",
        headers: callerHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ message: "Hi" }),
      }),
      { params: Promise.resolve({ chatId: chat.id }) },
    );

    const response = await routes.streamSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1/stream`, {
        headers: callerHeaders(),
      }),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );
    const forwarded = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as MessageStreamEvent);

    // The browser still receives every delta for live rendering.
    expect(forwarded.map((event) => event.type)).toEqual(
      streamEvents.map((event) => event.type),
    );

    const stored = await repository.listEvents(chat.id);
    expect(stored.map((event) => event.type)).toEqual([
      "message.received",
      "step.started",
      "message.completed",
      "actions.requested",
      "turn.completed",
      "session.waiting",
    ]);
    // The stored stream projects to exactly what the full stream projects to.
    const project = (events: readonly unknown[]) => {
      const reducer = defaultMessageReducer();
      let data = reducer.initial();
      for (const event of events) {
        data = reducer.reduce(data, event as MessageStreamEvent);
      }
      return data;
    };
    expect(project(stored.map((event) => event.payload))).toEqual(project(forwarded));
    // Deltas still count toward the cursor: the next stored event carried it.
    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      sessionState: { sessionId: "ses_1", streamIndex: streamEvents.length },
    });
  });

  it("recovers a cursor left behind by an unfinished delta run", async () => {
    // The stream dies inside a delta run: nothing after message.received is
    // persisted, so the stored cursor stays at 1 while Eve's stream is at 3.
    const streamEvents = [
      { type: "message.received", data: { message: "Hi", sequence: 1, turnId: "turn_1" } },
      {
        type: "message.appended",
        data: { messageSoFar: "Par", sequence: 2, stepIndex: 0, turnId: "turn_1" },
      },
      {
        type: "message.appended",
        data: { messageSoFar: "Part", sequence: 3, stepIndex: 0, turnId: "turn_1" },
      },
    ] as const;
    // Held open like a live turn: the disconnect below is the browser's, not
    // the script running out.
    const server = await fakeServer({
      generation: "0.47",
      streamEvents,
      holdStreamOpen: true,
    });
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Interrupted Eve",
      baseUrl: server.baseUrl,
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Cursor lag",
      ...chatIdentity,
    });
    const routes = await loadProxyRoutes();
    await routes.createSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session`, {
        method: "POST",
        headers: callerHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ message: "Hi" }),
      }),
      { params: Promise.resolve({ chatId: chat.id }) },
    );
    const streamLines = async (lineCount: number): Promise<string[]> => {
      const abort = new AbortController();
      const response = await routes.streamSession(
        new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1/stream`, {
          headers: callerHeaders(),
          signal: abort.signal,
        }),
        { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
      );
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while ((text.match(/\n/g)?.length ?? 0) < lineCount) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      abort.abort();
      await reader.cancel().catch(() => undefined);
      return text.trim().split("\n").slice(0, lineCount);
    };

    const first = await streamLines(3);
    expect(first.map((line) => (JSON.parse(line) as MessageStreamEvent).type)).toEqual([
      "message.received",
      "message.appended",
      "message.appended",
    ]);
    // Only message.received persisted; the deltas advanced no stored state.
    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      sessionState: { sessionId: "ses_1", streamIndex: 1 },
    });
    await expect(repository.listEvents(chat.id)).resolves.toHaveLength(1);

    // The reconnect replays the gap from Eve: the browser gets the full run
    // again, the (session, stream index) key absorbs the row it already has,
    // and the lagged cursor neither duplicates rows nor rewinds.
    const replayed = await streamLines(3);
    expect(replayed.map((line) => (JSON.parse(line) as MessageStreamEvent).type)).toEqual([
      "message.received",
      "message.appended",
      "message.appended",
    ]);
    await expect(repository.listEvents(chat.id)).resolves.toHaveLength(1);
    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      sessionState: { sessionId: "ses_1", streamIndex: 1 },
    });
  });

  it("redacts the supported stream's waiting capability without persisting it", async () => {
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
    const server = await fakeServer({ generation: "0.47", streamEvents });
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Waiting Eve",
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

    expect(continued.status).toBe(202);
    expect(server.requests.at(-1)).toMatchObject({
      path: "/eve/v1/session/ses_1",
      body: { message: "And again" },
    });
  });

  it.each(SUPPORTED_EVE_GENERATIONS)(
    "addresses an Eve %s follow-up by session id alone",
    async (generation) => {
      const server = await fakeServer({ generation });
      const repository = createRepository(testDb.db);
      const agent = await repository.createAgentConnection({
        name: "Current Eve",
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
    },
  );

  it("retries an Eve 0.49 message while its session becomes active", async () => {
    const server = await fakeServer({
      generation: "0.49",
      continueSessionNotActiveCount: 3,
    });
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Starting Eve",
      baseUrl: server.baseUrl,
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Early follow-up",
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
        body: JSON.stringify({ message: "Keep going" }),
      }),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );

    expect(response.status).toBe(202);
    expect(server.requests).toHaveLength(4);
    expect(server.requests.map((request) => request.body)).toEqual([
      { message: "Keep going" },
      { message: "Keep going" },
      { message: "Keep going" },
      { message: "Keep going" },
    ]);
    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      status: "active",
    });
  });

  it("stops retrying an Eve 0.49 message after three retries", async () => {
    const server = await fakeServer({
      generation: "0.49",
      continueSessionNotActiveCount: 4,
    });
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Inactive Eve",
      baseUrl: server.baseUrl,
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Inactive follow-up",
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
        body: JSON.stringify({ message: "Still there?" }),
      }),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );

    expect(response.status).toBe(409);
    expect(server.requests).toHaveLength(4);
    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      status: "failed",
    });
  });

  it("does not retry HITL answers when an Eve 0.49 session is inactive", async () => {
    const server = await fakeServer({
      generation: "0.49",
      continueSessionNotActiveCount: 1,
    });
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Answering Eve",
      baseUrl: server.baseUrl,
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Inactive answer",
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
          inputResponses: [{ requestId: "call_metric", optionId: "gmv_payors" }],
        }),
      }),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );

    expect(response.status).toBe(409);
    expect(server.requests).toHaveLength(1);
  });

  it("records forwarded HITL answers so a replay can show what was picked", async () => {
    const server = await fakeServer({ generation: "0.47" });
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Answering Eve",
      baseUrl: server.baseUrl,
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Which metric?",
      ...chatIdentity,
    });
    await repository.updateChatSessionState(chat.id, { sessionId: "ses_1", streamIndex: 4 });
    await repository.appendEvent({
      chatId: chat.id,
      sessionId: "ses_1",
      streamIndex: 0,
      type: "session.waiting",
      payload: { type: "session.waiting", data: { wait: "next-user-message" } },
    });
    const routes = await loadProxyRoutes();
    const inputResponses = [{ requestId: "call_metric", optionId: "gmv_payors" }];

    const response = await routes.continueSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1`, {
        method: "POST",
        headers: callerHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ inputResponses }),
      }),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );

    expect(response.status).toBe(202);
    const stored = await repository.listEvents(chat.id);
    expect(stored.at(-1)).toMatchObject({
      type: "client.input.responded",
      payload: { type: "client.input.responded", data: { responses: inputResponses } },
    });
  });

  it("stores no response event when the turn never reaches the Agent", async () => {
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Unreachable Eve",
      // Port 1 refuses, so the turn fails before Eve ever sees the answer.
      baseUrl: "http://127.0.0.1:1",
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Refused answer",
      ...chatIdentity,
    });
    await repository.updateChatSessionState(chat.id, { sessionId: "ses_1", streamIndex: 4 });
    const routes = await loadProxyRoutes();

    const response = await routes.continueSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1`, {
        method: "POST",
        headers: callerHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          inputResponses: [{ requestId: "call_metric", optionId: "gmv_payors" }],
        }),
      }),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );

    expect(response.ok).toBe(false);
    await expect(repository.listEvents(chat.id)).resolves.toEqual([]);
  });

  it("stores no response event for a turn that only carries a message", async () => {
    const server = await fakeServer({ generation: "0.47" });
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Chatting Eve",
      baseUrl: server.baseUrl,
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Plain turn",
      ...chatIdentity,
    });
    await repository.updateChatSessionState(chat.id, { sessionId: "ses_1", streamIndex: 4 });
    const routes = await loadProxyRoutes();

    await routes.continueSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1`, {
        method: "POST",
        headers: callerHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ message: "Keep going" }),
      }),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );

    await expect(repository.listEvents(chat.id)).resolves.toEqual([]);
  });

  it("continues an older chat by session id after its Agent upgrades", async () => {
    const server = await fakeServer({ generation: "0.47" });
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Current Eve",
      baseUrl: server.baseUrl,
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Old stored state",
      ...chatIdentity,
    });
    await testDb.db
      .update(chats)
      .set({
        sessionStateJson: JSON.stringify({
          sessionId: "ses_1",
          continuationToken: "obsolete",
          streamIndex: 2,
        }),
      })
      .where(eq(chats.id, chat.id));
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
    expect(server.requests.map((entry) => entry.body)).toEqual([{ message: "Still there?" }]);
    const stored = await repository.getChat(chat.id);
    expect(stored?.sessionState).toEqual({ sessionId: "ses_1", streamIndex: 2 });
  });

  it("strips untrusted tokens from HITL responses and rejects another session id", async () => {
    const server = await fakeServer({ generation: "0.47" });
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

    expect(response.status).toBe(202);
    expect(server.requests[0].body).toEqual({
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

  it("opens a park on persist, settles it on acceptance, and survives a replay", async () => {
    const streamEvents = [
      {
        type: "input.requested",
        data: {
          requests: [
            {
              requestId: "req_1",
              kind: "tool-approval",
              prompt: "Allow?",
              display: "confirmation",
              options: [{ id: "approve", label: "Allow" }],
              action: { kind: "tool-call", callId: "call_1", toolName: "delete_record", input: {} },
            },
          ],
          sequence: 1,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      { type: "session.waiting", data: { wait: "next-user-message" } },
    ] as const;
    const server = await fakeServer({ generation: "0.47", streamEvents });
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Parked Eve",
      baseUrl: server.baseUrl,
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Parked",
      ...chatIdentity,
    });
    await repository.updateChatSessionState(chat.id, { sessionId: "ses_1", streamIndex: 0 });
    const routes = await loadProxyRoutes();
    const stream = () =>
      routes.streamSession(
        new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1/stream`, {
          headers: callerHeaders(),
        }),
        { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
      );

    await (await stream()).text();
    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      pendingInput: {
        batches: [
          {
            eventIndex: 1,
            requests: [{ requestId: "req_1", kind: "tool-approval" }],
            answered: [],
          },
        ],
      },
    });

    const responded = await routes.continueSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1`, {
        method: "POST",
        headers: callerHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ inputResponses: [{ requestId: "req_1", optionId: "approve" }] }),
      }),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );
    expect(responded.status).toBe(202);
    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      pendingInput: { batches: [] },
    });

    // A client re-attaching from an older cursor replays the event; the
    // settled batch must not reopen.
    await repository.updateChatSessionState(chat.id, { sessionId: "ses_1", streamIndex: 0 });
    await (await stream()).text();
    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      pendingInput: { batches: [] },
    });
  });

  it("settles every terminal outcome carried by supported Eve input.resolved events", async () => {
    const streamEvents = [
      {
        type: "input.requested",
        data: {
          requests: [
            {
              requestId: "req_question",
              kind: "question",
              prompt: "Continue?",
              action: {
                kind: "tool-call",
                callId: "call_question",
                toolName: "ask_question",
                input: {},
              },
            },
            {
              requestId: "req_approval",
              kind: "tool-approval",
              prompt: "Allow?",
              action: {
                kind: "tool-call",
                callId: "call_approval",
                toolName: "delete_record",
                input: {},
              },
            },
          ],
          sequence: 1,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      {
        type: "input.resolved",
        data: {
          resolutions: [
            {
              kind: "question",
              outcome: "answered",
              requestId: "req_question",
              response: { requestId: "req_question", optionId: "yes" },
            },
            {
              kind: "tool-approval",
              outcome: "denied",
              requestId: "req_approval",
              response: { requestId: "req_approval", optionId: "cancel" },
            },
          ],
          sequence: 2,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      { type: "session.waiting", data: { wait: "next-user-message" } },
    ] as const;
    const server = await fakeServer({ generation: "0.47", streamEvents });
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Resolving Eve",
      baseUrl: server.baseUrl,
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Resolved elsewhere",
      ...chatIdentity,
    });
    await repository.updateChatSessionState(chat.id, {
      sessionId: "ses_1",
      streamIndex: 0,
    });
    const routes = await loadProxyRoutes();

    const response = await routes.streamSession(
      new Request(
        `http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1/stream`,
        { headers: callerHeaders() },
      ),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );
    await response.text();

    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      pendingInput: { batches: [] },
    });
  });

  it("keeps a required batch open across partial answers and dedupes repeats", async () => {
    const server = await fakeServer({ generation: "0.47" });
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Deferred Eve",
      baseUrl: server.baseUrl,
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Two approvals",
      ...chatIdentity,
    });
    await repository.updateChatSessionState(chat.id, { sessionId: "ses_1", streamIndex: 2 });
    await repository.updatePendingInput(chat.id, () => ({
      batches: [
        {
          eventIndex: 1,
          requests: [
            { requestId: "req_a", kind: "tool-approval" },
            { requestId: "req_b", kind: "tool-approval" },
          ],
          answered: [],
        },
      ],
    }));
    const routes = await loadProxyRoutes();
    const respond = (responses: unknown[]) =>
      routes.continueSession(
        new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1`, {
          method: "POST",
          headers: callerHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ inputResponses: responses }),
        }),
        { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
      );

    await respond([{ requestId: "req_a", optionId: "approve" }]);
    await respond([{ requestId: "req_a", optionId: "approve" }]);
    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      pendingInput: {
        batches: [expect.objectContaining({ answered: ["req_a"] })],
      },
    });

    await respond([{ requestId: "req_b", optionId: "cancel" }]);
    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      pendingInput: { batches: [] },
    });
  });

  it("leaves every park open for a message-only turn", async () => {
    const server = await fakeServer({ generation: "0.47" });
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Buffering Eve",
      baseUrl: server.baseUrl,
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Question parked",
      ...chatIdentity,
    });
    await repository.updateChatSessionState(chat.id, { sessionId: "ses_1", streamIndex: 2 });
    const parked = {
      batches: [
        {
          eventIndex: 1,
          requests: [{ requestId: "req_q", kind: "question" }],
          answered: [],
        },
      ],
    };
    await repository.updatePendingInput(chat.id, () => parked);
    const routes = await loadProxyRoutes();

    // Eve dismisses its own question batch on a plain message, but a lone open
    // batch may equally be a subagent-proxied park the message never reaches —
    // the ledger stays conservative-open.
    await routes.continueSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1`, {
        method: "POST",
        headers: callerHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ message: "Just decide yourself" }),
      }),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );

    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      pendingInput: parked,
    });
  });

  it("preserves parks for an unattributed cancel even when Eve accepts it", async () => {
    const repository = createRepository(testDb.db);
    const routes = await loadProxyRoutes();
    const parked = {
      batches: [
        {
          eventIndex: 1,
          requests: [{ requestId: "req_1", kind: "tool-approval" }],
          answered: [],
        },
      ],
    };
    const setUpChat = async (cancelStatus: "accepted" | "no_active_turn") => {
      const server = await fakeServer({ generation: "0.47", cancelStatus });
      const agent = await repository.createAgentConnection({
        name: `Cancel ${cancelStatus}`,
        baseUrl: server.baseUrl,
        authType: "none",
        evelandProjectId: "project_support",
      });
      await repository.updateAgentHealth(agent.id, { status: "healthy" });
      const chat = await repository.createChat({
        agentConnectionId: agent.id,
        title: `Cancel ${cancelStatus}`,
        ...chatIdentity,
      });
      await repository.updateChatSessionState(chat.id, { sessionId: "ses_1", streamIndex: 2 });
      await repository.updatePendingInput(chat.id, () => parked);
      return chat;
    };
    const cancel = (chatId: string) =>
      routes.cancelSession(
        new Request(`http://localhost/api/chats/${chatId}/agent/eve/v1/session/ses_1/cancel`, {
          method: "POST",
          headers: callerHeaders({ "content-type": "application/json" }),
          body: "{}",
        }),
        { params: Promise.resolve({ chatId, sessionId: "ses_1" }) },
      );

    // Between turns, cancel is a no-op on Eve's side; the batch survives there
    // and must survive here, or every later message is silently deferred.
    const parkedChat = await setUpChat("no_active_turn");
    expect((await cancel(parkedChat.id)).status).toBe(200);
    await expect(repository.getChat(parkedChat.id)).resolves.toMatchObject({
      pendingInput: parked,
    });

    // Eve steering can race before its durable turn id is known. An
    // accepted, unattributed cancel must wait for the stream's turn.cancelled
    // event to clear the exact turn instead of hiding every unrelated park.
    const runningChat = await setUpChat("accepted");
    expect((await cancel(runningChat.id)).status).toBe(200);
    await expect(repository.getChat(runningChat.id)).resolves.toMatchObject({
      pendingInput: parked,
    });
  });

  it("clears parks when the session reaches a terminal event", async () => {
    const streamEvents = [
      {
        type: "input.requested",
        data: {
          requests: [
            {
              requestId: "req_1",
              kind: "question",
              prompt: "Anything else?",
              action: { kind: "tool-call", callId: "call_1", toolName: "ask_question", input: {} },
            },
          ],
          sequence: 1,
          stepIndex: 0,
          turnId: "turn_1",
        },
      },
      { type: "session.completed", data: { reason: "done" } },
    ] as const;
    const server = await fakeServer({ generation: "0.47", streamEvents });
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Finishing Eve",
      baseUrl: server.baseUrl,
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Finishing",
      ...chatIdentity,
    });
    await repository.updateChatSessionState(chat.id, { sessionId: "ses_1", streamIndex: 0 });
    const routes = await loadProxyRoutes();

    const response = await routes.streamSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1/stream`, {
        headers: callerHeaders(),
      }),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );
    await response.text();

    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      status: "completed",
      pendingInput: { batches: [] },
    });
  });

  it("clears only the cancelled turn's parks, so a steered turn spares the rest", async () => {
    const repository = createRepository(testDb.db);
    const routes = await loadProxyRoutes();
    const parkThenCancel = (cancelledTurnId: string) =>
      [
        {
          type: "input.requested",
          data: {
            requests: [
              {
                requestId: "req_1",
                kind: "tool-approval",
                prompt: "Delete the record?",
                action: {
                  kind: "tool-call",
                  callId: "call_1",
                  toolName: "delete_record",
                  input: {},
                },
              },
            ],
            sequence: 1,
            stepIndex: 0,
            turnId: "turn_1",
          },
        },
        { type: "turn.cancelled", data: { sequence: 2, turnId: cancelledTurnId } },
      ] as const;

    const drain = async (cancelledTurnId: string): Promise<string> => {
      const server = await fakeServer({
        generation: "0.47",
        streamEvents: parkThenCancel(cancelledTurnId),
      });
      const agent = await repository.createAgentConnection({
        name: `Steering Eve ${cancelledTurnId}`,
        baseUrl: server.baseUrl,
        authType: "none",
        evelandProjectId: "project_support",
      });
      await repository.updateAgentHealth(agent.id, { status: "healthy" });
      const chat = await repository.createChat({
        agentConnectionId: agent.id,
        title: `Steered by ${cancelledTurnId}`,
        ...chatIdentity,
      });
      await repository.updateChatSessionState(chat.id, { sessionId: "ses_1", streamIndex: 0 });
      const response = await routes.streamSession(
        new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1/stream`, {
          headers: callerHeaders(),
        }),
        { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
      );
      // No terminal event ends this stream — a steered session parks and waits
      // — so read exactly the two scripted events and drop the reader, which
      // is what a browser navigating away does.
      await readStreamedEvents(response, 2);
      return chat.id;
    };

    // Eve's steer policy cancels the running turn and replaces it, while every
    // batch an earlier turn parked stays
    // open and answerable. Clearing those would strand the tool call behind
    // controls the browser stopped rendering.
    const steered = await drain("turn_2");
    await expect(repository.getChat(steered)).resolves.toMatchObject({
      pendingInput: {
        batches: [
          expect.objectContaining({
            requests: [{ requestId: "req_1", kind: "tool-approval" }],
            turnId: "turn_1",
          }),
        ],
      },
    });

    // Cancelling the turn that raised the park does tear it down.
    const torndown = await drain("turn_1");
    await expect(repository.getChat(torndown)).resolves.toMatchObject({
      pendingInput: { batches: [] },
    });
  });

  it("scopes an accepted cancel to the turn the caller named", async () => {
    const repository = createRepository(testDb.db);
    const routes = await loadProxyRoutes();
    const parked = {
      batches: [
        {
          eventIndex: 1,
          requests: [{ requestId: "req_1", kind: "tool-approval" }],
          answered: [],
          turnId: "turn_1",
        },
      ],
    };
    const setUpChat = async (title: string) => {
      const server = await fakeServer({ generation: "0.47", cancelStatus: "accepted" });
      const agent = await repository.createAgentConnection({
        name: `Cancel ${title}`,
        baseUrl: server.baseUrl,
        authType: "none",
        evelandProjectId: "project_support",
      });
      await repository.updateAgentHealth(agent.id, { status: "healthy" });
      const chat = await repository.createChat({
        agentConnectionId: agent.id,
        title,
        ...chatIdentity,
      });
      await repository.updateChatSessionState(chat.id, { sessionId: "ses_1", streamIndex: 2 });
      await repository.updatePendingInput(chat.id, () => parked);
      return chat;
    };
    const cancel = (chatId: string, body: unknown) =>
      routes.cancelSession(
        new Request(`http://localhost/api/chats/${chatId}/agent/eve/v1/session/ses_1/cancel`, {
          method: "POST",
          headers: callerHeaders({ "content-type": "application/json" }),
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ chatId, sessionId: "ses_1" }) },
      );

    // Stopping the turn a message is streaming under leaves the approval an
    // earlier turn parked; the browser stops its stream before it cancels, so
    // this request is the only record the ledger gets.
    const other = await setUpChat("Stopped another turn");
    expect((await cancel(other.id, { turnId: "turn_2" })).status).toBe(200);
    await expect(repository.getChat(other.id)).resolves.toMatchObject({
      pendingInput: parked,
    });

    const own = await setUpChat("Stopped the parked turn");
    expect((await cancel(own.id, { turnId: "turn_1" })).status).toBe(200);
    await expect(repository.getChat(own.id)).resolves.toMatchObject({
      pendingInput: { batches: [] },
    });
  });

  it("keeps parks when a turn fails without reaching Eve", async () => {
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Flaky Eve",
      baseUrl: "http://127.0.0.1:1",
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Flaky",
      ...chatIdentity,
    });
    await repository.updateChatSessionState(chat.id, { sessionId: "ses_1", streamIndex: 2 });
    const parked = {
      batches: [
        {
          eventIndex: 1,
          requests: [{ requestId: "req_1", kind: "tool-approval" }],
          answered: [],
        },
      ],
    };
    await repository.updatePendingInput(chat.id, () => parked);
    const routes = await loadProxyRoutes();

    const response = await routes.continueSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1`, {
        method: "POST",
        headers: callerHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ message: "Are you there?" }),
      }),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );

    // A transient failure marks the chat failed, but Eve's session and its
    // park are alive; clearing here would hide answerable controls forever.
    expect(response.ok).toBe(false);
    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      status: "failed",
      pendingInput: parked,
    });
  });

  it("clears stale parks when a new session replaces the old one", async () => {
    const server = await fakeServer({ generation: "0.47" });
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Replaced Eve",
      baseUrl: server.baseUrl,
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Replaced",
      ...chatIdentity,
    });
    await repository.updateChatSessionState(chat.id, { sessionId: "ses_dead", streamIndex: 9 });
    await repository.updateChatStatus(chat.id, "failed");
    await repository.updatePendingInput(chat.id, () => ({
      batches: [
        {
          eventIndex: 1,
          requests: [{ requestId: "req_old", kind: "tool-approval" }],
          answered: [],
        },
      ],
    }));
    const routes = await loadProxyRoutes();

    const response = await routes.createSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session`, {
        method: "POST",
        headers: callerHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ message: "Start over" }),
      }),
      { params: Promise.resolve({ chatId: chat.id }) },
    );

    expect(response.status).toBe(202);
    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      sessionState: { sessionId: "ses_1", streamIndex: 0 },
      pendingInput: { batches: [] },
    });
  });

  it("derives a legacy chat's parks from stored events on first read", async () => {
    const repository = createRepository(testDb.db);
    const server = await fakeServer({ generation: "0.47" });
    const agent = await repository.createAgentConnection({
      name: "Legacy Eve",
      baseUrl: server.baseUrl,
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Legacy",
      ...chatIdentity,
    });
    await repository.updateChatSessionState(chat.id, { sessionId: "ses_1", streamIndex: 2 });
    await repository.appendEvent({
      chatId: chat.id,
      sessionId: "ses_1",
      streamIndex: 0,
      type: "input.requested",
      payload: {
        type: "input.requested",
        data: {
          requests: [
            {
              requestId: "req_1",
              kind: "tool-approval",
              prompt: "Allow?",
              action: { kind: "tool-call", callId: "call_1", toolName: "delete_record", input: {} },
            },
          ],
        },
      },
    });
    await repository.appendEvent({
      chatId: chat.id,
      sessionId: "ses_1",
      streamIndex: 1,
      type: "session.waiting",
      payload: { type: "session.waiting", data: { wait: "next-user-message" } },
    });
    // A chat from before the ledger carries no state at all.
    await testDb.db
      .update(chats)
      .set({ pendingInputJson: null })
      .where(eq(chats.id, chat.id));

    const routeModule = await loadRouteModule(
      "../src/app/api/chats/[chatId]/pending-input/route.ts",
    );
    expect(routeModule, "the pending-input route should exist").not.toBeNull();
    const get = routeModule!.GET as GetRoute<{ chatId: string }>;

    const response = await get(
      new Request(`http://localhost/api/chats/${chat.id}/pending-input`, {
        headers: { authorization: "Bearer app-token" },
      }),
      { params: Promise.resolve({ chatId: chat.id }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      pendingInput: {
        batches: [
          {
            eventIndex: 1,
            requests: [{ requestId: "req_1", kind: "tool-approval" }],
            answered: [],
          },
        ],
      },
    });
    // The derivation is one-shot: the result is written back.
    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      pendingInput: { batches: [expect.objectContaining({ eventIndex: 1 })] },
    });
  });

  it("serves the ledger to a Caller Token client", async () => {
    const server = await fakeServer({ generation: "0.47" });
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Challenged Eve",
      baseUrl: server.baseUrl,
      authType: "none",
      evelandProjectId: "project_support",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Challenged",
      ...chatIdentity,
    });
    await repository.updateChatSessionState(chat.id, { sessionId: "ses_1", streamIndex: 2 });
    const parked = {
      batches: [
        {
          eventIndex: 1,
          requests: [{ requestId: "req_1", kind: "tool-approval" }],
          answered: [],
        },
      ],
    };
    await repository.updatePendingInput(chat.id, () => parked);

    const routeModule = await loadRouteModule(
      "../src/app/api/chats/[chatId]/pending-input/route.ts",
    );
    const get = routeModule!.GET as GetRoute<{ chatId: string }>;

    // After an Eveland challenge the thread holds only a Caller Token; the
    // reconcile reads must work with it or every failure path goes blind.
    const response = await get(
      new Request(`http://localhost/api/chats/${chat.id}/pending-input`, {
        headers: callerHeaders(),
      }),
      { params: Promise.resolve({ chatId: chat.id }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ pendingInput: parked });

    const foreign = await get(
      new Request(`http://localhost/api/chats/${chat.id}/pending-input`, {
        headers: callerHeaders({}, "other-caller-token"),
      }),
      { params: Promise.resolve({ chatId: chat.id }) },
    );
    expect(foreign.status).toBe(404);
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

/**
 * Reads the first `count` NDJSON events off a proxied stream and releases it.
 * A session that parks instead of finishing never closes its stream, so a test
 * that only cares about what the proxy persisted stops reading itself.
 */
async function readStreamedEvents(response: Response, count: number): Promise<unknown[]> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Streamed response carried no body");
  const decoder = new TextDecoder();
  const events: unknown[] = [];
  let buffer = "";
  try {
    while (events.length < count) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1 && events.length < count) {
        events.push(JSON.parse(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
  } finally {
    await reader.cancel();
  }
  return events;
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
