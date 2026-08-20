import React from "react";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IdentityAgentAccess } from "@/components/identity-agent-access";
import { renderWithChatList } from "@/test/chat-list";

const getCallerToken = vi.fn<() => Promise<string>>();
const getAppToken = vi.fn<() => Promise<string>>();
const getSession = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => "/agents/agent_1",
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

    renderWithChatList(
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

  it("lets the visitor compose before the Identity-scoped history resolves", async () => {
    let releaseChats: (() => void) | undefined;
    const chatsLoaded = new Promise<void>((resolve) => {
      releaseChats = resolve;
    });
    getAppToken.mockResolvedValue("app-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await chatsLoaded;
        return Response.json({ chats: [] });
      }),
    );

    renderWithChatList(
      <IdentityAgentAccess
        agentId="agent_1"
        agentName="Support"
        disabled={false}
      />,
    );

    // Still in flight: the composer must already accept a first message.
    expect(await screen.findByLabelText("First message")).toBeEnabled();
    expect(
      screen.queryByText("Checking access…"),
    ).not.toBeInTheDocument();
    releaseChats?.();
  });

  it("authenticates a first message with an App Token resolved at send time", async () => {
    getAppToken.mockResolvedValue("app-token");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "/api/chats"
        ? Response.json({ chat: { id: "chat_new" } }, { status: 201 })
        : Response.json({ chats: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderWithChatList(
      <IdentityAgentAccess
        agentId="agent_1"
        agentName="Support"
        disabled={false}
      />,
    );

    fireEvent.change(await screen.findByLabelText("First message"), {
      target: { value: "Hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/chats",
        expect.objectContaining({
          method: "POST",
          headers: {
            authorization: "Bearer app-token",
            "content-type": "application/json",
          },
        }),
      ),
    );
  });

  it("lets the user retry a transient Identity failure", async () => {
    getAppToken
      .mockRejectedValueOnce(new Error("Identity temporarily unavailable"))
      .mockResolvedValueOnce("app-token");

    renderWithChatList(
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

  it("constrains long recent-message previews to the composer width", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          chats: [
            {
              id: "chat_1",
              agentConnectionId: "agent_1",
              title: "A long conversation",
              lastMessage: "Unbroken attachment content".repeat(500),
            },
          ],
        }),
      ),
    );

    renderWithChatList(
      <IdentityAgentAccess
        agentId="agent_1"
        agentName="Support"
        disabled={false}
      />,
    );

    const recentChats = await screen.findByRole("region", {
      name: "Recent conversations",
    });
    const chatLink = within(recentChats).getByRole("link");

    expect(recentChats).toHaveClass("min-w-0");
    expect(chatLink).toHaveClass("min-w-0");
    expect(chatLink.parentElement).toHaveClass("min-w-0");
  });
});
