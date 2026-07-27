import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { eq } from "drizzle-orm";

import ChatsPage from "@/app/chats/page";
import HomePage from "@/app/page";
import { setDbClientForTests } from "@/db/provider";
import { createRepository } from "@/db/repository";
import { agentConnections, chats } from "@/db/schema";
import { createTestDbHandle, type TestDbHandle } from "@/test/db";

const { redirectMock, redirectSentinel } = vi.hoisted(() => {
  const sentinel = new Error("TEST_REDIRECT_SENTINEL");

  return {
    redirectSentinel: sentinel,
    redirectMock: vi.fn(() => {
      throw sentinel;
    }),
  };
});

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

describe("app routing", () => {
  let testDb: TestDbHandle;

  beforeEach(async () => {
    redirectMock.mockClear();
    testDb = await createTestDbHandle();
    setDbClientForTests(testDb.db);
  });

  afterEach(async () => {
    setDbClientForTests(null);
    await testDb.close();
  });

  it("redirects / to the first catalog agent without reading global chat history", async () => {
    const repository = createRepository(testDb.db);
    const olderAgent = await repository.createAgentConnection({
      name: "Older chat agent",
      baseUrl: "https://older-chat.example.com",
      authType: "none",
    });
    const newerAgent = await repository.createAgentConnection({
      name: "Newer chat agent",
      baseUrl: "https://newer-chat.example.com",
      authType: "none",
    });
    const olderChat = await repository.createChat({
      agentConnectionId: olderAgent.id,
      title: "Older chat",
    });
    const newerChat = await repository.createChat({
      agentConnectionId: newerAgent.id,
      title: "Newer chat",
    });

    await testDb.db
      .update(chats)
      .set({ createdAt: new Date("2026-01-01T00:00:00.000Z") })
      .where(eq(chats.id, olderChat.id));
    await testDb.db
      .update(chats)
      .set({ createdAt: new Date("2026-01-02T00:00:00.000Z") })
      .where(eq(chats.id, newerChat.id));

    expect((await repository.listChats()).map((chat) => chat.id)).toEqual([olderChat.id, newerChat.id]);
    await expect(HomePage()).rejects.toBe(redirectSentinel);
    expect(redirectMock).toHaveBeenCalledOnce();
    expect(redirectMock).toHaveBeenCalledWith(`/agents/${olderAgent.id}`);
  });

  it("redirects / to the first-created agent when there are agents but no chats", async () => {
    const repository = createRepository(testDb.db);
    const firstAgent = await repository.createAgentConnection({
      name: "First agent",
      baseUrl: "https://first-agent.example.com",
      authType: "none",
    });
    const secondAgent = await repository.createAgentConnection({
      name: "Second agent",
      baseUrl: "https://second-agent.example.com",
      authType: "none",
    });

    await testDb.db
      .update(agentConnections)
      .set({ createdAt: new Date("2026-01-01T00:00:00.000Z") })
      .where(eq(agentConnections.id, firstAgent.id));
    await testDb.db
      .update(agentConnections)
      .set({ createdAt: new Date("2026-01-02T00:00:00.000Z") })
      .where(eq(agentConnections.id, secondAgent.id));

    expect((await repository.listAgentConnections()).map((agent) => agent.id)).toEqual([
      firstAgent.id,
      secondAgent.id,
    ]);
    await expect(HomePage()).rejects.toBe(redirectSentinel);
    expect(redirectMock).toHaveBeenCalledOnce();
    expect(redirectMock).toHaveBeenCalledWith(`/agents/${firstAgent.id}`);
  });

  it("renders onboarding at / when there are no agents", async () => {
    render(await HomePage());

    expect(redirectMock).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Welcome to EveChats" })).toBeInTheDocument();
    expect(screen.getByText("Connect your first Eve agent to start chatting.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect an agent" })).toHaveAttribute("href", "/agents/new");
  });

  it("redirects /chats to / and terminates rendering", () => {
    expect(() => ChatsPage()).toThrow(redirectSentinel);
    expect(redirectMock).toHaveBeenCalledOnce();
    expect(redirectMock).toHaveBeenCalledWith("/");
  });
});
