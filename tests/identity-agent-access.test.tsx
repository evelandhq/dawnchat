import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IdentityAgentAccess } from "@/components/identity-agent-access";

const getCallerToken = vi.fn<() => Promise<string>>();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/components/identity-provider", () => ({
  useEvelandIdentity: () => ({
    session: {
      authenticated: true,
      principal: { id: "ipr_1", name: "Test User", email: null },
      activeRealm: { id: "irl_1", name: "Account 1" },
    },
    getCallerToken,
    switchRealm: vi.fn(),
  }),
}));

describe("IdentityAgentAccess", () => {
  beforeEach(() => {
    getCallerToken.mockReset();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ chats: [] })));
  });

  it("lets the user retry a transient Identity failure", async () => {
    getCallerToken
      .mockRejectedValueOnce(new Error("Identity temporarily unavailable"))
      .mockResolvedValueOnce("caller-token");

    render(
      <IdentityAgentAccess
        agentId="agent_1"
        agentName="Support"
        evelandProjectId="project_support"
        disabled={false}
      />,
    );

    expect(await screen.findByText("Identity check failed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByLabelText("First message")).toBeEnabled();
    expect(getCallerToken).toHaveBeenCalledTimes(2);
  });
});
