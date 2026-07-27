import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthenticatedChatThread } from "@/components/authenticated-chat-thread";

const getCallerToken = vi.fn<() => Promise<string>>();

vi.mock("@/components/identity-provider", () => ({
  useEvelandIdentity: () => ({
    getCallerToken,
    switchRealm: vi.fn(),
  }),
}));

vi.mock("@/components/chat-thread", () => ({
  ChatThread: () => <div>Conversation ready</div>,
}));

describe("AuthenticatedChatThread", () => {
  beforeEach(() => {
    getCallerToken.mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          chat: {
            id: "chat_1",
            agentConnectionId: "agent_1",
            title: "Hello",
            status: "active",
            eveSessionId: null,
            continuationToken: null,
            streamIndex: 0,
            pendingUserMessage: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            messages: [],
          },
          events: [],
        }),
      ),
    );
  });

  it("lets the user retry a transient Identity failure", async () => {
    getCallerToken
      .mockRejectedValueOnce(new Error("Identity temporarily unavailable"))
      .mockResolvedValueOnce("caller-token");

    render(
      <AuthenticatedChatThread
        chatId="chat_1"
        evelandProjectId="project_support"
      />,
    );

    expect(await screen.findByText("Unable to load chat")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Conversation ready")).toBeInTheDocument();
    expect(getCallerToken).toHaveBeenCalledTimes(2);
  });
});
