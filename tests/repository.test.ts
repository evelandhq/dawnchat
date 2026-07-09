import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createRepository } from "@/db/repository";
import { chats } from "@/db/schema";
import { createTestDb } from "@/test/db";

describe("repository", () => {
  it("creates and lists agent connections", async () => {
    const db = createTestDb();
    const repository = createRepository(db);

    const created = await repository.createAgentConnection({
      name: "Support Agent",
      baseUrl: "https://support.example.com",
      authType: "none",
    });

    expect(created).toMatchObject({
      name: "Support Agent",
      baseUrl: "https://support.example.com",
      authType: "none",
      authConfigEncrypted: null,
      status: "unknown",
    });
    expect(created.id).toMatch(/^agent_[a-f0-9]{16}$/);
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);

    const listed = await repository.listAgentConnections();
    expect(listed).toEqual([created]);
  });

  it("returns null for a missing agent connection", async () => {
    const db = createTestDb();
    const repository = createRepository(db);

    await expect(repository.getAgentConnection("agent_missing")).resolves.toBeNull();
  });

  it("updates agent health independently of connection details", async () => {
    const db = createTestDb();
    const repository = createRepository(db);
    const created = await repository.createAgentConnection({
      name: "Billing Agent",
      baseUrl: "https://billing.example.com",
      authType: "bearer",
      authConfigEncrypted: "encrypted-token",
    });
    const checkedAt = new Date("2026-07-09T10:11:12.000Z");

    const updated = await repository.updateAgentHealth(created.id, {
      status: "healthy",
      lastCheckedAt: checkedAt,
    });

    expect(updated).toMatchObject({
      id: created.id,
      name: "Billing Agent",
      baseUrl: "https://billing.example.com",
      authType: "bearer",
      authConfigEncrypted: "encrypted-token",
      status: "healthy",
      lastCheckedAt: checkedAt,
    });
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());

    await expect(repository.updateAgentHealth(created.id, { status: "unreachable", lastCheckedAt: null })).resolves.toMatchObject({
      id: created.id,
      status: "unreachable",
      lastCheckedAt: null,
    });
  });

  it("throws when updating missing records", async () => {
    const db = createTestDb();
    const repository = createRepository(db);

    await expect(repository.updateAgentHealth("agent_missing", { status: "healthy" })).rejects.toThrow(
      "Agent connection not found",
    );
    await expect(
      repository.updateChatSessionState("chat_missing", { sessionId: "session-123" }),
    ).rejects.toThrow("Chat not found");
  });

  it("stores chat session state separately from message history", async () => {
    const db = createTestDb();
    const repository = createRepository(db);
    const agent = await repository.createAgentConnection({
      name: "Support Agent",
      baseUrl: "https://support.example.com",
      authType: "none",
    });
    const chat = await repository.createChat({ agentConnectionId: agent.id, title: "Help me" });

    expect(chat).toMatchObject({
      agentConnectionId: agent.id,
      title: "Help me",
      sessionState: null,
      status: "active",
    });

    const firstMessage = await repository.appendMessage({
      chatId: chat.id,
      role: "user",
      content: "Hello",
      eventIndex: 0,
    });
    const secondMessage = await repository.appendMessage({
      chatId: chat.id,
      role: "assistant",
      content: "Hi there",
      eventIndex: 1,
    });

    const state = { sessionId: "session-123", continuationToken: "continue-456", streamIndex: 2 };
    const updatedChat = await repository.updateChatSessionState(chat.id, state);

    expect(updatedChat.sessionState).toEqual(state);
    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      id: chat.id,
      sessionState: state,
    });
    await expect(repository.listMessages(chat.id)).resolves.toEqual([firstMessage, secondMessage]);
  });

  it("orders indexed messages before messages without event indexes", async () => {
    const db = createTestDb();
    const repository = createRepository(db);
    const agent = await repository.createAgentConnection({
      name: "Support Agent",
      baseUrl: "https://support.example.com",
      authType: "none",
    });
    const chat = await repository.createChat({ agentConnectionId: agent.id, title: "Ordering" });

    const unindexed = await repository.appendMessage({
      chatId: chat.id,
      role: "system",
      content: "Unindexed setup",
      eventIndex: null,
    });
    const second = await repository.appendMessage({ chatId: chat.id, role: "assistant", content: "Second", eventIndex: 1 });
    const first = await repository.appendMessage({ chatId: chat.id, role: "user", content: "First", eventIndex: 0 });

    await expect(repository.listMessages(chat.id)).resolves.toEqual([first, second, unindexed]);
  });

  it("fails fast on corrupted stored chat session state", async () => {
    const db = createTestDb();
    const repository = createRepository(db);
    const agent = await repository.createAgentConnection({
      name: "Support Agent",
      baseUrl: "https://support.example.com",
      authType: "none",
    });
    const chat = await repository.createChat({ agentConnectionId: agent.id, title: "Corrupt state" });

    db.update(chats)
      .set({ sessionStateJson: JSON.stringify({ continuationToken: "missing-session-id" }) })
      .where(eq(chats.id, chat.id))
      .run();

    await expect(repository.getChat(chat.id)).rejects.toThrow("Stored chat session state is invalid");
  });
});
