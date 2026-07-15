import { once } from "node:events";
import { createServer, type Server } from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentAuthModule } from "@/agent-auth/contracts";
import {
  resetAgentAuthModuleForTests,
  setAgentAuthModuleForTests,
} from "@/agent-auth/runtime.server";
import { setDbClientForTests } from "@/db/provider";
import { createRepository, type AgentConnection } from "@/db/repository";
import { checkEveAgent } from "@/eve/client";
import { startFakeEveServer, type FakeEveServer } from "@/eve/fake-eve-server.test-helper";
import { createTestDbHandle, type TestDbHandle } from "@/test/db";

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

  async function connection(
    baseUrl: string,
    overrides: Partial<Pick<AgentConnection, "authType" | "authConfigEncrypted">> = {},
  ): Promise<AgentConnection> {
    return createRepository(testDb.db).createAgentConnection({
      name: "Fake Eve Agent",
      baseUrl,
      authType: overrides.authType ?? "none",
      authConfigEncrypted: overrides.authConfigEncrypted ?? null,
    });
  }

  it("checks remote Eve health and inspection info", async () => {
    const server = await fakeServer();

    await expect(checkEveAgent(await connection(server.baseUrl))).resolves.toEqual({
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

    const result = await checkEveAgent(await connection(baseUrl));

    expect(result.status).toBe("unreachable");
    expect(result.error).toEqual(expect.any(String));
  });

  it("does not expose malformed upstream health body contents", async () => {
    const secretDiagnostic = "not-json-secret-health-diagnostic";
    const server = await fakeServer({ rawHealthBody: secretDiagnostic });

    const result = await checkEveAgent(await connection(server.baseUrl));

    expect(result).toEqual({ status: "unreachable", error: "Eve health check failed" });
    expect(JSON.stringify(result)).not.toContain(secretDiagnostic);
  });

  it("rejects metadata and private health targets through the shared transport policy", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ status: "ok" }));
    try {
      const result = await checkEveAgent(
        await connection("https://169.254.169.254/latest/meta-data"),
      );

      expect(result.status).toBe("unreachable");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("keeps health anonymous and sends bearer auth only to protected info", async () => {
    const server = await fakeServer();
    const secured = await connection(server.baseUrl, {
      authType: "bearer",
      authConfigEncrypted: JSON.stringify({ bearerToken: "test-token" }),
    });

    await checkEveAgent(secured);

    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]).toMatchObject({ path: "/eve/v1/health" });
    expect(server.requests[0].headers.authorization).toBeUndefined();
    expect(server.requests[1]).toMatchObject({ path: "/eve/v1/info" });
    expect(server.requests[1].headers.authorization).toBe("Bearer test-token");
  });

  it("keeps health anonymous and sends configured custom auth only to protected info", async () => {
    const server = await fakeServer();

    await checkEveAgent(
      await connection(server.baseUrl, {
        authType: "header",
        authConfigEncrypted: JSON.stringify({
          headerName: "X-Agent-Token",
          headerValue: "header-secret",
        }),
      }),
    );

    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]).toMatchObject({ path: "/eve/v1/health" });
    expect(server.requests[0].headers["x-agent-token"]).toBeUndefined();
    expect(server.requests[1]).toMatchObject({ path: "/eve/v1/info" });
    expect(server.requests[1].headers["x-agent-token"]).toBe("header-secret");
  });

  it("does not follow health redirects and never sends credentials to health or its redirect", async () => {
    const redirectTarget = await startRedirectTargetServer();
    try {
      const server = await fakeServer({ redirectHealthTo: redirectTarget.baseUrl });
      const secured = await connection(server.baseUrl, {
        authType: "bearer",
        authConfigEncrypted: JSON.stringify({ bearerToken: "test-token" }),
      });

      const result = await checkEveAgent(secured);

      expect(result.status).toBe("unreachable");
      expect(redirectTarget.requests).toEqual([]);
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0].headers.authorization).toBeUndefined();
    } finally {
      await redirectTarget.close();
    }
  });

  it("uses AgentAuthModule for info and preserves auth failure while liveness stays healthy", async () => {
    const server = await fakeServer();
    const secured = await connection(server.baseUrl, {
      authType: "bearer",
      authConfigEncrypted: JSON.stringify({ bearerToken: "must-not-be-read" }),
    });
    const calls: Parameters<AgentAuthModule["request"]>[] = [];
    const authFailure = {
      code: "interaction_required" as const,
      method: "oidc-authorization-code",
      message: "Sign in is required",
    };
    setAgentAuthModuleForTests({
      async request(...args) {
        calls.push(args);
        return authFailure;
      },
      async status() {
        return { state: "interaction_required" };
      },
    });

    await expect(checkEveAgent(secured)).resolves.toEqual({
      status: "healthy",
      authFailure,
    });
    expect(calls).toEqual([
      [
        { agentConnectionId: secured.id, principalId: "" },
        { pathname: "/eve/v1/info" },
      ],
    ]);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({ method: "GET", path: "/eve/v1/health" });
    expect(server.requests[0].headers.authorization).toBeUndefined();
  });
});
