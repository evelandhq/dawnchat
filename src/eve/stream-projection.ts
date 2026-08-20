import { turnIdFromEvent } from "@/eve/proxy-contract";

/**
 * Compatibility for chats persisted before the proxy stopped storing deltas:
 * their streams hold a run of `*.appended` events that each carry the whole
 * text so far, storing the same message about N times over.
 *
 * The message projection replaces a streaming part with the next value for the
 * same run, so only the last delta of a run can affect the result, and a
 * completed run drops its deltas entirely. Collapsing them here leaves the
 * browser's projection identical while it reads a fraction of the bytes. New
 * chats never store deltas (see `persistEvent` in eve-proxy), so this filter
 * passes their streams through untouched.
 */
const DELTA_COMPLETIONS: Record<string, string> = {
  "message.appended": "message.completed",
  "reasoning.appended": "reasoning.completed",
};

const COMPLETED_DELTAS: Record<string, string> = {
  "message.completed": "message.appended",
  "reasoning.completed": "reasoning.appended",
};

type EventLike = { type: string; payload: unknown };

export function collapseStreamedDeltas<T extends EventLike>(
  events: readonly T[],
): T[] {
  const supersededRuns = new Set<string>();
  const lastDeltaIndex = new Map<string, number>();

  events.forEach((event, index) => {
    if (COMPLETED_DELTAS[event.type]) {
      const key = runKey(event.type, event.payload);
      // A completion that retracts its text removes the streaming part rather
      // than replacing it, and only marks the message complete when a part was
      // there to remove. That run keeps its last delta so the projection still
      // has one.
      if (retractsText(event.payload)) supersededRuns.delete(key);
      else supersededRuns.add(key);
      return;
    }
    if (DELTA_COMPLETIONS[event.type]) {
      lastDeltaIndex.set(runKey(event.type, event.payload), index);
    }
  });

  return events.filter((event, index) => {
    if (!DELTA_COMPLETIONS[event.type]) return true;
    const key = runKey(event.type, event.payload);
    // A run Eve finished needs none of its deltas; an unfinished one needs only
    // its newest, which already carries every earlier delta's text.
    return !supersededRuns.has(key) && lastDeltaIndex.get(key) === index;
  });
}

function retractsText(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== "object") return false;
  return (data as { message?: unknown }).message === null;
}

function runKey(type: string, payload: unknown): string {
  const run = DELTA_COMPLETIONS[type] ? type : COMPLETED_DELTAS[type];
  return `${run}:${turnIdFromEvent(payload) ?? ""}:${stepIndexFromEvent(payload)}`;
}

function stepIndexFromEvent(payload: unknown): number {
  if (!payload || typeof payload !== "object") return 0;
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== "object") return 0;
  const stepIndex = (data as { stepIndex?: unknown }).stepIndex;
  return typeof stepIndex === "number" && Number.isFinite(stepIndex)
    ? stepIndex
    : 0;
}
