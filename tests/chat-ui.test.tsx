import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ChatList, type ChatListAgent, type ChatListSummary } from "@/components/chat-list";
import { ChatThread, type ChatThreadMessage, type ChatThreadSummary } from "@/components/chat-thread";
import { getChatsForPage } from "@/app/chats/page";
import { getChatThreadForPage } from "@/app/chats/[chatId]/page";
import { createRepository } from "@/db/repository";
import { setDbClientForTests } from "@/db/provider";
import { createTestDbHandle, type TestDbHandle } from "@/test/db";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
  }),
}));

describe("ChatsPage data loading", () => {
  let testDb: TestDbHandle;

  beforeEach(() => {
    testDb = createTestDbHandle();
    setDbClientForTests(testDb.db);
  });

  afterEach(() => {
    setDbClientForTests(null);
    testDb.close();
    vi.restoreAllMocks();
  });

  it("renders chat history with bound agent names", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Research Eve",
      baseUrl: "https://research-eve.example.com",
      authType: "none",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({ agentConnectionId: agent.id, title: "Plan the launch" });
    await repository.appendMessage({ chatId: chat.id, role: "user", content: "First message", eventIndex: 0 });

    const pageData = await getChatsForPage();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(pageData.chats).toEqual([
      expect.objectContaining({
        id: chat.id,
        title: "Plan the launch",
        agentName: "Research Eve",
        lastMessage: "First message",
      }),
    ]);

    render(React.createElement(ChatList, pageData));

    expect(screen.getByRole("heading", { name: "Chats" })).toBeInTheDocument();
    expect(screen.getByText("Plan the launch")).toBeInTheDocument();
    expect(screen.getAllByText("Research Eve").length).toBeGreaterThan(0);
    expect(screen.getAllByText("First message").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Open Plan the launch" })).toHaveAttribute("href", `/chats/${chat.id}`);
  });
});

describe("ChatList", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    pushMock.mockReset();
  });

  it("start chat form selects healthy agent, submits first message to POST /api/chats, and navigates to /chats/:chatId", async () => {
    const chats: ChatListSummary[] = [];
    const agents: ChatListAgent[] = [
      { id: "agent_healthy", name: "Healthy Eve", status: "healthy" },
      { id: "agent_unknown", name: "Unknown Eve", status: "unknown" },
      { id: "agent_unreachable", name: "Down Eve", status: "unreachable" },
    ];
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          chat: {
            id: "chat_created",
            agentConnectionId: "agent_healthy",
            title: "Hello Eve",
            status: "active",
            sessionState: { sessionId: "session_1", streamIndex: 1 },
            createdAt: "2026-07-10T00:00:00.000Z",
            updatedAt: "2026-07-10T00:00:00.000Z",
          },
          messages: [],
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(React.createElement(ChatList, { chats, agents }));

    const agentSelect = screen.getByLabelText("Agent");
    expect(agentSelect).toHaveValue("agent_healthy");
    expect(screen.getByRole("option", { name: "Healthy Eve" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Unknown Eve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Down Eve" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("First message"), { target: { value: "Hello Eve" } });
    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chats",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "agent_healthy", message: "Hello Eve" }),
      }),
    );
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/chats/chat_created"));
  });
});

describe("ChatThread", () => {
  let testDb: TestDbHandle;

  beforeEach(() => {
    testDb = createTestDbHandle();
    setDbClientForTests(testDb.db);
  });

  afterEach(() => {
    setDbClientForTests(null);
    testDb.close();
    vi.restoreAllMocks();
    pushMock.mockReset();
  });

  it("renders a chat thread and sends a follow-up to POST /api/chats/:chatId/messages, appending response messages", async () => {
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Thread Eve",
      baseUrl: "https://thread-eve.example.com",
      authType: "none",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({ agentConnectionId: agent.id, title: "Existing chat" });
    await repository.appendMessage({ chatId: chat.id, role: "user", content: "Hi", eventIndex: 0 });
    await repository.appendMessage({ chatId: chat.id, role: "assistant", content: "Hello from Eve", eventIndex: 1 });

    const pageData = await getChatThreadForPage(chat.id);

    expect(pageData).not.toBeNull();
    if (!pageData) {
      throw new Error("Expected chat thread page data");
    }

    expect(pageData).toEqual(
      expect.objectContaining({
        chat: expect.objectContaining({ id: chat.id, title: "Existing chat", agentName: "Thread Eve" }),
        messages: [
          expect.objectContaining({ role: "user", content: "Hi" }),
          expect.objectContaining({ role: "assistant", content: "Hello from Eve" }),
        ],
      }),
    );

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          chat: { ...pageData.chat, updatedAt: "2026-07-10T01:00:00.000Z" },
          messages: [
            ...pageData.messages,
            {
              id: "msg_followup",
              chatId: chat.id,
              role: "user",
              content: "What next?",
              eventIndex: 2,
              createdAt: "2026-07-10T01:00:00.000Z",
            },
            {
              id: "msg_answer",
              chatId: chat.id,
              role: "assistant",
              content: "Next, ship it.",
              eventIndex: 3,
              createdAt: "2026-07-10T01:00:01.000Z",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(React.createElement(ChatThread, pageData));

    expect(screen.getByRole("heading", { name: "Existing chat" })).toBeInTheDocument();
    expect(screen.getAllByText("Thread Eve").length).toBeGreaterThan(0);
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("Hi")).toBeInTheDocument();
    expect(screen.getByText("Hello from Eve")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "What next?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/chats/${chat.id}/messages`,
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "What next?" }),
      }),
    );
    expect(await screen.findByText("Next, ship it.")).toBeInTheDocument();
  });

  it("does not allow changing the agent inside an existing chat", () => {
    const chat: ChatThreadSummary = {
      id: "chat_static_agent",
      agentConnectionId: "agent_static",
      agentName: "Static Eve",
      title: "Static thread",
      status: "active",
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    };
    const messages: ChatThreadMessage[] = [];

    render(React.createElement(ChatThread, { chat, messages }));

    expect(screen.getByText("Static Eve")).toBeInTheDocument();
    expect(screen.queryByLabelText("Agent")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});
