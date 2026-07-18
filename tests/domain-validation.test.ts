import { describe, expect, it } from "vitest";
import {
  createAgentConnectionSchema,
  createChatSchema,
  normalizeAgentBaseUrl,
  updateAgentConnectionSchema,
} from "@/lib/validation";

import { createId } from "@/lib/ids";

describe("domain validation", () => {
  it("normalizes Eve agent base URLs without trailing slash", () => {
    expect(normalizeAgentBaseUrl("https://agent.example.com/")).toBe("https://agent.example.com");
  });

  it("rejects non-http Eve agent URLs", () => {
    expect(() => normalizeAgentBaseUrl("file:///tmp/agent")).toThrow("Agent URL must use http or https");
  });

  it("rejects malformed Eve agent URLs", () => {
    expect(() => normalizeAgentBaseUrl("not a url")).toThrow("Agent URL must be a valid URL");
  });

  it("rejects Eve agent URLs containing credentials without leaking them in the error", () => {
    const credentialUrl = "https://user:super-secret-pass@agent.example.com/";

    expect(() => normalizeAgentBaseUrl(credentialUrl)).toThrow("Agent URL must not include credentials");
    expect(() => createAgentConnectionSchema.parse({ name: "Agent", baseUrl: credentialUrl })).toThrow(
      "Agent URL must not include credentials",
    );
  });

  it("accepts bearer auth config", () => {
    const parsed = createAgentConnectionSchema.parse({
      name: "Support Agent",
      baseUrl: "https://support.example.com",
      authType: "bearer",
      config: { token: "secret-token" },
    });

    expect(parsed.authType).toBe("bearer");
    expect(parsed.config).toEqual({ token: "secret-token" });
  });

  it("trims agent names and strips URL search and hash", () => {
    const parsed = createAgentConnectionSchema.parse({
      name: "  Billing Agent  ",
      baseUrl: " https://billing.example.com/api/?debug=true#section ",
    });

    expect(parsed.name).toBe("Billing Agent");
    expect(parsed.baseUrl).toBe("https://billing.example.com/api");
    expect(parsed.authType).toBe("none");
  });

  it("rejects unsupported Agent access methods", () => {
    expect(() => createAgentConnectionSchema.parse({
      name: "Support Agent",
      baseUrl: "https://support.example.com",
      authType: "made-up",
      config: {},
    })).toThrow();
  });

  it("normalizes edit fields without requiring an unchanged secret", () => {
    expect(
      updateAgentConnectionSchema.parse({
        name: "  Renamed Agent  ",
        baseUrl: "https://agent.example.com/?source=edit",
        authType: "bearer",
        config: {},
      }),
    ).toMatchObject({
      name: "Renamed Agent",
      baseUrl: "https://agent.example.com",
      authType: "bearer",
      config: {},
    });
  });

  it("accepts the standard Custom headers config envelope", () => {
    expect(
      updateAgentConnectionSchema.parse({
        name: "Header Agent",
        baseUrl: "https://header.example.com",
        authType: "headers",
        config: { headers: { "X-Agent-Key": "secret" } },
      }),
    ).toMatchObject({
      authType: "headers",
      config: { headers: { "X-Agent-Key": "secret" } },
    });
  });

  it("trims valid chat creation messages and rejects empty chat agent ids", () => {
    expect(createChatSchema.parse({ agentId: "agent_123", message: "  Hello  " })).toEqual({
      agentId: "agent_123",
      message: "Hello",
    });

    expect(() => createChatSchema.parse({ agentId: "   ", message: "Hello" })).toThrow();
  });

  it("rejects empty chat creation messages", () => {
    expect(() => createChatSchema.parse({ agentId: "agent_123", message: "   " })).toThrow();
  });

  it("creates prefixed ids", () => {
    expect(createId("agent")).toMatch(/^agent_[a-f0-9]{16}$/);
    expect(createId(" agent ")).toMatch(/^agent_[a-f0-9]{16}$/);
  });

  it("rejects unsafe id prefixes", () => {
    expect(() => createId("")).toThrow("ID prefix must start with a lowercase letter");
    expect(() => createId("foo/bar")).toThrow("ID prefix must start with a lowercase letter");
    expect(() => createId("Agent")).toThrow("ID prefix must start with a lowercase letter");
  });
});
