import { createServer, type Server } from "node:http";
import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import { checkEveAgent, createEveClientForConnection } from "@/eve/client";
import {
  startFakeEveServer,
  SUPPORTED_EVE_GENERATIONS,
  type FakeEveServer,
} from "@/eve/fake-eve-server.test-helper";

function connection(
  baseUrl: string,
  overrides: Partial<Parameters<typeof createEveClientForConnection>[0]> = {},
) {
  return {
    id: "agent_test",
    name: "Fake Eve Agent",
    baseUrl,
    authType: "none" as const,
    authConfigEncrypted: null,
    ...overrides,
  };
}

async function startRedirectTargetServer(): Promise<{
  baseUrl: string;
  requests: string[];
  close(): Promise<void>;
}> {
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

  it("checks remote Eve health and inspection info", async () => {
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

  it("supports only the Eve 0.49, 0.50, and 0.51 protocol generations", () => {
    expect(SUPPORTED_EVE_GENERATIONS).toEqual(["0.49", "0.50", "0.51"]);
  });

  it.each([
    { generation: "0.49", streamVersion: "24" },
    { generation: "0.50", streamVersion: "25" },
    { generation: "0.51", streamVersion: "25" },
  ] as const)(
    "models Eve $generation with stream version $streamVersion",
    async ({ generation, streamVersion }) => {
      const server = await fakeServer({ generation });

      const response = await fetch(`${server.baseUrl}/eve/v1/session/ses_1/stream`);

      expect(response.headers.get("x-eve-stream-version")).toBe(streamVersion);
      const events = (await response.text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
      const append = events.find((event) => event.type === "message.appended");
      expect(append?.data).toEqual(
        generation === "0.49"
          ? expect.objectContaining({ messageDelta: "Hello", messageSoFar: "Hello" })
          : expect.objectContaining({ messageDelta: "Hello" }),
      );
      if (generation !== "0.49") {
        expect(append?.data).not.toHaveProperty("messageSoFar");
      }
    },
  );

  it("rejects fake Eve generations outside the supported window", async () => {
    let server: FakeEveServer | undefined;
    let error: unknown;

    try {
      server = await startFakeEveServer({ generation: "0.42" as never });
    } catch (caught) {
      error = caught;
    }

    await server?.close();
    expect(error).toEqual(new Error("Unsupported fake Eve generation: 0.42"));
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

  it("sends bearer auth to health and info requests", async () => {
    const server = await fakeServer();
    const secured = connection(server.baseUrl, {
      authType: "bearer",
      authConfigEncrypted: JSON.stringify({ bearerToken: "test-token" }),
    });

    await checkEveAgent(secured);

    expect(server.requests).toHaveLength(2);
    for (const request of server.requests) {
      expect(request.headers.authorization).toBe("Bearer test-token");
    }
  });

  it("sends configured custom header auth to health and info requests", async () => {
    const server = await fakeServer();

    await checkEveAgent(
      connection(server.baseUrl, {
        authType: "header",
        authConfigEncrypted: JSON.stringify({
          headerName: "X-Agent-Token",
          headerValue: "header-secret",
        }),
      }),
    );

    expect(server.requests).toHaveLength(2);
    for (const request of server.requests) {
      expect(request.headers["x-agent-token"]).toBe("header-secret");
    }
  });

  it("does not follow redirects for credential-bearing health checks", async () => {
    const redirectTarget = await startRedirectTargetServer();
    try {
      const server = await fakeServer({ redirectHealthTo: redirectTarget.baseUrl });
      const secured = connection(server.baseUrl, {
        authType: "bearer",
        authConfigEncrypted: JSON.stringify({ bearerToken: "test-token" }),
      });

      const result = await checkEveAgent(secured);

      expect(result.status).toBe("unreachable");
      expect(redirectTarget.requests).toEqual([]);
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0].headers.authorization).toBe("Bearer test-token");
    } finally {
      await redirectTarget.close();
    }
  });
});
