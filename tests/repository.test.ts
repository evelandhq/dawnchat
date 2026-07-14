import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createRepository, DuplicateAgentUrlError } from "@/db/repository";
import type { DbClient } from "@/db/client";
import { chats, events, messages } from "@/db/schema";
import { createTestDbHandle, type TestDbHandle } from "@/test/db";

describe("repository", () => {
  let testDb: TestDbHandle;
  let db: DbClient;

  beforeEach(async () => {
    testDb = await createTestDbHandle();
    db = testDb.db;
  });

  afterEach(async () => {
    await testDb.close();
  });

  it("creates and lists agent connections", async () => {
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

  it("rejects duplicate agent URLs", async () => {
    const repository = createRepository(db);
    const baseUrl = "https://duplicate.example.com";

    await repository.createAgentConnection({
      name: "First Agent",
      baseUrl,
      authType: "none",
    });

    await expect(
      repository.createAgentConnection({
        name: "Second Agent",
        baseUrl,
        authType: "bearer",
        authConfigEncrypted: "encrypted-token",
      }),
    ).rejects.toThrow();
    await expect(repository.listAgentConnections()).resolves.toHaveLength(1);
  });

  it("returns null for a missing agent connection", async () => {
    const repository = createRepository(db);

    await expect(repository.getAgentConnection("agent_missing")).resolves.toBeNull();
  });

  it("updates agent connection details without changing its identity", async () => {
    const repository = createRepository(db);
    const created = await repository.createAgentConnection({
      name: "Old Agent",
      baseUrl: "https://old.example.com",
      authType: "none",
    });
    await repository.updateAgentHealth(created.id, {
      status: "healthy",
      lastCheckedAt: new Date("2026-07-14T01:00:00.000Z"),
    });

    const updated = await repository.updateAgentConnection(created.id, {
      name: "New Agent",
      baseUrl: "https://new.example.com",
      authType: "bearer",
      authConfigEncrypted: "encrypted-token",
    });

    expect(updated).toMatchObject({
      id: created.id,
      name: "New Agent",
      baseUrl: "https://new.example.com",
      authType: "bearer",
      authConfigEncrypted: "encrypted-token",
      status: "unknown",
      lastCheckedAt: null,
      createdAt: created.createdAt,
    });
  });

  it("rejects an update to another agent URL", async () => {
    const repository = createRepository(db);
    const first = await repository.createAgentConnection({
      name: "First",
      baseUrl: "https://first.example.com",
      authType: "none",
    });
    await repository.createAgentConnection({
      name: "Second",
      baseUrl: "https://second.example.com",
      authType: "none",
    });

    await expect(
      repository.updateAgentConnection(first.id, {
        name: "First",
        baseUrl: "https://second.example.com",
        authType: "none",
        authConfigEncrypted: null,
      }),
    ).rejects.toBeInstanceOf(DuplicateAgentUrlError);
  });

  it("returns missing results for unknown agent mutations", async () => {
    const repository = createRepository(db);

    await expect(
      repository.updateAgentConnection("agent_missing", {
        name: "Missing",
        baseUrl: "https://missing.example.com",
        authType: "none",
        authConfigEncrypted: null,
      }),
    ).resolves.toBeNull();
    await expect(repository.deleteAgentConnection("agent_missing")).resolves.toBe(false);
  });

  it("deletes an agent connection and cascades its chat data", async () => {
    const repository = createRepository(db);
    const agent = await repository.createAgentConnection({
      name: "Disposable",
      baseUrl: "https://disposable.example.com",
      authType: "none",
    });
    const chat = await repository.createChat({
      agentConnectionId: agent.id,
      title: "Delete me",
    });
    await repository.appendEvent({
      chatId: chat.id,
      eventIndex: 0,
      type: "message.completed",
      payload: { message: "gone" },
    });
    await db.insert(messages).values({
      id: "msg_delete_test",
      chatId: chat.id,
      role: "user",
      content: "gone",
      eventIndex: 0,
      createdAt: new Date(),
    });

    await expect(repository.deleteAgentConnection(agent.id)).resolves.toBe(true);
    await expect(repository.getAgentConnection(agent.id)).resolves.toBeNull();
    await expect(db.select().from(chats)).resolves.toEqual([]);
    await expect(db.select().from(messages)).resolves.toEqual([]);
    await expect(db.select().from(events)).resolves.toEqual([]);
  });

  it("updates agent health independently of connection details", async () => {
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
    const repository = createRepository(db);

    await expect(repository.updateAgentHealth("agent_missing", { status: "healthy" })).rejects.toThrow(
      "Agent connection not found",
    );
    await expect(
      repository.updateChatSessionState("chat_missing", { sessionId: "session-123" }),
    ).rejects.toThrow("Chat not found");
  });

  it("stores chat session state separately from raw Eve event history", async () => {
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

    const firstEvent = await repository.appendEvent({
      chatId: chat.id,
      eventIndex: 0,
      type: "message.received",
      payload: { type: "message.received", data: { message: "Hello" } },
    });
    const secondEvent = await repository.appendEvent({
      chatId: chat.id,
      eventIndex: 1,
      type: "message.completed",
      payload: { type: "message.completed", data: { message: "Hi there" } },
    });

    const state = { sessionId: "session-123", continuationToken: "continue-456", streamIndex: 2 };
    const updatedChat = await repository.updateChatSessionState(chat.id, state);

    expect(updatedChat.sessionState).toEqual(state);
    await expect(repository.getChat(chat.id)).resolves.toMatchObject({
      id: chat.id,
      sessionState: state,
    });
    await expect(repository.listEvents(chat.id)).resolves.toEqual([firstEvent, secondEvent]);
  });

  it("deduplicates replayed remote events by session cursor", async () => {
    const repository = createRepository(db);
    const agent = await repository.createAgentConnection({
      name: "Support Agent",
      baseUrl: "https://support.example.com",
      authType: "none",
    });
    const chat = await repository.createChat({ agentConnectionId: agent.id, title: "Replay" });
    const eventInput = {
      chatId: chat.id,
      sessionId: "ses_1",
      streamIndex: 0,
      type: "message.received",
      payload: { type: "message.received", data: { message: "First" } },
    } as const;

    const first = await repository.appendEvent(eventInput);
    const replay = await repository.appendEvent(eventInput);

    expect(replay).toEqual(first);
    await expect(repository.listEvents(chat.id)).resolves.toEqual([first]);
  });

  it("fails fast on corrupted stored chat session state", async () => {
    const repository = createRepository(db);
    const agent = await repository.createAgentConnection({
      name: "Support Agent",
      baseUrl: "https://support.example.com",
      authType: "none",
    });
    const chat = await repository.createChat({ agentConnectionId: agent.id, title: "Corrupt state" });

    await db
      .update(chats)
      .set({ sessionStateJson: JSON.stringify({ continuationToken: "missing-session-id" }) })
      .where(eq(chats.id, chat.id));

    await expect(repository.getChat(chat.id)).rejects.toThrow("Stored chat session state is invalid");
  });
});
