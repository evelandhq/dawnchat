/**
 * Turn ids across replacement sessions.
 *
 * Eve numbers turns per session (`turn_0`, `turn_1`, …) and its client
 * reducer keys rendered messages by turn id alone. A chat that continues in a
 * replacement session (see session-handoff) would therefore render the new
 * session's `turn_0` over the old one's. Events of a replacement session get
 * their turn ids prefixed with the session's generation before they are
 * persisted or forwarded; the one place the browser hands a turn id back to
 * Eve — cancellation — strips it again.
 */

import type { ChatEvent } from "@/eve/proxy-contract";

const GENERATION_PREFIX = /^g(\d+):/;

export function namespacedTurnId(turnId: string, generation: number | undefined): string {
  if (!generation || GENERATION_PREFIX.test(turnId)) return turnId;
  return `g${generation}:${turnId}`;
}

/** The turn id Eve knows, without the generation prefix Dawn added. */
export function rawTurnId(turnId: string): string {
  return turnId.replace(GENERATION_PREFIX, "");
}

export function namespaceTurnIds<T extends ChatEvent>(event: T, generation: number | undefined): T {
  if (!generation) return event;
  const data = (event as { data?: unknown }).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return event;
  const turnId = (data as { turnId?: unknown }).turnId;
  if (typeof turnId !== "string") return event;
  const namespaced = namespacedTurnId(turnId, generation);
  if (namespaced === turnId) return event;
  return { ...event, data: { ...(data as Record<string, unknown>), turnId: namespaced } } as T;
}
