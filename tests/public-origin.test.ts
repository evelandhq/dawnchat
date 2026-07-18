import { afterEach, describe, expect, it, vi } from "vitest";

import { agentAuthCallbackUrl } from "@/lib/public-origin";

describe("public application origin", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the request origin only for loopback development", () => {
    vi.stubEnv("APP_ORIGIN", "");
    expect(agentAuthCallbackUrl("http://localhost:3010/api/agents/agent_1/auth/oidc/start"))
      .toBe("http://localhost:3010/agent-auth/oidc/callback");
    expect(() => agentAuthCallbackUrl("https://untrusted-host.example.com/api/agents/agent_1/auth/oidc/start"))
      .toThrow("APP_ORIGIN is required outside local development");
  });

  it("uses the configured HTTPS origin instead of the request Host", () => {
    vi.stubEnv("APP_ORIGIN", "https://chats.example.com");
    expect(agentAuthCallbackUrl("https://attacker.example.com/api/agents/agent_1/auth/oidc/start"))
      .toBe("https://chats.example.com/agent-auth/oidc/callback");
  });
});
