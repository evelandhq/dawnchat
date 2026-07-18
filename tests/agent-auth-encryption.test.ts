import { describe, expect, it } from "vitest";

import { encryptAuthConfig, parseAuthConfig } from "@/eve/auth";

describe("Agent Auth configuration encryption", () => {
  it("binds ciphertext to the connection, method, and security revision", () => {
    const binding = {
      id: "agent_1234567890abcdef",
      authType: "bearer" as const,
      securityRevision: 3,
    };
    const encrypted = encryptAuthConfig({ token: "secret-token" }, binding);

    expect(encrypted).toMatch(/^eve-auth:v2:/);
    expect(parseAuthConfig({ ...binding, baseUrl: "https://agent.example.com", authConfigEncrypted: encrypted }))
      .toEqual({ token: "secret-token" });
    expect(() => parseAuthConfig({
      ...binding,
      id: "agent_fedcba0987654321",
      baseUrl: "https://agent.example.com",
      authConfigEncrypted: encrypted,
    })).toThrow("Agent auth configuration is invalid");
    expect(() => parseAuthConfig({
      ...binding,
      securityRevision: 4,
      baseUrl: "https://agent.example.com",
      authConfigEncrypted: encrypted,
    })).toThrow("Agent auth configuration is invalid");
    expect(() => parseAuthConfig({
      ...binding,
      authType: "headers",
      baseUrl: "https://agent.example.com",
      authConfigEncrypted: encrypted,
    })).toThrow("Agent auth configuration is invalid");
  });
});
