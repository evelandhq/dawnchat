import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IdentityAgentAccess } from "@/components/identity-agent-access";

const getCallerToken = vi.fn<() => Promise<string>>();
const getAppToken = vi.fn<() => Promise<string>>();
const getSession = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/components/identity-provider", () => ({
  useEvelandIdentity: () => ({
    session: null,
    getCallerToken,
    getAppToken,
    getSession,
    switchRealm: vi.fn(),
  }),
}));

describe("IdentityAgentAccess", () => {
  beforeEach(() => {
    getCallerToken.mockReset();
    getAppToken.mockReset();
    getSession.mockReset();
    getSession.mockResolvedValue({
      authenticated: true,
      principal: { id: "ipr_1", name: "Test User", email: null },
      activeRealm: { id: "irl_1", name: "Account 1" },
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ chats: [] })));
  });

  it("opens an Agent for an unauthenticated visitor without starting login", async () => {
    getSession.mockResolvedValue({ authenticated: false });
    getAppToken.mockResolvedValue("unexpected-app-token");
    const fetchMock = vi.fn(async () => Response.json({ chats: [] }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <IdentityAgentAccess
        agentId="agent_1"
        agentName="Sample Hello World"
        disabled={false}
      />,
    );

    expect(await screen.findByLabelText("First message")).toBeEnabled();
    expect(getAppToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith("/api/chats", {
      cache: "no-store",
    });
  });

  it("lets the user retry a transient Identity failure", async () => {
    getAppToken
      .mockRejectedValueOnce(new Error("Identity temporarily unavailable"))
      .mockResolvedValueOnce("app-token");

    render(
      <IdentityAgentAccess
        agentId="agent_1"
        agentName="Support"
        disabled={false}
      />,
    );

    expect(await screen.findByText("Identity check failed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByLabelText("First message")).toBeEnabled();
    expect(getAppToken).toHaveBeenCalledTimes(2);
  });
});
