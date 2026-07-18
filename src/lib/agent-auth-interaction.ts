import type { InputResponse } from "eve/client";
import type { UserContent } from "ai";

export type PendingAgentTurn = {
  message?: string | UserContent;
  inputResponses?: readonly InputResponse[];
};

type StorageLike = Pick<Storage, "getItem" | "removeItem" | "setItem">;

type RouteAuthInteraction = { type: "redirect"; url: string };

export function agentAuthInteractionFromError(error: unknown): RouteAuthInteraction | null {
  if (
    typeof error !== "object"
    || error === null
    || !("status" in error)
    || error.status !== 401
    || !("body" in error)
    || typeof error.body !== "string"
  ) return null;
  try {
    const body = JSON.parse(error.body) as {
      code?: unknown;
      interaction?: { type?: unknown; url?: unknown };
    };
    if (
      body.code !== "interaction_required"
      || body.interaction?.type !== "redirect"
      || typeof body.interaction.url !== "string"
      || !/^\/api\/agents\/agent_[a-f0-9]{16}\/auth\/oidc\/start\?/.test(body.interaction.url)
    ) return null;
    return { type: "redirect", url: body.interaction.url };
  } catch {
    return null;
  }
}

export function handleAgentAuthInteraction(input: {
  chatId: string;
  error: unknown;
  redirect(url: string): void;
  storage: StorageLike;
  turn: PendingAgentTurn | null;
}): boolean {
  if (input.turn === null) return false;
  const interaction = agentAuthInteractionFromError(input.error);
  if (!interaction) return false;
  try {
    input.storage.setItem(storageKey(input.chatId), JSON.stringify({ version: 1, turn: input.turn }));
  } catch {
    return false;
  }
  input.redirect(interaction.url);
  return true;
}

export function claimPendingAgentTurn(storage: StorageLike, chatId: string): PendingAgentTurn | null {
  const key = storageKey(chatId);
  const serialized = storage.getItem(key);
  if (!serialized) return null;
  storage.removeItem(key);
  try {
    const value = JSON.parse(serialized) as { version?: unknown; turn?: unknown };
    if (value.version !== 1 || !isPendingAgentTurn(value.turn)) return null;
    return value.turn;
  } catch {
    return null;
  }
}

function isPendingAgentTurn(value: unknown): value is PendingAgentTurn {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const turn = value as Record<string, unknown>;
  const hasMessage = typeof turn.message === "string" || Array.isArray(turn.message);
  const hasInputResponses = Array.isArray(turn.inputResponses) && turn.inputResponses.length > 0;
  return hasMessage || hasInputResponses;
}

function storageKey(chatId: string): string {
  return `eve-chats:pending-agent-auth:${chatId}`;
}
