import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getAgentConnectionEditDefaults } from "@/app/api/agents/api";
import { DELETE, PATCH } from "@/app/api/agents/[agentId]/route";
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

function patchAgent(agentId: string, body: unknown): Promise<Response> {
  return PATCH(
    new Request("http://localhost/api/agents/" + agentId, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ agentId }) },
  );
}

function deleteAgent(agentId: string): Promise<Response> {
  return DELETE(new Request("http://localhost/api/agents/" + agentId, { method: "DELETE" }), {
    params: Promise.resolve({ agentId }),
  });
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

  it("rejects an already-registered normalized agent URL", async () => {
    const server = await fakeServer();

    const firstResponse = await postAgents({
      name: "First Agent",
      baseUrl: server.baseUrl,
      authType: "none",
    });
    expect(firstResponse.status).toBe(201);

    const duplicateResponse = await postAgents({
      name: "Renamed Agent",
      baseUrl: `${server.baseUrl}/?source=gateway#ignored`,
      authType: "none",
    });

    expect(duplicateResponse.status).toBe(409);
    await expect(readJson(duplicateResponse)).resolves.toEqual({ error: "Agent URL already registered" });
    await expect(createRepository(testDb.db).listAgentConnections()).resolves.toHaveLength(1);
    expect(server.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /eve/v1/health",
      "GET /eve/v1/info",
    ]);
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

  it("projects safe edit defaults without exposing a stored header value", async () => {
    const repository = createRepository(testDb.db);
    const secret = "edit-default-secret";
    const agent = await repository.createAgentConnection({
      name: "Header Agent",
      baseUrl: "https://header-defaults.example.com",
      authType: "header",
      authConfigEncrypted: JSON.stringify({
        headerName: "X-Agent-Key",
        headerValue: secret,
      }),
    });

    const defaults = getAgentConnectionEditDefaults(agent);

    expect(defaults).toEqual({
      id: agent.id,
      name: "Header Agent",
      baseUrl: "https://header-defaults.example.com",
      authType: "header",
      hasAuth: true,
      headerName: "X-Agent-Key",
    });
    expect(JSON.stringify(defaults)).not.toContain(secret);
  });

  it("updates an agent, preserves its bearer secret, and checks the new configuration", async () => {
    const server = await fakeServer();
    const secret = "preserved-bearer-secret";
    const created = (await readJson(
      await postAgents({
        name: "Original",
        baseUrl: server.baseUrl,
        authType: "bearer",
        bearerToken: secret,
      }),
    )) as { agent: { id: string } };
    const requestCountBeforeEdit = server.requests.length;

    const response = await patchAgent(created.agent.id, {
      name: "Renamed",
      baseUrl: server.baseUrl + "/",
      authType: "bearer",
      bearerToken: "",
    });
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(body).toEqual({
      agent: expect.objectContaining({
        id: created.agent.id,
        name: "Renamed",
        baseUrl: server.baseUrl,
        authType: "bearer",
        hasAuth: true,
        status: "healthy",
        lastCheckedAt: expect.any(String),
      }),
      info: expect.objectContaining({ name: "Fake Eve Agent" }),
    });
    expectNoSecretLeak(body, secret);
    for (const request of server.requests.slice(requestCountBeforeEdit)) {
      expect(request.headers.authorization).toBe("Bearer " + secret);
    }
  });

  it("preserves a custom header value while allowing its header name to change", async () => {
    const server = await fakeServer();
    const secret = "preserved-header-secret";
    const created = (await readJson(
      await postAgents({
        name: "Header Agent",
        baseUrl: server.baseUrl,
        authType: "header",
        headerName: "X-Old-Key",
        headerValue: secret,
      }),
    )) as { agent: { id: string } };
    const requestCountBeforeEdit = server.requests.length;

    const response = await patchAgent(created.agent.id, {
      name: "Header Agent",
      baseUrl: server.baseUrl,
      authType: "header",
      headerName: "X-New-Key",
      headerValue: "",
    });

    expect(response.status).toBe(200);
    const editedRequests = server.requests.slice(requestCountBeforeEdit);
    expect(editedRequests).toHaveLength(2);
    for (const request of editedRequests) {
      expect(request.headers["x-new-key"]).toBe(secret);
      expect(request.headers["x-old-key"]).toBeUndefined();
    }
  });

  it("accepts an edit whose automatic health check is unreachable", async () => {
    const server = await fakeServer();
    const created = (await readJson(
      await postAgents({ name: "Online", baseUrl: server.baseUrl, authType: "none" }),
    )) as { agent: { id: string } };
    const baseUrl = server.baseUrl;
    await server.close();
    servers.pop();

    const response = await patchAgent(created.agent.id, {
      name: "Offline",
      baseUrl,
      authType: "none",
    });
    const body = (await readJson(response)) as {
      agent: { status: string; lastCheckedAt: string | null };
      error?: string;
    };

    expect(response.status).toBe(200);
    expect(body.agent).toMatchObject({
      status: "unreachable",
      lastCheckedAt: expect.any(String),
    });
    expect(body.error).toEqual(expect.any(String));
    await expect(createRepository(testDb.db).getAgentConnection(created.agent.id)).resolves.toMatchObject({
      name: "Offline",
      status: "unreachable",
    });
  });

  it("requires a new secret when switching authentication type", async () => {
    const server = await fakeServer();
    const created = (await readJson(
      await postAgents({ name: "Public", baseUrl: server.baseUrl, authType: "none" }),
    )) as { agent: { id: string } };
    const requestCountBeforeEdit = server.requests.length;

    const response = await patchAgent(created.agent.id, {
      name: "Private",
      baseUrl: server.baseUrl,
      authType: "bearer",
      bearerToken: "",
    });

    expect(response.status).toBe(400);
    await expect(readJson(response)).resolves.toEqual({ error: "Invalid agent connection" });
    await expect(createRepository(testDb.db).getAgentConnection(created.agent.id)).resolves.toMatchObject({
      name: "Public",
      authType: "none",
    });
    expect(server.requests).toHaveLength(requestCountBeforeEdit);
  });

  it("saves supplied credentials when switching auth and clears them when switching to none", async () => {
    const server = await fakeServer();
    const secret = "new-bearer-secret";
    const created = (await readJson(
      await postAgents({ name: "Public", baseUrl: server.baseUrl, authType: "none" }),
    )) as { agent: { id: string } };
    const requestCountBeforeBearer = server.requests.length;

    const bearerResponse = await patchAgent(created.agent.id, {
      name: "Private",
      baseUrl: server.baseUrl,
      authType: "bearer",
      bearerToken: secret,
    });

    expect(bearerResponse.status).toBe(200);
    for (const request of server.requests.slice(requestCountBeforeBearer)) {
      expect(request.headers.authorization).toBe("Bearer " + secret);
    }

    const noneResponse = await patchAgent(created.agent.id, {
      name: "Public Again",
      baseUrl: server.baseUrl,
      authType: "none",
    });

    expect(noneResponse.status).toBe(200);
    await expect(createRepository(testDb.db).getAgentConnection(created.agent.id)).resolves.toMatchObject({
      name: "Public Again",
      authType: "none",
      authConfigEncrypted: null,
      status: "healthy",
    });
  });

  it("does not edit an agent when its preserved auth config is invalid", async () => {
    const repository = createRepository(testDb.db);
    const created = await repository.createAgentConnection({
      name: "Corrupt Auth",
      baseUrl: "https://corrupt-auth.example.com",
      authType: "bearer",
      authConfigEncrypted: JSON.stringify({}),
    });

    const response = await patchAgent(created.id, {
      name: "Should Not Persist",
      baseUrl: created.baseUrl,
      authType: "bearer",
      bearerToken: "",
    });

    expect(response.status).toBe(500);
    await expect(readJson(response)).resolves.toEqual({ error: "Internal server error" });
    await expect(repository.getAgentConnection(created.id)).resolves.toMatchObject({
      name: "Corrupt Auth",
      authConfigEncrypted: JSON.stringify({}),
    });
  });

  it("returns the creation-compatible conflict when an edit duplicates another URL", async () => {
    const firstServer = await fakeServer();
    const secondServer = await fakeServer();
    const first = (await readJson(
      await postAgents({ name: "First", baseUrl: firstServer.baseUrl, authType: "none" }),
    )) as { agent: { id: string } };
    await postAgents({ name: "Second", baseUrl: secondServer.baseUrl, authType: "none" });
    const secondRequestCount = secondServer.requests.length;

    const response = await patchAgent(first.agent.id, {
      name: "First",
      baseUrl: secondServer.baseUrl + "/?source=edit",
      authType: "none",
    });

    expect(response.status).toBe(409);
    await expect(readJson(response)).resolves.toEqual({ error: "Agent URL already registered" });
    await expect(createRepository(testDb.db).getAgentConnection(first.agent.id)).resolves.toMatchObject({
      baseUrl: firstServer.baseUrl,
    });
    expect(secondServer.requests).toHaveLength(secondRequestCount);
  });

  it("returns 404 for an unknown agent edit", async () => {
    const response = await patchAgent("agent_missing", {
      name: "Missing",
      baseUrl: "https://missing.example.com",
      authType: "none",
    });

    expect(response.status).toBe(404);
    await expect(readJson(response)).resolves.toEqual({ error: "Agent connection not found" });
  });

  it("deletes an agent by id without a confirmation payload", async () => {
    const server = await fakeServer();
    const created = (await readJson(
      await postAgents({ name: "Disposable", baseUrl: server.baseUrl, authType: "none" }),
    )) as { agent: { id: string } };
    const repository = createRepository(testDb.db);
    const chat = await repository.createChat({
      agentConnectionId: created.agent.id,
      title: "Delete through API",
    });
    await repository.appendEvent({
      chatId: chat.id,
      eventIndex: 0,
      type: "message.completed",
      payload: { message: "gone" },
    });

    const response = await deleteAgent(created.agent.id);

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    await expect(repository.getAgentConnection(created.agent.id)).resolves.toBeNull();
    await expect(repository.getChat(chat.id)).resolves.toBeNull();
    await expect(repository.listEvents(chat.id)).resolves.toEqual([]);

    const missingResponse = await deleteAgent(created.agent.id);
    expect(missingResponse.status).toBe(404);
    await expect(readJson(missingResponse)).resolves.toEqual({ error: "Agent connection not found" });
  });
});
