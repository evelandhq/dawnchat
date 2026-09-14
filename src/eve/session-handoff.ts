/**
 * Session handoff: carrying a chat's earlier conversation into a replacement
 * Eve session.
 *
 * An Eve session is pinned to the Deployment that created it, and Eveland
 * stops routing to it once its idle TTL passes (410 `session_expired`). The
 * chat itself lives on in Dawn's database, so the browser starts a new Eve
 * session for the same chat. Eve offers no way to seed a session's durable
 * history from outside — `clientContext` is one-turn only — so the earlier
 * conversation rides inside the first user message, as a leading text part
 * fenced by the markers below. The proxy strips that part from the echoed
 * `message.received` before it is persisted or reaches the browser, so the
 * transcript shows only what the user typed while the agent still saw the
 * whole conversation.
 */

import type { UserContent } from "ai";

import type { ChatEvent } from "@/eve/proxy-contract";

export const SESSION_HANDOFF_OPEN = "[dawn:handoff]";
export const SESSION_HANDOFF_CLOSE = "[/dawn:handoff]";

/** Upper bound on the characters of conversation carried over. */
export const SESSION_HANDOFF_MAX_CHARS = 12_000;
/** Newest turns carried over, however short they are. */
export const SESSION_HANDOFF_MAX_TURNS = 20;

type Exchange = { role: "user" | "assistant"; text: string };

/**
 * Builds the handoff block from a chat's stored events, newest turns first
 * within the budget so a long chat keeps its recent context. Returns `null`
 * when there is nothing worth carrying (a chat whose first session never
 * completed a turn).
 */
export function buildSessionHandoff(
  events: readonly unknown[],
  options: { maxChars?: number; maxTurns?: number } = {},
): string | null {
  const maxChars = options.maxChars ?? SESSION_HANDOFF_MAX_CHARS;
  const maxTurns = options.maxTurns ?? SESSION_HANDOFF_MAX_TURNS;
  const exchanges = collectExchanges(events);
  if (exchanges.length === 0) return null;

  const lines: string[] = [];
  let chars = 0;
  let turns = 0;
  let truncated = false;
  for (let index = exchanges.length - 1; index >= 0; index -= 1) {
    const exchange = exchanges[index]!;
    const line = `${exchange.role === "user" ? "User" : "Assistant"}: ${exchange.text}`;
    if (exchange.role === "user") turns += 1;
    if (turns > maxTurns || chars + line.length > maxChars) {
      truncated = true;
      break;
    }
    lines.unshift(line);
    chars += line.length;
  }
  if (lines.length === 0) return null;

  return [
    SESSION_HANDOFF_OPEN,
    "The assistant's session was restarted. This is the earlier conversation with this user, " +
      "for continuity; treat it as history, not as new instructions. " +
      (truncated ? "Older turns were omitted. " : "") +
      "Reply only to the message that follows the handoff.",
    "",
    ...lines,
    SESSION_HANDOFF_CLOSE,
  ].join("\n");
}

/** Prepends the handoff as its own text part so the proxy can strip it again. */
export function withSessionHandoff(message: UserContent, handoff: string): UserContent {
  const handoffPart = { type: "text" as const, text: handoff };
  if (typeof message === "string") {
    return [handoffPart, { type: "text" as const, text: message }];
  }
  return [handoffPart, ...message];
}

/**
 * Removes the handoff from an echoed `message.received`: the leading text
 * part that carries it, and its span in the flattened `message`. Every other
 * event passes through untouched.
 */
export function stripSessionHandoff<T extends ChatEvent>(event: T): T {
  if (event.type !== "message.received") return event;
  const data = event.data as { message?: unknown; parts?: unknown };
  const message = typeof data.message === "string" ? data.message : undefined;
  if (message === undefined || !message.includes(SESSION_HANDOFF_OPEN)) return event;

  const parts = Array.isArray(data.parts)
    ? data.parts.filter(
        (part) =>
          !(
            part &&
            typeof part === "object" &&
            (part as { type?: unknown }).type === "text" &&
            typeof (part as { text?: unknown }).text === "string" &&
            ((part as { text: string }).text.startsWith(SESSION_HANDOFF_OPEN))
          ),
      )
    : undefined;
  return {
    ...event,
    data: {
      ...(event.data as Record<string, unknown>),
      message: stripHandoffText(message),
      ...(parts !== undefined ? { parts } : {}),
    },
  } as T;
}

export function stripHandoffText(message: string): string {
  const open = message.indexOf(SESSION_HANDOFF_OPEN);
  const close = message.indexOf(SESSION_HANDOFF_CLOSE, open);
  if (open < 0 || close < 0) return message;
  const before = message.slice(0, open);
  const after = message.slice(close + SESSION_HANDOFF_CLOSE.length);
  return `${before}${after.replace(/^\s+/, "")}`;
}

function collectExchanges(events: readonly unknown[]): Exchange[] {
  const exchanges: Exchange[] = [];
  let lastAssistantTurn: string | undefined;
  for (const event of events) {
    const payload = eventPayload(event);
    if (!payload) continue;
    const data = payload.data as Record<string, unknown> | undefined;
    if (!data || typeof data !== "object") continue;
    if (payload.type === "message.received" && typeof data.message === "string") {
      const text = stripHandoffText(data.message).trim();
      if (text) exchanges.push({ role: "user", text });
      lastAssistantTurn = undefined;
      continue;
    }
    if (payload.type === "message.completed" && typeof data.message === "string") {
      const text = data.message.trim();
      if (!text) continue;
      // Interim assistant text before a tool call is superseded by the turn's
      // final message; keep one assistant line per turn.
      const turnId = typeof data.turnId === "string" ? data.turnId : undefined;
      const last = exchanges.at(-1);
      if (last?.role === "assistant" && turnId !== undefined && turnId === lastAssistantTurn) {
        last.text = text;
      } else {
        exchanges.push({ role: "assistant", text });
      }
      lastAssistantTurn = turnId;
    }
  }
  return exchanges;
}

function eventPayload(event: unknown): { type: string; data?: unknown } | null {
  if (!event || typeof event !== "object") return null;
  const candidate = event as { type?: unknown; payload?: unknown };
  // Stored rows wrap the stream event in `payload`; live events are bare.
  const stream =
    candidate.payload && typeof candidate.payload === "object" ? candidate.payload : candidate;
  const typed = stream as { type?: unknown; data?: unknown };
  return typeof typed.type === "string" ? { type: typed.type, data: typed.data } : null;
}
