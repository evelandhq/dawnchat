import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ChatThread, type ChatThreadMessage, type ChatThreadSummary } from "@/components/chat-thread";
import { getChatThreadForPage } from "@/app/chats/[chatId]/page";
import { createRepository } from "@/db/repository";
import { setDbClientForTests } from "@/db/provider";
import { createTestDbHandle, type TestDbHandle } from "@/test/db";

const refreshMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: refreshMock,
  }),
}));

describe("ChatThread", () => {
  let testDb: TestDbHandle;

  beforeEach(async () => {
    testDb = await createTestDbHandle();
    setDbClientForTests(testDb.db);
  });

  afterEach(async () => {
    setDbClientForTests(null);
    await testDb.close();
    vi.restoreAllMocks();
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

    expect(screen.queryByRole("heading", { name: "Existing chat" })).not.toBeInTheDocument();
    expect(screen.queryByText("Thread Eve")).not.toBeInTheDocument();
    expect(screen.queryByText("active")).not.toBeInTheDocument();
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

  it("consumes a streaming NDJSON response and renders the assistant reply", async () => {
    const repository = createRepository(testDb.db);
    const agent = await repository.createAgentConnection({
      name: "Stream Eve",
      baseUrl: "https://stream-eve.example.com",
      authType: "none",
    });
    await repository.updateAgentHealth(agent.id, { status: "healthy" });
    const chat = await repository.createChat({ agentConnectionId: agent.id, title: "Streaming chat" });

    const pageData = await getChatThreadForPage(chat.id);
    if (!pageData) {
      throw new Error("Expected chat thread page data");
    }

    const doneChat = { ...pageData.chat, updatedAt: "2026-07-12T00:00:01.000Z" };
    const ndjson = `${[
      JSON.stringify({ type: "delta", message: "Str" }),
      JSON.stringify({ type: "delta", message: "Streamed reply" }),
      JSON.stringify({ type: "message", message: "Streamed reply" }),
      JSON.stringify({
        type: "done",
        chat: doneChat,
        messages: [
          { id: "msg_user", chatId: chat.id, role: "user", content: "Stream please", eventIndex: 1, createdAt: "2026-07-12T00:00:00.000Z" },
          { id: "msg_reply", chatId: chat.id, role: "assistant", content: "Streamed reply", eventIndex: 2, createdAt: "2026-07-12T00:00:01.000Z" },
        ],
      }),
    ].join("\n")}\n`;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(ndjson, { status: 200, headers: { "content-type": "application/x-ndjson" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(React.createElement(ChatThread, pageData));

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Stream please" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Streamed reply")).toBeInTheDocument();
    expect(screen.getByText("Stream please")).toBeInTheDocument();
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

    expect(screen.queryByText("Static Eve")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Agent")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});
