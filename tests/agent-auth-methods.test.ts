import { describe, expect, it } from "vitest";

import {
  agentAuthConfigsEqual,
  agentAuthMethodDescriptors,
  normalizeAgentAuthConfig,
  redactAgentAuthConfig,
} from "@/eve/auth-methods";

describe("Agent access methods", () => {
  it("uses the same method order and labels as Eveland", () => {
    expect(agentAuthMethodDescriptors.map(({ method, label }) => ({ method, label }))).toEqual([
      { method: "local-dev", label: "Local development" },
      { method: "none", label: "No authentication" },
      { method: "basic", label: "HTTP Basic" },
      { method: "bearer", label: "Bearer token" },
      { method: "vercel-oidc", label: "Vercel OIDC" },
      { method: "oidc", label: "OIDC Authorization Code" },
      { method: "headers", label: "Custom headers" },
    ]);
  });

  it("normalizes HTTP Basic credentials and preserves an omitted password on edit", () => {
    const initial = normalizeAgentAuthConfig("basic", {
      username: "alice",
      password: "first-secret",
    });

    expect(normalizeAgentAuthConfig("basic", { username: "bob" }, initial)).toEqual({
      username: "bob",
      password: "first-secret",
    });
    expect(() => normalizeAgentAuthConfig("basic", { username: "bad:name", password: "secret" }))
      .toThrow("Basic username must not contain a colon");
    expect(redactAgentAuthConfig("basic", initial)).toEqual({
      username: "alice",
      passwordConfigured: true,
    });
  });

  it("normalizes the Eve Bearer and Vercel OIDC token shapes", () => {
    expect(normalizeAgentAuthConfig("bearer", { token: "opaque-token" })).toEqual({ token: "opaque-token" });
    expect(normalizeAgentAuthConfig("vercel-oidc", { token: "vercel-token" })).toEqual({ token: "vercel-token" });
    expect(redactAgentAuthConfig("bearer", { token: "opaque-token" })).toEqual({ tokenConfigured: true });
    expect(redactAgentAuthConfig("vercel-oidc", { token: "vercel-token" })).toEqual({ tokenConfigured: true });
  });

  it("normalizes and redacts multiple custom credential headers", () => {
    const config = normalizeAgentAuthConfig("headers", {
      headers: {
        "X-Zeta-Key": "zeta-secret",
        "X-Alpha-Key": "alpha-secret",
      },
    });

    expect(config).toEqual({
      headers: {
        "x-alpha-key": "alpha-secret",
        "x-zeta-key": "zeta-secret",
      },
    });
    expect(redactAgentAuthConfig("headers", config)).toEqual({
      headerNames: ["x-alpha-key", "x-zeta-key"],
    });
  });

  it("rejects reserved, forwarded, platform, and duplicate custom headers", () => {
    for (const header of ["Host", "Proxy-Authorization", "X-Forwarded-For", "X-Eveland-Agent-Auth"]) {
      expect(() => normalizeAgentAuthConfig("headers", { headers: { [header]: "secret" } }))
        .toThrow(/not allowed/);
    }
    expect(() => normalizeAgentAuthConfig("headers", {
      headers: { "X-Agent-Key": "one", "x-agent-key": "two" },
    })).toThrow("Duplicate Agent credential header x-agent-key");
    expect(() => normalizeAgentAuthConfig("headers", {
      headers: { [`x-${"a".repeat(255)}`]: "secret" },
    })).toThrow(/not allowed/);
    expect(() => normalizeAgentAuthConfig("headers", {
      headers: { "x-agent-key": "a".repeat(16_385) },
    })).toThrow(/not allowed/);
  });

  it("normalizes generic OIDC Authorization Code configuration", () => {
    const config = normalizeAgentAuthConfig("oidc", {
      issuer: "https://identity.example.com/",
      clientId: "eve-chats",
      clientSecret: "client-secret",
      scopes: ["profile", "openid", "offline_access", "profile"],
      audience: "https://agent.example.com",
      audienceMode: "both",
      tokenEndpointAuthMethod: "client_secret_basic",
      authorizationParams: { prompt: "consent" },
      accessTokenVerification: "eve-jwt",
    });

    expect(config).toEqual({
      issuer: "https://identity.example.com",
      clientId: "eve-chats",
      clientSecret: "client-secret",
      scopes: ["openid", "offline_access", "profile"],
      audience: "https://agent.example.com",
      audienceMode: "both",
      tokenEndpointAuthMethod: "client_secret_basic",
      authorizationParams: { prompt: "consent" },
      accessTokenVerification: "eve-jwt",
    });
    expect(redactAgentAuthConfig("oidc", config)).toEqual({
      issuer: "https://identity.example.com",
      clientId: "eve-chats",
      clientSecretConfigured: true,
      scopes: ["openid", "offline_access", "profile"],
      audience: "https://agent.example.com",
      audienceMode: "both",
      tokenEndpointAuthMethod: "client_secret_basic",
      authorizationParams: { prompt: "consent" },
      accessTokenVerification: "eve-jwt",
    });
  });

  it("rejects unsafe or incomplete OIDC configuration", () => {
    expect(() => normalizeAgentAuthConfig("oidc", {
      issuer: "http://identity.example.com",
      clientId: "eve-chats",
    })).toThrow("OIDC issuer must use HTTPS");
    expect(() => normalizeAgentAuthConfig("oidc", {
      issuer: "https://identity.example.com",
      clientId: "eve-chats",
      tokenEndpointAuthMethod: "client_secret_post",
    })).toThrow("requires a client secret");
    expect(() => normalizeAgentAuthConfig("oidc", {
      issuer: "https://identity.example.com",
      clientId: "eve-chats",
      accessTokenVerification: "eve-jwt",
    })).toThrow("requires an audience");
    expect(() => normalizeAgentAuthConfig("oidc", {
      issuer: "https://identity.example.com",
      clientId: "eve-chats",
      authorizationParams: { state: "attacker-controlled" },
    })).toThrow("OIDC authorization parameter state is managed by eve-chats");
  });

  it("compares normalized configs independent of record key order", () => {
    expect(agentAuthConfigsEqual(
      { headers: { "x-a": "one", "x-b": "two" } },
      { headers: { "x-b": "two", "x-a": "one" } },
    )).toBe(true);
  });
});
