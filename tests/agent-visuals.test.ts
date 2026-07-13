import { describe, expect, it } from "vitest";

import { AGENT_AVATAR_COLOR_CLASSES, agentColorClass, agentInitial } from "@/lib/agent-visuals";

describe("agentInitial", () => {
  it("uses the first character uppercased", () => {
    expect(agentInitial("data bot")).toBe("D");
  });

  it("handles CJK names", () => {
    expect(agentInitial("数据助手")).toBe("数");
  });

  it("falls back to ? for blank names", () => {
    expect(agentInitial("   ")).toBe("?");
  });
});

describe("agentColorClass", () => {
  it("is stable for the same id", () => {
    expect(agentColorClass("agent_abc")).toBe(agentColorClass("agent_abc"));
  });

  it("always returns one of the preset classes", () => {
    for (const id of ["agent_a", "agent_b", "agent_c", "agent_中文", ""]) {
      expect(AGENT_AVATAR_COLOR_CLASSES).toContain(agentColorClass(id));
    }
  });
});
