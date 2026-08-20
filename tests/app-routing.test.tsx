import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import AgentsPage from "@/app/agents/page";
import ChatsPage from "@/app/chats/page";
import HomePage from "@/app/page";
import { renderWithChatList } from "@/test/chat-list";

const {
  getAppTokenMock,
  getSessionMock,
  redirectMock,
  redirectSentinel,
  replaceMock,
} = vi.hoisted(() => {
  const sentinel = new Error("TEST_REDIRECT_SENTINEL");

  return {
    getAppTokenMock: vi.fn(),
    getSessionMock: vi.fn(),
    redirectSentinel: sentinel,
    redirectMock: vi.fn(() => {
      throw sentinel;
    }),
    replaceMock: vi.fn(),
  };
});

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
  usePathname: () => "/",
  useRouter: () => ({ replace: replaceMock }),
}));

vi.mock("@/components/agent-catalog", () => ({
  AgentCatalog: () => <div>Identity-aware Agent Catalog</div>,
}));

vi.mock("@/components/identity-provider", () => ({
  useEvelandIdentity: () => ({
    getAppToken: getAppTokenMock,
    getSession: getSessionMock,
  }),
}));

describe("app routing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    redirectMock.mockClear();
    replaceMock.mockReset();
    getAppTokenMock.mockReset();
    getSessionMock.mockReset();
  });

  it("redirects / to the most recent accessible chat", async () => {
    getSessionMock.mockResolvedValue({ authenticated: false });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          chats: [
            { id: "chat_recent", agentConnectionId: "agent_2" },
            { id: "chat_first", agentConnectionId: "agent_1" },
          ],
        }),
      ),
    );

    renderWithChatList(<HomePage />);

    await waitFor(() =>
      expect(replaceMock).toHaveBeenCalledWith("/chats/chat_recent"),
    );
    expect(getAppTokenMock).not.toHaveBeenCalled();
  });

  it("redirects / to /agents when there is no accessible chat", async () => {
    getSessionMock.mockResolvedValue({ authenticated: false });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ chats: [] })),
    );

    renderWithChatList(<HomePage />);

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/agents"));
  });

  it("renders the Identity-aware Catalog at /agents", () => {
    render(AgentsPage());

    expect(screen.getByText("Identity-aware Agent Catalog")).toBeInTheDocument();
  });

  it("redirects /chats to / and terminates rendering", () => {
    expect(() => ChatsPage()).toThrow(redirectSentinel);
    expect(redirectMock).toHaveBeenCalledOnce();
    expect(redirectMock).toHaveBeenCalledWith("/");
  });
});
