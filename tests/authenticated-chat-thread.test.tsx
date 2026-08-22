import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthenticatedChatThread } from "@/components/authenticated-chat-thread";

const refreshChatList = vi.fn<() => Promise<void>>();
const chatListState = {
  status: "ready" as const,
  chats: [],
  authenticated: true,
  error: null,
};
const getCallerToken = vi.fn<() => Promise<string>>();
const getAppToken = vi.fn<() => Promise<string>>();
const getCatalog = vi.fn();
const getSession = vi.fn();

vi.mock("@/components/chat-list-provider", () => ({
  useChatList: () => ({ state: chatListState, refresh: refreshChatList }),
}));

vi.mock("@/components/identity-provider", () => ({
  useEvelandIdentity: () => ({
    getCallerToken,
    getAppToken,
    getCatalog,
    getSession,
    switchRealm: vi.fn(),
  }),
}));

vi.mock("@/components/chat-thread", () => ({
  ChatThread: ({ readOnly }: { readOnly?: boolean }) => (
    <div>
      Conversation ready
      {readOnly ? <span>Read-only conversation</span> : null}
    </div>
  ),
}));

describe("AuthenticatedChatThread", () => {
  beforeEach(() => {
    getCallerToken.mockReset();
    getAppToken.mockReset();
    getCatalog.mockReset();
    getSession.mockReset();
    getSession.mockResolvedValue({
      authenticated: true,
      principal: { id: "ipr_user_1", name: "Test User", email: null },
      activeRealm: { id: "irl_account_1", name: "Account" },
    });
    getCatalog.mockResolvedValue({
      issuer: "https://identity.example.com",
      agents: [{ projectId: "project_support" }],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          chat: {
            id: "chat_1",
            agentConnectionId: "agent_1",
            title: "Hello",
            status: "active",
            evelandProjectId: "project_support",
            sessionState: null,
            pendingUserMessage: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          events: [],
        }),
      ),
    );
  });

  it("loads an anonymous browser-session chat without starting Eveland login", async () => {
    getSession.mockResolvedValue({ authenticated: false });
    getAppToken.mockResolvedValue("unexpected-app-token");
    const fetchMock = vi.fn(async () =>
      Response.json({
        chat: {
          id: "chat_guest",
          agentConnectionId: "agent_1",
          title: "Hello",
          status: "active",
          evelandProjectId: null,
          sessionState: null,
          pendingUserMessage: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        events: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<AuthenticatedChatThread chatId="chat_guest" />);

    expect(await screen.findByText("Conversation ready")).toBeInTheDocument();
    expect(getAppToken).not.toHaveBeenCalled();
    // An anonymous chat never consults the Catalog — that would start login.
    expect(getCatalog).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith("/api/chats/chat_guest", {
      cache: "no-store",
    });
  });

  it("lets the user retry a transient Identity failure", async () => {
    getAppToken
      .mockRejectedValueOnce(new Error("Identity temporarily unavailable"))
      .mockResolvedValueOnce("app-token");

    render(<AuthenticatedChatThread chatId="chat_1" />);

    expect(await screen.findByText("Unable to load chat")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Conversation ready")).toBeInTheDocument();
    expect(getAppToken).toHaveBeenCalledTimes(2);
  });

  it("keeps history readable after an Agent leaves the Catalog", async () => {
    getAppToken.mockResolvedValue("app-token");
    getCatalog.mockResolvedValue({
      issuer: "https://identity.example.com",
      agents: [],
    });

    render(<AuthenticatedChatThread chatId="chat_1" />);

    expect(
      await screen.findByText("This Agent is currently unavailable"),
    ).toBeInTheDocument();
    expect(screen.getByText("Conversation ready")).toBeInTheDocument();
    expect(screen.getByText("Read-only conversation")).toBeInTheDocument();
  });
});
