import { describe, expect, it, vi } from "vitest";

import {
  agentAuthInteractionFromError,
  claimPendingAgentTurn,
  handleAgentAuthInteraction,
} from "@/lib/agent-auth-interaction";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

describe("Agent Auth browser interaction", () => {
  it("accepts only the same-origin Agent OIDC start contract", () => {
    const url = "/api/agents/agent_1234567890abcdef/auth/oidc/start?returnPath=%2Fchats%2Fchat_1234567890abcdef";
    expect(agentAuthInteractionFromError({
      status: 401,
      body: JSON.stringify({
        code: "interaction_required",
        interaction: { type: "redirect", url },
      }),
    })).toEqual({ type: "redirect", url });

    expect(agentAuthInteractionFromError({
      status: 401,
      body: JSON.stringify({
        code: "interaction_required",
        interaction: { type: "redirect", url: "https://attacker.example.com/authorize" },
      }),
    })).toBeNull();
  });

  it("stores and claims the interrupted turn exactly once", () => {
    const storage = memoryStorage();
    const redirect = vi.fn();
    const interactionUrl = "/api/agents/agent_1234567890abcdef/auth/oidc/start?returnPath=%2Fchats%2Fchat_1234567890abcdef";
    const turn = { message: "finish this request" };

    expect(handleAgentAuthInteraction({
      chatId: "chat_1234567890abcdef",
      error: {
        status: 401,
        body: JSON.stringify({
          code: "interaction_required",
          interaction: { type: "redirect", url: interactionUrl },
        }),
      },
      redirect,
      storage,
      turn,
    })).toBe(true);
    expect(redirect).toHaveBeenCalledWith(interactionUrl);
    expect(claimPendingAgentTurn(storage, "chat_1234567890abcdef")).toEqual(turn);
    expect(claimPendingAgentTurn(storage, "chat_1234567890abcdef")).toBeNull();
  });

  it("does not redirect when the interrupted turn cannot be persisted", () => {
    const redirect = vi.fn();
    expect(handleAgentAuthInteraction({
      chatId: "chat_1234567890abcdef",
      error: {
        status: 401,
        body: JSON.stringify({
          code: "interaction_required",
          interaction: {
            type: "redirect",
            url: "/api/agents/agent_1234567890abcdef/auth/oidc/start?returnPath=%2Fchats%2Fchat_1234567890abcdef",
          },
        }),
      },
      redirect,
      storage: {
        getItem: () => null,
        removeItem: () => undefined,
        setItem: () => {
          throw new Error("quota exceeded");
        },
      },
      turn: { message: "large attachment" },
    })).toBe(false);
    expect(redirect).not.toHaveBeenCalled();
  });
});
