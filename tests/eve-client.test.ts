import { createServer, type Server } from "node:http";
import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import { checkEveAgent, createEveClientForConnection, sendEveTurn } from "@/eve/client";
import { startFakeEveServer, type FakeEveServer } from "@/eve/fake-eve-server.test-helper";

function connection(baseUrl: string, overrides: Partial<Parameters<typeof createEveClientForConnection>[0]> = {}) {
  return {
    id: "agent_test",
    name: "Fake Eve Agent",
    baseUrl,
    authType: "none" as const,
    authConfigEncrypted: null,
    ...overrides,
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

async function startRedirectTargetServer(): Promise<{ baseUrl: string; requests: string[]; close(): Promise<void> }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method ?? "GET"} ${request.url ?? "/"}`);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, status: "ready", workflowId: "redirect-target" }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected TCP server address");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/redirected-health`,
    requests,
    close: () => closeServer(server),
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  server.close();
  await once(server, "close");
}

describe("Eve client connector", () => {
  const servers: FakeEveServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function fakeServer(options?: Parameters<typeof startFakeEveServer>[0]): Promise<FakeEveServer> {
    const server = await startFakeEveServer(options);
    servers.push(server);
    return server;
  }

  it("checks remote Eve health", async () => {
    const server = await fakeServer();

    await expect(checkEveAgent(connection(server.baseUrl))).resolves.toEqual({
      status: "healthy",
      info: expect.objectContaining({ name: "Fake Eve Agent" }),
    });

    expect(server.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /eve/v1/health",
      "GET /eve/v1/info",
    ]);
  });

  it("reports unreachable health for an unreachable agent", async () => {
    const server = await fakeServer();
    const baseUrl = server.baseUrl;
    await server.close();
    servers.pop();

    const result = await checkEveAgent(connection(baseUrl));

    expect(result.status).toBe("unreachable");
    expect(result.error).toEqual(expect.any(String));
  });

  it("streams a first turn and returns updated session state on the terminal update", async () => {
    const server = await fakeServer();

    const updates = await collect(sendEveTurn(connection(server.baseUrl), null, "Hello Eve"));

    expect(updates).toEqual([
      {
        type: "message.appended",
        messageDelta: "Hello",
        message: "Hello",
        raw: expect.objectContaining({ type: "message.appended" }),
      },
      {
        type: "message.completed",
        message: "Hello",
        finishReason: "stop",
        raw: expect.objectContaining({ type: "message.completed" }),
      },
      {
        type: "session.waiting",
        sessionState: { sessionId: "ses_1", continuationToken: "eve:1", streamIndex: 3 },
        raw: expect.objectContaining({ type: "session.waiting" }),
      },
    ]);

    expect(server.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /eve/v1/session",
      "GET /eve/v1/session/ses_1/stream",
    ]);
    expect(server.requests[0].body).toMatchObject({ message: "Hello Eve" });
  });

  it("sends bearer auth to the remote Eve agent on health, info, session, and stream requests", async () => {
    const server = await fakeServer();
    const authedConnection = connection(server.baseUrl, {
      authType: "bearer",
      authConfigEncrypted: JSON.stringify({ bearerToken: "test-token" }),
    });

    await checkEveAgent(authedConnection);
    await collect(sendEveTurn(authedConnection, null, "Hello Eve"));

    expect(server.requests).toHaveLength(4);
    for (const request of server.requests) {
      expect(request.headers.authorization).toBe("Bearer test-token");
    }
  });

  it("does not follow redirects for credential-bearing health checks", async () => {
    const redirectTarget = await startRedirectTargetServer();
    try {
      const server = await fakeServer({ redirectHealthTo: redirectTarget.baseUrl });
      const authedConnection = connection(server.baseUrl, {
        authType: "bearer",
        authConfigEncrypted: JSON.stringify({ bearerToken: "test-token" }),
      });

      const result = await checkEveAgent(authedConnection);

      expect(result.status).toBe("unreachable");
      expect(redirectTarget.requests).toEqual([]);
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0].headers.authorization).toBe("Bearer test-token");
    } finally {
      await redirectTarget.close();
    }
  });

  it("continues a saved session from the prior stream index and preserves continuation tokens", async () => {
    const server = await fakeServer({ omitContinuationTokenOnContinue: true });
    const savedState = { sessionId: "ses_1", continuationToken: "eve:1", streamIndex: 3 };

    const updates = await collect(sendEveTurn(connection(server.baseUrl), savedState, "Follow up"));

    expect(server.requests.map((request) => `${request.method} ${request.path}${request.query}`)).toEqual([
      "POST /eve/v1/session/ses_1",
      "GET /eve/v1/session/ses_1/stream?startIndex=3",
    ]);
    expect(server.requests[0].body).toMatchObject({ message: "Follow up", continuationToken: "eve:1" });
    expect(updates.at(-1)).toMatchObject({
      type: "session.waiting",
      sessionState: { sessionId: "ses_1", continuationToken: "eve:1", streamIndex: 6 },
    });
  });

  it("sends configured custom header auth to remote Eve requests", async () => {
    const server = await fakeServer();

    await collect(
      sendEveTurn(
        connection(server.baseUrl, {
          authType: "header",
          authConfigEncrypted: JSON.stringify({ headerName: "X-Agent-Token", headerValue: "header-secret" }),
        }),
        null,
        "Hello Eve",
      ),
    );

    expect(server.requests).toHaveLength(2);
    for (const request of server.requests) {
      expect(request.headers["x-agent-token"]).toBe("header-secret");
    }
  });
});
