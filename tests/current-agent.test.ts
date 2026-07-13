import { describe, expect, it } from "vitest";

import { deriveCurrentAgentId, pickDefaultAgentId, type CurrentAgentChat } from "@/lib/current-agent";

const agentIds = ["agent_a", "agent_b"];
const chats: CurrentAgentChat[] = [
  { id: "chat_3", agentConnectionId: "agent_b" },
  { id: "chat_2", agentConnectionId: "agent_a" },
  { id: "chat_1", agentConnectionId: "agent_a" },
];

describe("pickDefaultAgentId", () => {
  it("prefers the agent of the most recent chat", () => {
    expect(pickDefaultAgentId(chats, agentIds)).toBe("agent_b");
  });

  it("falls back to the first agent when there are no chats", () => {
    expect(pickDefaultAgentId([], agentIds)).toBe("agent_a");
  });

  it("skips chats whose agent no longer exists", () => {
    expect(pickDefaultAgentId([{ id: "chat_x", agentConnectionId: "agent_gone" }], agentIds)).toBe("agent_a");
  });

  it("returns null when there are no agents", () => {
    expect(pickDefaultAgentId(chats, [])).toBeNull();
  });
});

describe("deriveCurrentAgentId", () => {
  it("uses the agent id from /agents/[agentId]", () => {
    expect(deriveCurrentAgentId("/agents/agent_a", chats, agentIds)).toBe("agent_a");
  });

  it("does not treat /agents/new as an agent", () => {
    expect(deriveCurrentAgentId("/agents/new", chats, agentIds)).toBe("agent_b");
  });

  it("ignores unknown agent ids in the path", () => {
    expect(deriveCurrentAgentId("/agents/agent_gone", chats, agentIds)).toBe("agent_b");
  });

  it("uses the chat's agent on /chats/[chatId]", () => {
    expect(deriveCurrentAgentId("/chats/chat_2", chats, agentIds)).toBe("agent_a");
  });

  it("falls back to the default agent elsewhere", () => {
    expect(deriveCurrentAgentId("/agents", chats, agentIds)).toBe("agent_b");
  });

  it("returns null with no agents at all", () => {
    expect(deriveCurrentAgentId("/", [], [])).toBeNull();
  });
});
