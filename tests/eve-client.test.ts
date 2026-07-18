import { createServer, type Server } from "node:http";
import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import { checkEveAgent, createEveClientForConnection } from "@/eve/client";
import { startFakeEveServer, type FakeEveServer } from "@/eve/fake-eve-server.test-helper";

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
    securityRevision: 1,
    status: "unknown" as const,
    lastCheckedAt: null,
    createdAt: new Date("2026-07-19T00:00:00.000Z"),
    updatedAt: new Date("2026-07-19T00:00:00.000Z"),
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

  it("reports unreachable health for an unreachable agent", async () => {
    const server = await fakeServer();
    const baseUrl = server.baseUrl;
    await server.close();
    servers.pop();

    const result = await checkEveAgent(connection(baseUrl));

    expect(result.status).toBe("unreachable");
    expect(result.error).toEqual(expect.any(String));
  });

  it("does not report healthy when the protected info route rejects the credential", async () => {
    const server = await fakeServer({ infoStatus: 401 });

    const result = await checkEveAgent(connection(server.baseUrl, {
      authType: "bearer",
      authConfigEncrypted: JSON.stringify({ token: "rejected-token" }),
    }));

    expect(result).toMatchObject({ status: "unreachable" });
    expect(result.error).toContain("Agent info unavailable");
  });

  it("keeps compatibility with Eve deployments that do not expose the info route", async () => {
    const server = await fakeServer({ infoStatus: 404 });

    await expect(checkEveAgent(connection(server.baseUrl))).resolves.toMatchObject({
      status: "healthy",
      info: { ok: true, status: "ready" },
    });
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

  it("trims Bearer credentials before sending them", async () => {
    const server = await fakeServer();

    await checkEveAgent(connection(server.baseUrl, {
      authType: "bearer",
      authConfigEncrypted: JSON.stringify({ token: "  test-token  " }),
    }));

    expect(server.requests[0].headers.authorization).toBe("Bearer test-token");
  });

  it("sends HTTP Basic auth to health and info requests", async () => {
    const server = await fakeServer();

    await checkEveAgent(
      connection(server.baseUrl, {
        authType: "basic",
        authConfigEncrypted: JSON.stringify({ username: "alice", password: "basic-secret" }),
      }),
    );

    for (const request of server.requests) {
      expect(request.headers.authorization).toBe(`Basic ${Buffer.from("alice:basic-secret").toString("base64")}`);
    }
  });

  it("sends both standard Vercel OIDC headers to health and info requests", async () => {
    const server = await fakeServer();

    await checkEveAgent(
      connection(server.baseUrl, {
        authType: "vercel-oidc",
        authConfigEncrypted: JSON.stringify({ token: "vercel-token" }),
      }),
    );

    for (const request of server.requests) {
      expect(request.headers.authorization).toBe("Bearer vercel-token");
      expect(request.headers["x-vercel-trusted-oidc-idp-token"]).toBe("vercel-token");
    }
  });

  it("sends configured custom header auth to health and info requests", async () => {
    const server = await fakeServer();

    await checkEveAgent(
      connection(server.baseUrl, {
        authType: "headers",
        authConfigEncrypted: JSON.stringify({
          headers: {
            "X-Agent-Token": "header-secret",
            "X-Workspace": "workspace-secret",
          },
        }),
      }),
    );

    expect(server.requests).toHaveLength(2);
    for (const request of server.requests) {
      expect(request.headers["x-agent-token"]).toBe("header-secret");
      expect(request.headers["x-workspace"]).toBe("workspace-secret");
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
