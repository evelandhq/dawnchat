import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  AgentAuthFailure,
  AgentAuthFailureCode,
  AgentAuthModule,
} from "@/agent-auth/contracts";
import {
  resetAgentAuthModuleForTests,
  setAgentAuthModuleForTests,
} from "@/agent-auth/runtime.server";
import { setDbClientForTests } from "@/db/provider";
import { createRepository } from "@/db/repository";
import { createTestDbHandle, type TestDbHandle } from "@/test/db";

type RouteContext<TParams extends Record<string, string>> = {
  params: Promise<TParams>;
};
type PostRoute<TParams extends Record<string, string>> = (
  request: Request,
  context: RouteContext<TParams>,
) => Promise<Response>;
type GetRoute<TParams extends Record<string, string>> = PostRoute<TParams>;

type ProxyRoutes = {
  createSession: PostRoute<{ chatId: string }>;
  continueSession: PostRoute<{ chatId: string; sessionId: string }>;
  streamSession: GetRoute<{ chatId: string; sessionId: string }>;
};

async function loadProxyRoutes(): Promise<ProxyRoutes> {
  const [createModule, continueModule, streamModule] = await Promise.all([
    import("../src/app/api/chats/[chatId]/agent/eve/v1/session/route"),
    import("../src/app/api/chats/[chatId]/agent/eve/v1/session/[sessionId]/route"),
    import("../src/app/api/chats/[chatId]/agent/eve/v1/session/[sessionId]/stream/route"),
  ]);
  return {
    createSession: createModule.POST,
    continueSession: continueModule.POST,
    streamSession: streamModule.GET,
  };
}

const failureStatuses: Record<AgentAuthFailureCode, number> = {
  interaction_required: 401,
  credential_rejected: 401,
  forbidden: 403,
  configuration_invalid: 422,
  provider_unavailable: 503,
  upstream_unavailable: 502,
  retry_required: 409,
};

describe("Eve proxy AgentAuthModule integration", () => {
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
  });

  it("calls AgentAuthModule with exact structured create, continue, and stream requests", async () => {
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Scripted auth",
      baseUrl: "https://scripted-auth.example.com",
      authType: "bearer",
      authConfigEncrypted: "this-must-never-be-read-by-the-proxy",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Scripted turn",
      pendingUserMessage: "hello",
    });
    const sessionId = "session/with spaces";
    const calls: Parameters<AgentAuthModule["request"]>[] = [];
    const responses = [
      Response.json({ sessionId, continuationToken: "trusted-continuation" }),
      Response.json({ sessionId, continuationToken: "next-continuation" }),
      new Response(
        `${JSON.stringify({ type: "session.waiting", data: { wait: "next-user-message" } })}\n`,
        { headers: { "content-type": "application/x-ndjson" } },
      ),
    ];
    setAgentAuthModuleForTests(scriptedModule(calls, () => responses.shift()!));
    const routes = await loadProxyRoutes();

    const createRequest = new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session`, {
      method: "POST",
      body: JSON.stringify({ message: "hello", continuationToken: "caller-token" }),
    });
    const created = await routes.createSession(createRequest, {
      params: Promise.resolve({ chatId: chat.id }),
    });
    expect(created.status).toBe(200);
    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      status: "active",
      pendingUserMessage: null,
      sessionState: {
        sessionId,
        continuationToken: "trusted-continuation",
        streamIndex: 0,
      },
    });

    const continueRequest = new Request(
      `http://localhost/api/chats/${chat.id}/agent/eve/v1/session/${encodeURIComponent(sessionId)}`,
      {
        method: "POST",
        body: JSON.stringify({
          continuationToken: "another-caller-token",
          inputResponses: [{ requestId: "request-1", optionId: "approve" }],
        }),
      },
    );
    const continued = await routes.continueSession(continueRequest, {
      params: Promise.resolve({ chatId: chat.id, sessionId }),
    });
    expect(continued.status).toBe(200);

    const streamRequest = new Request(
      `http://localhost/api/chats/${chat.id}/agent/eve/v1/session/${encodeURIComponent(sessionId)}/stream?startIndex=7`,
    );
    const streamed = await routes.streamSession(streamRequest, {
      params: Promise.resolve({ chatId: chat.id, sessionId }),
    });
    expect(streamed.status).toBe(200);
    await streamed.text();

    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual([
      { agentConnectionId: agent.id, principalId: "" },
      { pathname: "/eve/v1/session" },
      { method: "POST", jsonBody: { message: "hello" }, signal: createRequest.signal },
      { chatId: chat.id },
    ]);
    expect(calls[1]).toEqual([
      { agentConnectionId: agent.id, principalId: "" },
      { pathname: "/eve/v1/session/session%2Fwith%20spaces" },
      {
        method: "POST",
        jsonBody: {
          continuationToken: "trusted-continuation",
          inputResponses: [{ requestId: "request-1", optionId: "approve" }],
        },
        signal: continueRequest.signal,
      },
      { chatId: chat.id },
    ]);
    expect(calls[2]?.[0]).toEqual({ agentConnectionId: agent.id, principalId: "" });
    expect(calls[2]?.[1]).toEqual({
      pathname: "/eve/v1/session/session%2Fwith%20spaces/stream",
      searchParams: { startIndex: "7" },
    });
    expect(calls[2]?.[2]).toMatchObject({ signal: expect.any(AbortSignal) });
    expect(calls[2]?.[3]).toEqual({ chatId: chat.id });
  });

  it.each(Object.entries(failureStatuses) as [AgentAuthFailureCode, number][])(
    "maps %s to HTTP %i without failing the chat or clearing its pending message",
    async (code, status) => {
      const repository = createRepository(testDb.db);
      const agent = await repository.createAgentConnection({
        name: `Failure ${code}`,
        baseUrl: `https://${code.replaceAll("_", "-")}.example.com`,
        authType: "none",
      });
      const chat = await repository.createChat({
        agentConnectionId: agent.id,
        title: "Auth failure",
        pendingUserMessage: "must remain pending",
      });
      const failure: AgentAuthFailure = {
        code,
        method: "scripted-method",
        message: `Safe ${code} message`,
        ...(code === "interaction_required"
          ? {
              interaction: {
                type: "redirect" as const,
                url: `/auth/start?chatId=${chat.id}`,
              },
            }
          : {}),
      };
      setAgentAuthModuleForTests(scriptedModule([], () => failure));
      const routes = await loadProxyRoutes();

      const response = await routes.createSession(
        new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session`, {
          method: "POST",
          body: JSON.stringify({ message: "hello" }),
        }),
        { params: Promise.resolve({ chatId: chat.id }) },
      );

      expect(response.status).toBe(status);
      expect(response.headers.get("content-type")).toContain("application/json");
      await expect(response.json()).resolves.toEqual(failure);
      await expect(repository.getChat(chat.id)).resolves.toMatchObject({
        status: "active",
        pendingUserMessage: "must remain pending",
        sessionState: null,
      });
    },
  );

  it("returns a stream auth failure before exposing an upstream stream body", async () => {
    const { chat, repository } = await createChatWithSession("stream-auth-failure");
    const failure: AgentAuthFailure = {
      code: "credential_rejected",
      method: "bearer",
      message: "The credential was rejected",
    };
    const calls: Parameters<AgentAuthModule["request"]>[] = [];
    setAgentAuthModuleForTests(scriptedModule(calls, () => failure));
    const routes = await loadProxyRoutes();

    const response = await routes.streamSession(
      new Request(
        `http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1/stream?startIndex=3`,
      ),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual(failure);
    expect(calls[0]?.[1]).toEqual({
      pathname: "/eve/v1/session/ses_1/stream",
      searchParams: { startIndex: "3" },
    });
    await expect(repository.listEvents(chat.id)).resolves.toEqual([]);
  });

  it("incrementally parses raw NDJSON and persists each event before forwarding it", async () => {
    const { chat, repository } = await createChatWithSession("raw-ndjson");
    const events = [
      { type: "message.appended", data: { messageDelta: "one" } },
      { type: "session.waiting", data: { wait: "next-user-message" } },
    ];
    let pullCount = 0;
    const firstJson = JSON.stringify(events[0]);
    const chunks = [
      firstJson.slice(0, 20),
      `${firstJson.slice(20)}\n\n${JSON.stringify(events[1])}\n`,
    ];
    let upstreamCanceled = false;
    const upstream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pullCount += 1;
          const chunk = chunks.shift();
          if (chunk === undefined) {
            controller.close();
          } else {
            controller.enqueue(new TextEncoder().encode(chunk));
          }
        },
        cancel() {
          upstreamCanceled = true;
        },
      },
      { highWaterMark: 0 },
    );
    setAgentAuthModuleForTests(
      scriptedModule([], () => new Response(upstream, { status: 200 })),
    );
    const routes = await loadProxyRoutes();

    const response = await routes.streamSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1/stream`),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );
    expect(pullCount).toBe(0);
    const reader = response.body!.getReader();

    const first = await reader.read();
    expect(JSON.parse(new TextDecoder().decode(first.value).trim())).toEqual(events[0]);
    await expect(repository.listEvents(chat.id)).resolves.toEqual([
      expect.objectContaining({ streamIndex: 0, payload: events[0] }),
    ]);

    const second = await reader.read();
    expect(JSON.parse(new TextDecoder().decode(second.value).trim())).toEqual(events[1]);
    await expect(repository.listEvents(chat.id)).resolves.toEqual([
      expect.objectContaining({ streamIndex: 0, payload: events[0] }),
      expect.objectContaining({ streamIndex: 1, payload: events[1] }),
    ]);
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    expect(upstreamCanceled).toBe(true);
  });

  it("forwards nothing and aborts and cancels upstream when stream persistence fails", async () => {
    const { chat, repository } = await createChatWithSession("persistence-failure");
    let upstreamCanceled = false;
    let outboundSignal: AbortSignal | undefined;
    const upstream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `${JSON.stringify({ type: "message.appended", data: {} })}\n`,
            ),
          );
        },
        cancel() {
          upstreamCanceled = true;
        },
      },
      { highWaterMark: 0 },
    );
    setAgentAuthModuleForTests(
      scriptedModule([], (_target, _req, init) => {
        outboundSignal = init?.signal;
        return new Response(upstream, { status: 200 });
      }),
    );
    const routes = await loadProxyRoutes();
    const response = await routes.streamSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1/stream`),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );

    await repository.deleteAgentConnection(chat.agentConnectionId);
    const reader = response.body!.getReader();
    await expect(reader.read()).rejects.toBeTruthy();
    expect(outboundSignal?.aborted).toBe(true);
    expect(upstreamCanceled).toBe(true);
  });

  it("aborts and cancels the raw upstream stream with the browser cancellation reason", async () => {
    const { chat } = await createChatWithSession("browser-cancel");
    let cancelReason: unknown;
    let outboundSignal: AbortSignal | undefined;
    const upstream = new ReadableStream<Uint8Array>(
      {
        pull() {
          // Intentionally held open.
        },
        cancel(reason) {
          cancelReason = reason;
        },
      },
      { highWaterMark: 0 },
    );
    setAgentAuthModuleForTests(
      scriptedModule([], (_target, _req, init) => {
        outboundSignal = init?.signal;
        return new Response(upstream, { status: 200 });
      }),
    );
    const routes = await loadProxyRoutes();
    const response = await routes.streamSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1/stream`),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );
    const reason = new Error("browser disconnected");

    await response.body!.cancel(reason);

    expect(outboundSignal?.aborted).toBe(true);
    expect(outboundSignal?.reason).toBe(reason);
    expect(cancelReason).toBe(reason);
  });

  it("links the incoming request abort signal and preserves its exact reason", async () => {
    const { chat } = await createChatWithSession("request-abort");
    let outboundSignal: AbortSignal | undefined;
    let cancelReason: unknown;
    const upstream = new ReadableStream<Uint8Array>(
      {
        pull() {
          // Intentionally held open.
        },
        cancel(reason) {
          cancelReason = reason;
        },
      },
      { highWaterMark: 0 },
    );
    setAgentAuthModuleForTests(
      scriptedModule([], (_target, _req, init) => {
        outboundSignal = init?.signal;
        return new Response(upstream, { status: 200 });
      }),
    );
    const routes = await loadProxyRoutes();
    const incomingAbort = new AbortController();
    const request = new Request(
      `http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1/stream`,
      { signal: incomingAbort.signal },
    );
    await routes.streamSession(request, {
      params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }),
    });
    const reason = new Error("request disconnected");

    incomingAbort.abort(reason);
    await Promise.resolve();

    expect(outboundSignal?.aborted).toBe(true);
    expect(outboundSignal?.reason).toBe(reason);
    expect(cancelReason).toBe(reason);
  });

  it("rejects stream indexes outside PostgreSQL int32 before calling the agent", async () => {
    const { chat } = await createChatWithSession("stream-index-overflow");
    const calls: Parameters<AgentAuthModule["request"]>[] = [];
    setAgentAuthModuleForTests(
      scriptedModule(calls, () => {
        throw new Error("Agent must not be called for an invalid stream index");
      }),
    );
    const routes = await loadProxyRoutes();

    const response = await routes.streamSession(
      new Request(
        `http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1/stream?startIndex=2147483648`,
      ),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );

    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("bounds a single NDJSON record and cancels upstream before persistence", async () => {
    const { chat, repository } = await createChatWithSession("oversized-record");
    let upstreamCanceled = false;
    let outboundSignal: AbortSignal | undefined;
    const oversized = JSON.stringify({
      type: "message.appended",
      data: { messageDelta: "x".repeat(1024 * 1024) },
    });
    const upstream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`${oversized}\n`));
        },
        cancel() {
          upstreamCanceled = true;
        },
      },
      { highWaterMark: 0 },
    );
    setAgentAuthModuleForTests(
      scriptedModule([], (_target, _req, init) => {
        outboundSignal = init?.signal;
        return new Response(upstream, { status: 200 });
      }),
    );
    const routes = await loadProxyRoutes();
    const response = await routes.streamSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1/stream`),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );

    await expect(response.body!.getReader().read()).rejects.toBeTruthy();
    expect(outboundSignal?.aborted).toBe(true);
    expect(upstreamCanceled).toBe(true);
    await expect(repository.listEvents(chat.id)).resolves.toEqual([]);
  });

  it("does not parse an aborted partial NDJSON record as natural EOF", async () => {
    const { chat } = await createChatWithSession("partial-abort");
    let emittedPartial = false;
    const upstream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (!emittedPartial) {
            emittedPartial = true;
            controller.enqueue(new TextEncoder().encode('{"type":"message.appended"'));
          }
        },
      },
      { highWaterMark: 0 },
    );
    setAgentAuthModuleForTests(
      scriptedModule([], () => new Response(upstream, { status: 200 })),
    );
    const routes = await loadProxyRoutes();
    const incomingAbort = new AbortController();
    const response = await routes.streamSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1/stream`, {
        signal: incomingAbort.signal,
      }),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );
    const reader = response.body!.getReader();
    const pendingRead = reader.read();
    await Promise.resolve();
    const reason = new Error("partial stream canceled");

    incomingAbort.abort(reason);

    await expect(pendingRead).rejects.toBe(reason);
  });

  it("keeps a non-OK stream body cancelable by the incoming request", async () => {
    const { chat } = await createChatWithSession("error-body-cancel");
    let upstreamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let cancelReason: unknown;
    const upstream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          upstreamController = controller;
        },
        pull() {
          // Held open until the incoming request aborts.
        },
        cancel(reason) {
          cancelReason = reason;
        },
      },
      { highWaterMark: 0 },
    );
    setAgentAuthModuleForTests(
      scriptedModule([], () => new Response(upstream, { status: 500 })),
    );
    const routes = await loadProxyRoutes();
    const incomingAbort = new AbortController();
    const routePromise = routes.streamSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1/stream`, {
        signal: incomingAbort.signal,
      }),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );
    const observed = routePromise.then(
      () => "resolved" as const,
      (error: unknown) => error,
    );
    const reason = new Error("cancel error response");

    incomingAbort.abort(reason);
    const outcome = await Promise.race([
      observed,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);
    if (outcome === "timeout") {
      upstreamController?.error(new Error("test cleanup"));
      await observed;
    }

    expect(outcome).toBe(reason);
    expect(cancelReason).toBe(reason);
  });

  it("bounds non-OK upstream bodies and cancels them", async () => {
    const { chat } = await createChatWithSession("oversized-error-body");
    let canceled = false;
    let outboundSignal: AbortSignal | undefined;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(70 * 1024)));
      },
      cancel() {
        canceled = true;
      },
    });
    setAgentAuthModuleForTests(
      scriptedModule([], (_target, _req, init) => {
        outboundSignal = init?.signal;
        return new Response(upstream, { status: 500 });
      }),
    );
    const routes = await loadProxyRoutes();

    const response = await routes.streamSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1/stream`),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );

    expect(response.status).toBe(502);
    expect(canceled).toBe(true);
    expect(outboundSignal?.aborted).toBe(true);
  });

  it.each([302, 304])("normalizes an unexpected upstream %i redirect", async (status) => {
    const { chat } = await createChatWithSession(`redirect-${status}`);
    setAgentAuthModuleForTests(
      scriptedModule(
        [],
        () =>
          new Response(null, {
            status,
            headers: status === 302 ? { location: "https://evil.example/redirect" } : undefined,
          }),
      ),
    );
    const routes = await loadProxyRoutes();

    const response = await routes.streamSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1/stream`),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );

    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
  });

  it("preserves Retry-After on a bounded non-OK response", async () => {
    const { chat } = await createChatWithSession("retry-after");
    setAgentAuthModuleForTests(
      scriptedModule(
        [],
        () => new Response("slow down", { status: 429, headers: { "retry-after": "17" } }),
      ),
    );
    const routes = await loadProxyRoutes();

    const response = await routes.streamSession(
      new Request(`http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1/stream`),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
  });

  it("does not regress chat state on old exact replay and advances only at the cursor", async () => {
    const { chat, repository } = await createChatWithSession("monotonic-replay");
    const events = [
      { type: "session.waiting", data: { wait: "old-boundary" } },
      { type: "message.appended", data: { messageDelta: "stored-after-boundary" } },
      { type: "session.completed", data: {} },
    ];
    await repository.appendEvent({
      chatId: chat.id,
      sessionId: "ses_1",
      streamIndex: 0,
      type: events[0].type,
      payload: events[0],
    });
    await repository.appendEvent({
      chatId: chat.id,
      sessionId: "ses_1",
      streamIndex: 1,
      type: events[1].type,
      payload: events[1],
    });
    await repository.updateChatSessionState(
      chat.id,
      { sessionId: "ses_1", continuationToken: "must-survive", streamIndex: 2 },
      "completed",
    );
    const upstream = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    setAgentAuthModuleForTests(
      scriptedModule([], () => new Response(upstream, { status: 200 })),
    );
    const routes = await loadProxyRoutes();

    const response = await routes.streamSession(
      new Request(
        `http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1/stream?startIndex=0`,
      ),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );
    const forwarded = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));

    expect(forwarded).toEqual(events);
    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      status: "completed",
      sessionState: {
        sessionId: "ses_1",
        continuationToken: "must-survive",
        streamIndex: 3,
      },
    });
  });

  it("closes a held-open stream after replaying the latest persisted terminal boundary", async () => {
    const { chat, repository } = await createChatWithSession("latest-terminal-replay");
    const waiting = { type: "session.waiting", data: { wait: "next-user-message" } };
    await repository.appendEvent({
      chatId: chat.id,
      sessionId: "ses_1",
      streamIndex: 0,
      type: waiting.type,
      payload: waiting,
    });
    await repository.updateChatSessionState(
      chat.id,
      { sessionId: "ses_1", continuationToken: "must-survive", streamIndex: 1 },
      "active",
    );

    let upstreamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let upstreamCanceled = false;
    const upstream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          upstreamController = controller;
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify(waiting)}\n`));
        },
        cancel() {
          upstreamCanceled = true;
        },
      },
      { highWaterMark: 0 },
    );
    setAgentAuthModuleForTests(
      scriptedModule([], () => new Response(upstream, { status: 200 })),
    );
    const routes = await loadProxyRoutes();
    const response = await routes.streamSession(
      new Request(
        `http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1/stream?startIndex=0`,
      ),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );
    const reader = response.body!.getReader();

    const first = await reader.read();
    const secondRead = reader.read();
    const second = await Promise.race([
      secondRead,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ]);
    if (second === "timeout") {
      upstreamController?.close();
      await secondRead;
    }

    expect(new TextDecoder().decode(first.value).trim()).toBe(JSON.stringify(waiting));
    expect(second).toEqual({ done: true, value: undefined });
    expect(upstreamCanceled).toBe(true);
    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      status: "active",
      sessionState: {
        sessionId: "ses_1",
        continuationToken: "must-survive",
        streamIndex: 1,
      },
    });
  });

  it("rejects a replay payload that conflicts with the persisted event", async () => {
    const { chat, repository } = await createChatWithSession("conflicting-replay");
    const stored = { type: "message.appended", data: { messageDelta: "stored" } };
    const conflicting = { type: "message.appended", data: { messageDelta: "different" } };
    await repository.appendEvent({
      chatId: chat.id,
      sessionId: "ses_1",
      streamIndex: 0,
      type: stored.type,
      payload: stored,
    });
    await repository.updateChatSessionState(
      chat.id,
      { sessionId: "ses_1", continuationToken: "eve:1", streamIndex: 1 },
      "active",
    );
    setAgentAuthModuleForTests(
      scriptedModule([], () => new Response(`${JSON.stringify(conflicting)}\n`, { status: 200 })),
    );
    const routes = await loadProxyRoutes();
    const response = await routes.streamSession(
      new Request(
        `http://localhost/api/chats/${chat.id}/agent/eve/v1/session/ses_1/stream?startIndex=0`,
      ),
      { params: Promise.resolve({ chatId: chat.id, sessionId: "ses_1" }) },
    );

    await expect(response.body!.getReader().read()).rejects.toBeTruthy();
    await expect(repository.listEvents(chat.id)).resolves.toEqual([
      expect.objectContaining({ streamIndex: 0, payload: stored }),
    ]);
  });

  async function createChatWithSession(suffix: string) {
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: suffix,
      baseUrl: `https://${suffix}.example.com`,
      authType: "none",
    });
    const created = await repository.createChat({
      agentConnectionId: agent.id,
      title: suffix,
    });
    await repository.updateChatSessionState(created.id, {
      sessionId: "ses_1",
      continuationToken: "eve:1",
      streamIndex: 0,
    });
    return { chat: (await repository.getChat(created.id))!, repository };
  }
});

function scriptedModule(
  calls: Parameters<AgentAuthModule["request"]>[],
  response: (
    ...args: Parameters<AgentAuthModule["request"]>
  ) => Response | AgentAuthFailure | Promise<Response | AgentAuthFailure>,
): AgentAuthModule {
  return {
    async request(...args) {
      calls.push(args);
      return response(...args);
    },
    async status() {
      return { state: "not_required" };
    },
  };
}
