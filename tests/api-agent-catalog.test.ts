import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/agents/catalog/route";
import { setDbClientForTests } from "@/db/provider";
import { createRepository } from "@/db/repository";
import {
  CallerTokenError,
  setCallerTokenVerifierForTests,
  type CallerTokenVerifier,
} from "@/identity/server";
import { createTestDbHandle, type TestDbHandle } from "@/test/db";

describe("Catalog Agent connection API", () => {
  let testDb: TestDbHandle;

  beforeEach(async () => {
    testDb = await createTestDbHandle();
    setDbClientForTests(testDb.db);
    setCallerTokenVerifierForTests(testVerifier);
    process.env.EVELAND_PUBLIC_ORIGIN = "https://frontdoor.example.com";
    process.env.EVELAND_IDENTITY_ISSUER = "https://identity.example.com";
    delete process.env.EVELAND_INTERNAL_ORIGIN;
  });

  afterEach(async () => {
    delete process.env.EVELAND_PUBLIC_ORIGIN;
    delete process.env.EVELAND_IDENTITY_ISSUER;
    delete process.env.EVELAND_INTERNAL_ORIGIN;
    vi.unstubAllGlobals();
    setDbClientForTests(null);
    setCallerTokenVerifierForTests(null);
    await testDb.close();
  });

  it("lazily upserts a managed connection from Eveland's authoritative Catalog", async () => {
    const fetchCatalog = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          agents: [
            {
              projectId: "project_support",
              name: "Support",
              description: "Answers support questions.",
              url: "https://support-v1.agents.example.com",
              capabilities: { eveChat: true },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          agents: [
            {
              projectId: "project_support",
              name: "Support Agent",
              description: "Updated.",
              url: "https://support-v2.agents.example.com",
              capabilities: { eveChat: true },
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchCatalog);
    const first = await connect({
      issuer: "https://identity.example.com",
      projectId: "project_support",
      name: "Support",
      description: "Answers support questions.",
      url: "https://support-v1.agents.example.com",
      capabilities: { eveChat: true },
    });

    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { agent: { id: string } };

    const second = await connect({
      issuer: "https://identity.example.com",
      projectId: "project_support",
      name: "Browser supplied name is ignored",
      description: null,
      url: "https://attacker.example.com",
      capabilities: { eveChat: true },
    });

    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      agent: {
        id: firstBody.agent.id,
        name: "Support Agent",
        baseUrl: "https://support-v2.agents.example.com",
        source: "managed",
        evelandProjectId: "project_support",
      },
    });
    await expect(createRepository(testDb.db).listAgentConnections()).resolves.toEqual([
      expect.objectContaining({
        id: firstBody.agent.id,
        identityIssuer: "https://identity.example.com",
        evelandProjectId: "project_support",
        status: "healthy",
      }),
    ]);
    expect(fetchCatalog).toHaveBeenCalledTimes(2);
    expect(fetchCatalog).toHaveBeenCalledWith(
      "https://frontdoor.example.com/api/agent-catalog",
      expect.objectContaining({
        headers: { accept: "application/json" },
        redirect: "error",
      }),
    );
    expect(
      fetchCatalog.mock.calls[0]?.[1]?.headers,
    ).not.toHaveProperty("authorization");
  });

  it("opens an Agent from the configured public Catalog without an App Token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          agents: [
            {
              projectId: "project_support",
              name: "Support",
              description: "Answers support questions.",
              url: "https://support.agents.example.com",
              capabilities: { eveChat: true },
            },
          ],
        }),
      ),
    );

    const response = await POST(
      new Request("http://localhost/api/agents/catalog", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          issuer: "https://identity.example.com",
          projectId: "project_support",
        }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      agent: {
        name: "Support",
        evelandProjectId: "project_support",
      },
    });
  });

  it("reads the Catalog over EVELAND_INTERNAL_ORIGIN while still requiring the stable issuer", async () => {
    process.env.EVELAND_INTERNAL_ORIGIN = "http://eveland-frontdoor:17300/";
    const fetchCatalog = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        agents: [
          {
            projectId: "project_support",
            name: "Support",
            description: null,
            url: "https://support.agents.example.com",
            capabilities: { eveChat: true },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchCatalog);

    const response = await connect({
      issuer: "https://identity.example.com",
      projectId: "project_support",
    });

    expect(response.status).toBe(201);
    expect(fetchCatalog).toHaveBeenCalledWith(
      "http://eveland-frontdoor:17300/api/agent-catalog",
      expect.objectContaining({ redirect: "error" }),
    );
    await expect(createRepository(testDb.db).listAgentConnections()).resolves.toEqual([
      expect.objectContaining({ identityIssuer: "https://identity.example.com" }),
    ]);
  });

  it("rejects a Catalog issuer that does not match the configured Eveland instance", async () => {
    const fetchCatalog = vi.fn();
    vi.stubGlobal("fetch", fetchCatalog);
    const response = await connect({
      issuer: "https://attacker.example.com",
      projectId: "project_support",
      name: "Fake",
      description: null,
      url: "https://fake.example.com",
      capabilities: { eveChat: true },
    });

    expect(response.status).toBe(401);
    await expect(createRepository(testDb.db).listAgentConnections()).resolves.toEqual([]);
    expect(fetchCatalog).not.toHaveBeenCalled();
  });

  it("rejects a Project that is absent from Eveland's current Catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ agents: [] })),
    );
    const response = await connect({
      issuer: "https://identity.example.com",
      projectId: "project_missing",
      name: "Missing",
      description: null,
      url: "https://missing.example.com",
      capabilities: { eveChat: true },
    });

    expect(response.status).toBe(404);
    await expect(createRepository(testDb.db).listAgentConnections()).resolves.toEqual([]);
  });

  function connect(body: unknown): Promise<Response> {
    return POST(
      new Request("http://localhost/api/agents/catalog", {
        method: "POST",
        headers: {
          authorization: "Bearer app-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
  }
});

const testVerifier: CallerTokenVerifier = {
  async verifyAuthorization() {
    throw new Error("not used");
  },
  async verifyAppAuthorization(authorization, expectedTarget) {
    if (authorization !== "Bearer app-token" || expectedTarget !== "eve-chats") {
      throw new CallerTokenError(
        "caller_token_invalid",
        401,
        "The Eveland app token is invalid.",
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
