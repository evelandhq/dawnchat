import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET, POST } from "@/app/api/agents/route";
import { POST as CHECK } from "@/app/api/agents/[agentId]/check/route";
import { POST as DISCOVER } from "@/app/api/agents/discover/route";
import { setDbClientForTests } from "@/db/provider";
import { createRepository } from "@/db/repository";
import { createTestDbHandle, type TestDbHandle } from "@/test/db";
import { startFakeEveServer, type FakeEveServer } from "@/eve/fake-eve-server.test-helper";

async function readJson(response: Response): Promise<unknown> {
  return response.json();
}

function postAgents(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function checkAgent(agentId: string): Promise<Response> {
  return CHECK(new Request(`http://localhost/api/agents/${agentId}/check`, { method: "POST" }), {
    params: Promise.resolve({ agentId }),
  });
}

function discoverAgents(body: unknown): Promise<Response> {
  return DISCOVER(
    new Request("http://localhost/api/agents/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

type FakeGateway = {
  baseUrl: string;
  requests: string[];
  close: () => Promise<void>;
};

async function startFakeGateway(payload: string, status = 200): Promise<FakeGateway> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(payload);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function expectNoSecretLeak(payload: unknown, secret: string): void {
  expect(JSON.stringify(payload)).not.toContain(secret);
}

describe("Agent Connection API", () => {
  const servers: FakeEveServer[] = [];
  const gateways: FakeGateway[] = [];
  let testDb: TestDbHandle;

  beforeEach(async () => {
    testDb = await createTestDbHandle();
    setDbClientForTests(testDb.db);
  });

  afterEach(async () => {
    setDbClientForTests(null);
    await testDb.close();
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
  });

  async function fakeServer(): Promise<FakeEveServer> {
    const server = await startFakeEveServer();
    servers.push(server);
    return server;
  }

  it("creates an agent connection without returning bearer token", async () => {
    const server = await fakeServer();
    const secret = "super-secret-bearer-token";

    const response = await postAgents({
      name: "Support Agent",
      baseUrl: `${server.baseUrl}/`,
      authType: "bearer",
      bearerToken: secret,
    });
    const body = await readJson(response);

    expect(response.status).toBe(201);
    expect(body).toEqual({
      agent: {
        id: expect.stringMatching(/^agent_[a-f0-9]{16}$/),
        name: "Support Agent",
        baseUrl: server.baseUrl,
        authType: "bearer",
        hasAuth: true,
        status: "healthy",
        lastCheckedAt: expect.any(String),
      },
      info: expect.objectContaining({ name: "Fake Eve Agent" }),
    });
    expectNoSecretLeak(body, secret);
    const storedAgent = (await createRepository(testDb.db).listAgentConnections())[0];
    expect(storedAgent.authConfigEncrypted).toEqual(expect.stringMatching(/^eve-auth:v1:/));
    expect(storedAgent.authConfigEncrypted).not.toContain(secret);
    expect(server.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /eve/v1/health",
      "GET /eve/v1/info",
    ]);
    expect(server.requests[0].headers.authorization).toBe(`Bearer ${secret}`);
  });

  it("lists created agent connections with redacted auth", async () => {
    const firstServer = await fakeServer();
    const secondServer = await fakeServer();
    const headerSecret = "header-secret-value";

    const first = (await readJson(
      await postAgents({ name: "First Agent", baseUrl: firstServer.baseUrl, authType: "none" }),
    )) as { agent: { id: string } };
    const second = (await readJson(
      await postAgents({
        name: "Second Agent",
        baseUrl: secondServer.baseUrl,
        authType: "header",
        headerName: "X-Agent-Token",
        headerValue: headerSecret,
      }),
    )) as { agent: { id: string } };

    const response = await GET();
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(body).toEqual({
      agents: [
        {
          id: first.agent.id,
          name: "First Agent",
          baseUrl: firstServer.baseUrl,
          authType: "none",
          hasAuth: false,
          status: "healthy",
          lastCheckedAt: expect.any(String),
        },
        {
          id: second.agent.id,
          name: "Second Agent",
          baseUrl: secondServer.baseUrl,
          authType: "header",
          hasAuth: true,
          status: "healthy",
          lastCheckedAt: expect.any(String),
        },
      ],
    });
    expectNoSecretLeak(body, headerSecret);
    const storedSecondAgent = await createRepository(testDb.db).getAgentConnection(second.agent.id);
    expect(storedSecondAgent?.authConfigEncrypted).toEqual(expect.stringMatching(/^eve-auth:v1:/));
    expect(storedSecondAgent?.authConfigEncrypted).not.toContain(headerSecret);
  });

  it("rejects invalid header auth names without treating them as remote health failures", async () => {
    const secret = "invalid-header-secret";

    const response = await postAgents({
      name: "Invalid Header Agent",
      baseUrl: "https://example.com",
      authType: "header",
      headerName: "Bad Header",
      headerValue: secret,
    });
    const body = await readJson(response);

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ error: "Invalid agent connection" });
    expectNoSecretLeak(body, secret);
  });

  it("checks agent health and persists healthy status", async () => {
    const server = await fakeServer();
    const created = (await readJson(
      await postAgents({ name: "Checkable Agent", baseUrl: server.baseUrl, authType: "none" }),
    )) as { agent: { id: string } };

    const response = await checkAgent(created.agent.id);
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(body).toEqual({
      agent: {
        id: created.agent.id,
        name: "Checkable Agent",
        baseUrl: server.baseUrl,
        authType: "none",
        hasAuth: false,
        status: "healthy",
        lastCheckedAt: expect.any(String),
      },
      info: expect.objectContaining({ name: "Fake Eve Agent" }),
    });

    const listed = (await readJson(await GET())) as { agents: Array<{ id: string; status: string; lastCheckedAt: string | null }> };
    expect(listed.agents).toHaveLength(1);
    expect(listed.agents[0]).toMatchObject({ id: created.agent.id, status: "healthy" });
    expect(listed.agents[0].lastCheckedAt).toEqual(expect.any(String));
  });

  it("returns validation errors without leaking submitted secrets", async () => {
    const secret = "do-not-echo-this-token";

    const response = await postAgents({
      name: "Invalid Agent",
      baseUrl: "not a url",
      authType: "bearer",
      bearerToken: secret,
    });
    const body = await readJson(response);

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ error: "Invalid agent connection" });
    expectNoSecretLeak(body, secret);
  });

  it("discovers agents from a gateway directory and marks already-connected ones", async () => {
    const server = await fakeServer();
    await postAgents({ name: "Existing Agent", baseUrl: server.baseUrl, authType: "none" });

    const gateway = await startFakeGateway(
      JSON.stringify({
        agents: [
          { id: "aaa", name: "Existing Agent", url: `${server.baseUrl}/` },
          { id: "bbb", name: "Fresh Agent", url: "http://127.0.0.1:19999" },
          { name: "", url: "http://127.0.0.1:19998" },
          { name: "Broken Agent", url: "not a url" },
        ],
      }),
    );
    gateways.push(gateway);

    const response = await discoverAgents({ gatewayUrl: `${gateway.baseUrl}/` });
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(body).toEqual({
      agents: [
        { name: "Existing Agent", url: server.baseUrl, connected: true },
        { name: "Fresh Agent", url: "http://127.0.0.1:19999", connected: false },
      ],
    });
    expect(gateway.requests).toEqual(["GET /.well-known/eve/agents.json"]);
  });

  it("returns 502 when the gateway is unreachable", async () => {
    const gateway = await startFakeGateway("{}");
    const gatewayUrl = gateway.baseUrl;
    await gateway.close();

    const response = await discoverAgents({ gatewayUrl });

    expect(response.status).toBe(502);
    await expect(readJson(response)).resolves.toEqual({ error: "Gateway unreachable" });
  });

  it("returns 502 for a gateway response that is not a directory", async () => {
    const gateway = await startFakeGateway(JSON.stringify({ hello: "world" }));
    gateways.push(gateway);

    const response = await discoverAgents({ gatewayUrl: gateway.baseUrl });

    expect(response.status).toBe(502);
    await expect(readJson(response)).resolves.toEqual({ error: "Invalid gateway response" });
  });

  it("rejects invalid gateway URLs before fetching", async () => {
    const response = await discoverAgents({ gatewayUrl: "not a url" });

    expect(response.status).toBe(400);
    await expect(readJson(response)).resolves.toEqual({ error: "Invalid discovery request" });
  });

  it("persists unreachable status when a health check fails", async () => {
    const server = await fakeServer();
    const baseUrl = server.baseUrl;
    await server.close();
    servers.pop();

    const response = await postAgents({ name: "Down Agent", baseUrl, authType: "none" });
    const body = (await readJson(response)) as { agent: { id: string; status: string; lastCheckedAt: string | null }; error?: string };

    expect(response.status).toBe(201);
    expect(body.agent).toMatchObject({ status: "unreachable", lastCheckedAt: expect.any(String) });
    expect(body.error).toEqual(expect.any(String));

    const listed = (await readJson(await GET())) as { agents: Array<{ id: string; status: string }> };
    expect(listed.agents).toEqual([expect.objectContaining({ id: body.agent.id, status: "unreachable" })]);
  });
});
