import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRepository, type Repository } from "@/db/repository";
import { encryptAuthConfig } from "@/eve/auth";
import {
  AgentAuthorizationRequiredError,
  calculatePkceCodeChallenge,
  createAgentOidcService,
  type OidcProtocol,
  type OidcTokenSet,
} from "@/eve/oidc";
import { createTestDbHandle, type TestDbHandle } from "@/test/db";
import { createId } from "@/lib/ids";

function oidcConfig() {
  return {
    issuer: "https://identity.example.com",
    clientId: "eve-chats",
    clientSecret: "client-secret",
    scopes: ["openid", "offline_access"],
    audience: "https://agent.example.com",
    audienceMode: "resource" as const,
    tokenEndpointAuthMethod: "client_secret_basic" as const,
    accessTokenVerification: "userinfo" as const,
  };
}

function fakeProtocol(tokens: {
  exchanged: OidcTokenSet;
  refreshed: OidcTokenSet;
}): OidcProtocol & {
  preflight: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  fetchUserInfo: ReturnType<typeof vi.fn>;
} {
  return {
    preflight: vi.fn(async () => undefined),
    buildAuthorizationUrl: vi.fn(async (_config, transaction) => {
      const url = new URL("https://identity.example.com/authorize");
      url.searchParams.set("redirect_uri", transaction.redirectUri);
      url.searchParams.set("state", transaction.state);
      url.searchParams.set("nonce", transaction.nonce);
      url.searchParams.set("code_challenge", `challenge:${transaction.codeVerifier}`);
      return url;
    }),
    exchangeAuthorizationCode: vi.fn(async () => tokens.exchanged),
    refresh: vi.fn(async () => tokens.refreshed),
    fetchUserInfo: vi.fn(async (_config, accessToken, expectedSubject) => {
      expect(accessToken).toMatch(/access-token/);
      return { subject: expectedSubject };
    }),
  };
}

describe("Agent OIDC Authorization Code", () => {
  let db: TestDbHandle;
  let repository: Repository;
  let now: Date;

  beforeEach(async () => {
    db = await createTestDbHandle();
    repository = createRepository(db.db);
    now = new Date("2026-07-19T12:00:00.000Z");
  });

  afterEach(async () => {
    await db.close();
  });

  async function connection(baseUrl = "https://agent.example.com") {
    const id = createId("agent");
    return repository.createAgentConnection({
      id,
      name: "Protected Agent",
      baseUrl,
      authType: "oidc",
      authConfigEncrypted: encryptAuthConfig(oidcConfig(), {
        id,
        authType: "oidc",
        securityRevision: 1,
      }),
    });
  }

  it("calculates the RFC 7636 S256 PKCE challenge", () => {
    expect(calculatePkceCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
      .toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("uses state, nonce, and PKCE, consumes the callback once, and stores only encrypted tokens", async () => {
    const agent = await connection();
    const protocol = fakeProtocol({
      exchanged: {
        accessToken: "exchanged-access-token",
        refreshToken: "refresh-token",
        expiresAt: new Date(now.getTime() + 3_600_000),
        issuer: oidcConfig().issuer,
        subject: "user-123",
      },
      refreshed: {
        accessToken: "refreshed-access-token",
        refreshToken: "rotated-refresh-token",
        expiresAt: new Date(now.getTime() + 7_200_000),
        issuer: oidcConfig().issuer,
        subject: "user-123",
      },
    });
    const service = createAgentOidcService({ repository, protocol, now: () => now });

    const started = await service.start({
      connection: agent,
      callbackUrl: "https://chats.example.com/agent-auth/oidc/callback",
      returnPath: `/agents/${agent.id}/edit`,
    });
    const authorizationUrl = new URL(started.authorizationUrl);

    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe("https://chats.example.com/agent-auth/oidc/callback");
    expect(authorizationUrl.searchParams.get("state")).toBe(started.state);
    expect(authorizationUrl.searchParams.get("nonce")).toEqual(expect.any(String));
    expect(authorizationUrl.searchParams.get("code_challenge")).toMatch(/^challenge:/);
    expect(started.state).not.toContain(agent.id);

    const completed = await service.callback({
      search: `?code=authorization-code&state=${encodeURIComponent(started.state)}`,
    });
    expect(completed).toEqual({ returnPath: `/agents/${agent.id}/edit`, agentConnectionId: agent.id });

    const credential = await repository.getAgentAuthCredential(service.credentialKey(agent));
    expect(credential?.payloadEncrypted).toMatch(/^eve-auth-state:v1:/);
    expect(credential?.payloadEncrypted).not.toContain("exchanged-access-token");
    expect(credential?.payloadEncrypted).not.toContain("refresh-token");

    await expect(service.callback({
      search: `?code=replay&state=${encodeURIComponent(started.state)}`,
    })).rejects.toThrow("invalid, expired, or already used");
  });

  it("stores a non-usable pending credential when UserInfo is temporarily unavailable", async () => {
    const agent = await connection();
    const protocol = fakeProtocol({
      exchanged: {
        accessToken: "exchanged-access-token",
        refreshToken: "refresh-token",
        expiresAt: new Date(now.getTime() + 3_600_000),
        issuer: oidcConfig().issuer,
        subject: "user-123",
      },
      refreshed: {
        accessToken: "refreshed-access-token",
        expiresAt: new Date(now.getTime() + 3_600_000),
        issuer: oidcConfig().issuer,
        subject: "user-123",
      },
    });
    protocol.fetchUserInfo.mockRejectedValueOnce(new Error("UserInfo is temporarily unavailable"));
    const service = createAgentOidcService({ repository, protocol, now: () => now });
    const started = await service.start({
      connection: agent,
      callbackUrl: "https://chats.example.com/agent-auth/oidc/callback",
      returnPath: `/agents/${agent.id}/edit`,
    });

    await expect(service.callback({
      search: `?code=authorization-code&state=${encodeURIComponent(started.state)}`,
    })).resolves.toMatchObject({ agentConnectionId: agent.id });
    const stored = await repository.getAgentAuthCredential(service.credentialKey(agent));
    expect(stored?.payloadEncrypted).not.toContain("exchanged-access-token");
    await expect(service.resolve(agent)).resolves.toEqual({
      token: "exchanged-access-token",
      rotationSeq: 1,
    });
    expect(protocol.fetchUserInfo).toHaveBeenCalledTimes(2);
  });

  it("resolves a verified bearer credential and refreshes it before expiry", async () => {
    const agent = await connection();
    const protocol = fakeProtocol({
      exchanged: {
        accessToken: "initial-access-token",
        refreshToken: "initial-refresh-token",
        expiresAt: new Date(now.getTime() + 20_000),
        issuer: oidcConfig().issuer,
        subject: "user-123",
      },
      refreshed: {
        accessToken: "refreshed-access-token",
        expiresAt: new Date(now.getTime() + 3_600_000),
        issuer: oidcConfig().issuer,
        subject: "user-123",
      },
    });
    const service = createAgentOidcService({ repository, protocol, now: () => now });
    const started = await service.start({
      connection: agent,
      callbackUrl: "https://chats.example.com/agent-auth/oidc/callback",
      returnPath: `/agents/${agent.id}/edit`,
    });
    await service.callback({ search: `?code=code&state=${encodeURIComponent(started.state)}` });

    const resolved = await service.resolve(agent, `/agents/${agent.id}/edit`);

    expect(resolved.token).toBe("refreshed-access-token");
    expect(resolved.rotationSeq).toBe(1);
    expect(protocol.refresh).toHaveBeenCalledOnce();

    now = new Date(now.getTime() + 3_590_000);
    await expect(service.resolve(agent, `/agents/${agent.id}/edit`)).resolves.toMatchObject({
      token: "refreshed-access-token",
      rotationSeq: 2,
    });
    expect(protocol.refresh.mock.calls.map((call) => call[1])).toEqual([
      "initial-refresh-token",
      "initial-refresh-token",
    ]);
  });

  it("coalesces concurrent refreshes for the same credential", async () => {
    const agent = await connection();
    const protocol = fakeProtocol({
      exchanged: {
        accessToken: "initial-access-token",
        refreshToken: "initial-refresh-token",
        expiresAt: new Date(now.getTime() + 20_000),
        issuer: oidcConfig().issuer,
        subject: "user-123",
      },
      refreshed: {
        accessToken: "refreshed-access-token",
        refreshToken: "rotated-refresh-token",
        expiresAt: new Date(now.getTime() + 3_600_000),
        issuer: oidcConfig().issuer,
        subject: "user-123",
      },
    });
    const service = createAgentOidcService({ repository, protocol, now: () => now });
    const started = await service.start({
      connection: agent,
      callbackUrl: "https://chats.example.com/agent-auth/oidc/callback",
      returnPath: `/agents/${agent.id}/edit`,
    });
    await service.callback({ search: `?code=code&state=${encodeURIComponent(started.state)}` });

    const resolved = await Promise.all(Array.from({ length: 6 }, () => service.resolve(agent)));

    expect(resolved).toEqual(Array.from({ length: 6 }, () => ({
      token: "refreshed-access-token",
      rotationSeq: 1,
    })));
    expect(protocol.refresh).toHaveBeenCalledOnce();
  });

  it("requires an explicit authorization interaction when no principal credential exists", async () => {
    const agent = await connection();
    const protocol = fakeProtocol({
      exchanged: {
        accessToken: "access-token",
        expiresAt: new Date(now.getTime() + 3_600_000),
        issuer: oidcConfig().issuer,
        subject: "user-123",
      },
      refreshed: {
        accessToken: "refreshed-access-token",
        expiresAt: new Date(now.getTime() + 3_600_000),
        issuer: oidcConfig().issuer,
        subject: "user-123",
      },
    });
    const service = createAgentOidcService({ repository, protocol, now: () => now });

    await expect(service.resolve(agent, `/agents/${agent.id}/edit`)).rejects.toMatchObject({
      name: "AgentAuthorizationRequiredError",
      interactionUrl: `/api/agents/${agent.id}/auth/oidc/start?returnPath=%2Fagents%2F${agent.id}%2Fedit`,
    } satisfies Partial<AgentAuthorizationRequiredError>);
  });

  it("allows chat return paths only when the chat belongs to the connection", async () => {
    const agent = await connection();
    const chat = await repository.createChat({ agentConnectionId: agent.id, title: "Authorized chat" });
    const otherAgent = await connection("https://other-agent.example.com");
    const otherChat = await repository.createChat({ agentConnectionId: otherAgent.id, title: "Other chat" });
    const protocol = fakeProtocol({
      exchanged: {
        accessToken: "access-token",
        expiresAt: new Date(now.getTime() + 3_600_000),
        issuer: oidcConfig().issuer,
        subject: "user-123",
      },
      refreshed: {
        accessToken: "refreshed-access-token",
        expiresAt: new Date(now.getTime() + 3_600_000),
        issuer: oidcConfig().issuer,
        subject: "user-123",
      },
    });
    const service = createAgentOidcService({ repository, protocol, now: () => now });

    await expect(service.start({
      connection: agent,
      callbackUrl: "https://chats.example.com/agent-auth/oidc/callback",
      returnPath: `/chats/${chat.id}`,
    })).resolves.toMatchObject({ authorizationUrl: expect.any(String) });
    await expect(service.start({
      connection: agent,
      callbackUrl: "https://chats.example.com/agent-auth/oidc/callback",
      returnPath: `/chats/${otherChat.id}`,
    })).rejects.toThrow("OIDC return path is not allowed");
  });

  it("invalidates an authorization transaction when the connection security revision changes", async () => {
    const agent = await connection();
    const protocol = fakeProtocol({
      exchanged: {
        accessToken: "access-token",
        expiresAt: new Date(now.getTime() + 3_600_000),
        issuer: oidcConfig().issuer,
        subject: "user-123",
      },
      refreshed: {
        accessToken: "refreshed-access-token",
        expiresAt: new Date(now.getTime() + 3_600_000),
        issuer: oidcConfig().issuer,
        subject: "user-123",
      },
    });
    const service = createAgentOidcService({ repository, protocol, now: () => now });
    const started = await service.start({
      connection: agent,
      callbackUrl: "https://chats.example.com/agent-auth/oidc/callback",
      returnPath: `/agents/${agent.id}/edit`,
    });
    await repository.updateAgentConnection(agent.id, {
      name: agent.name,
      baseUrl: agent.baseUrl,
      authType: "oidc",
      authConfigEncrypted: agent.authConfigEncrypted,
      expectedSecurityRevision: agent.securityRevision,
      securityChanged: true,
    });

    await expect(service.callback({
      search: `?code=code&state=${encodeURIComponent(started.state)}`,
    })).rejects.toThrow("changed while OIDC authorization was in progress");
  });
});
