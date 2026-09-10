import { turnIdFromEvent } from "@/eve/proxy-contract";

/**
 * Compatibility for chats persisted before the proxy stopped storing deltas:
 * their v24 streams hold a run of `*.appended` events that each carry the
 * whole text so far, storing the same message about N times over.
 *
 * Under v24 semantics, only the last cumulative snapshot of an unfinished run
 * affects the result, and a completed run needs none of its snapshots.
 * Collapsing those events here leaves the browser's projection identical while
 * it reads a fraction of the bytes. The retained cumulative event is normalized
 * into one v25 delta containing the whole run. Current delta-only events are
 * never collapsed because each one is required to reconstruct its run. New
 * chats never store deltas (see `persistEvent` in eve-proxy), so this filter
 * normally passes them through.
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
    if (
      DELTA_COMPLETIONS[event.type] &&
      legacySnapshot(event.type, event.payload) !== undefined
    ) {
      lastDeltaIndex.set(runKey(event.type, event.payload), index);
    }
  });

  return events.flatMap((event, index) => {
    const snapshot = legacySnapshot(event.type, event.payload);
    if (!DELTA_COMPLETIONS[event.type] || snapshot === undefined) return [event];
    const key = runKey(event.type, event.payload);
    // A run Eve finished needs none of its deltas; an unfinished one needs only
    // its newest cumulative snapshot, normalized into one current delta.
    return !supersededRuns.has(key) && lastDeltaIndex.get(key) === index
      ? [normalizeLegacyDelta(event, snapshot)]
      : [];
  });
}

function legacySnapshot(type: string, payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const field = type === "message.appended"
    ? "messageSoFar"
    : type === "reasoning.appended"
      ? "reasoningSoFar"
      : undefined;
  if (!field) return undefined;
  const snapshot = (data as Record<string, unknown>)[field];
  return typeof snapshot === "string" ? snapshot : undefined;
}

function normalizeLegacyDelta<T extends EventLike>(event: T, snapshot: string): T {
  const payload = event.payload as {
    data: Record<string, unknown>;
  } & Record<string, unknown>;
  if (event.type === "message.appended") {
    const { messageSoFar: _messageSoFar, ...data } = payload.data;
    return {
      ...event,
      payload: { ...payload, data: { ...data, messageDelta: snapshot } },
    };
  }
  const { reasoningSoFar: _reasoningSoFar, ...data } = payload.data;
  return {
    ...event,
    payload: { ...payload, data: { ...data, reasoningDelta: snapshot } },
  };
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
