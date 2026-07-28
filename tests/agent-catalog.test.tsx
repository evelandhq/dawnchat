import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AgentCatalog } from "@/components/agent-catalog";

const push = vi.fn();
const getCatalog = vi.fn();
const getAppToken = vi.fn();
const getCallerToken = vi.fn();
const getSession = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

vi.mock("@/components/identity-provider", () => ({
  useEvelandIdentity: () => ({
    getCatalog,
    getAppToken,
    getCallerToken,
    getSession,
  }),
}));

describe("AgentCatalog", () => {
  beforeEach(() => {
    push.mockReset();
    getCatalog.mockReset();
    getAppToken.mockReset();
    getCallerToken.mockReset();
    getSession.mockReset();
    getCatalog.mockResolvedValue({
      issuer: "https://identity.example.com",
      agents: [
        {
          projectId: "project_support",
          name: "Support",
          description: "Answers support questions.",
          url: "https://support.agents.example.com",
          capabilities: { eveChat: true },
        },
      ],
    });
    getAppToken.mockResolvedValue("app-token");
    getCallerToken.mockResolvedValue("caller-token");
    getSession.mockResolvedValue({
      authenticated: true,
      principal: { id: "iprn_user", name: "Test User", email: null },
      activeRealm: { id: "irlm_account", name: "Account" },
    });
  });

  it("shows the public Catalog without starting Eveland login", async () => {
    getSession.mockResolvedValue({ authenticated: false });
    const fetchMock = vi.fn(async () =>
      Response.json({ chats: [], agents: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<AgentCatalog />);

    expect(
      await screen.findByRole("button", { name: "Chat with Support" }),
    ).toBeInTheDocument();
    expect(getSession).toHaveBeenCalledOnce();
    expect(getAppToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens a public Catalog Agent without starting Eveland login", async () => {
    getSession.mockResolvedValue({ authenticated: false });
    const fetchMock = vi.fn(async () =>
      Response.json({ agent: { id: "agent_1" } }, { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<AgentCatalog />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Chat with Support" }),
    );

    await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/agents/agent_1"));
    expect(getAppToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agents/catalog",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    );
  });

  it("automatically displays routable Catalog Agents without a Gateway URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ chats: [] })),
    );

    render(<AgentCatalog />);

    expect(await screen.findByRole("button", { name: "Chat with Support" })).toBeInTheDocument();
    expect(screen.getByText("Answers support questions.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Gateway URL")).not.toBeInTheDocument();
    expect(getCatalog).toHaveBeenCalledWith("/agents");
  });

  it("creates the managed connection lazily when the user clicks an Agent", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ chats: [] }))
      .mockResolvedValueOnce(Response.json({ agents: [] }))
      .mockResolvedValueOnce(
        Response.json({ agent: { id: "agent_1" } }, { status: 201 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<AgentCatalog />);
    fireEvent.click(await screen.findByRole("button", { name: "Chat with Support" }));

    expect(await screen.findByText("Opening…")).toBeInTheDocument();
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/agents/agent_1"));
    expect(getCallerToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/agents/catalog",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
        }),
      }),
    );
  });

  it("keeps historical Agents visible as unavailable when they leave the Catalog", async () => {
    getCatalog.mockResolvedValue({
      issuer: "https://identity.example.com",
      agents: [],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          chats: [
            {
              id: "chat_1",
              agentConnectionId: "agent_old",
              agentName: "Former Support",
              evelandProjectId: "project_old",
              title: "Previous conversation",
              lastMessage: null,
            },
          ],
        }),
      ),
    );

    render(<AgentCatalog />);

    expect(await screen.findByText("Former Support")).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Previous conversation" })).toHaveAttribute(
      "href",
      "/chats/chat_1",
    );
  });

  it("keeps manually connected external Agents on the home page", async () => {
    getCatalog.mockResolvedValue({
      issuer: "https://identity.example.com",
      agents: [],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        return url === "/api/agents"
          ? Response.json({
              agents: [
                {
                  id: "agent_external",
                  name: "Private Eve",
                  baseUrl: "https://private.example.com",
                  evelandProjectId: undefined,
                  status: "healthy",
                },
              ],
            })
          : Response.json({ chats: [] });
      }),
    );

    render(<AgentCatalog />);

    expect(
      await screen.findByRole("link", { name: "Chat with Private Eve" }),
    ).toHaveAttribute("href", "/agents/agent_external");
    expect(screen.getByText("External")).toBeInTheDocument();
  });
});
