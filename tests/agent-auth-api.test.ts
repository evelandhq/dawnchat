import { describe, expect, it } from "vitest";

import { GET } from "@/app/api/agent-auth/methods/route";
import { agentAuthCallbackSearch, safeAgentAuthReturnPath } from "@/lib/agent-auth-callback";

describe("Agent Auth API contracts", () => {
  it("publishes all standard access-method descriptors without credentials", async () => {
    const response = await GET();
    const body = await response.json() as { methods: Array<{ method: string; label: string }> };

    expect(response.status).toBe(200);
    expect(body.methods.map(({ method, label }) => ({ method, label }))).toEqual([
      { method: "local-dev", label: "Local development" },
      { method: "none", label: "No authentication" },
      { method: "basic", label: "HTTP Basic" },
      { method: "bearer", label: "Bearer token" },
      { method: "vercel-oidc", label: "Vercel OIDC" },
      { method: "oidc", label: "OIDC Authorization Code" },
      { method: "headers", label: "Custom headers" },
    ]);
  });

  it("keeps only the OIDC callback query and allows only local Agent or chat return paths", () => {
    expect(agentAuthCallbackSearch("?code=secret-code&state=opaque-state")).toBe("?code=secret-code&state=opaque-state");
    expect(agentAuthCallbackSearch("?code=missing-state")).toBeNull();
    expect(safeAgentAuthReturnPath("/agents/agent_1234567890abcdef/edit")).toBe("/agents/agent_1234567890abcdef/edit");
    expect(safeAgentAuthReturnPath("/chats/chat_1234567890abcdef")).toBe("/chats/chat_1234567890abcdef");
    expect(safeAgentAuthReturnPath("https://attacker.example.com/")).toBe("/agents");
    expect(safeAgentAuthReturnPath("//attacker.example.com/")).toBe("/agents");
  });
});
