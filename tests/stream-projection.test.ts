import { describe, expect, it } from "vitest";
import {
  defaultMessageReducer,
  type MessageStreamEvent,
} from "eve/client";

import { collapseStreamedDeltas } from "@/eve/stream-projection";

type StoredEvent = { type: string; payload: unknown };

let nextId = 0;

function stored(payload: { type: string; data: Record<string, unknown> }): StoredEvent {
  nextId += 1;
  const meta = { at: "2026-07-14T00:00:00.000Z", id: `evt_${String(nextId).padStart(4, "0")}` };
  return { type: payload.type, payload: { ...payload, meta } };
}

/**
 * Eve 0.70+ names a message and its text parts after the first event that adds
 * to them, so dropping deltas renames them; the ids are only render keys here.
 */
function withoutMessageIds<
  T extends { messages: readonly { id: string; parts: readonly object[] }[] },
>(data: T) {
  return {
    ...data,
    messages: data.messages.map(({ id: _id, ...message }) => ({
      ...message,
      parts: message.parts.map((part) => {
        const { id: _partId, ...rest } = part as { id?: string };
        return rest;
      }),
    })),
  };
}

function project(events: readonly StoredEvent[]) {
  const reducer = defaultMessageReducer();
  return withoutMessageIds(events.reduce(
    (data, event) => reducer.reduce(data, event.payload as MessageStreamEvent),
    reducer.initial(),
  ));
}

/** The delta run Eve emits while streaming one step's text. */
function textRun(
  turnId: string,
  stepIndex: number,
  final: string,
  { complete = true }: { complete?: boolean } = {},
): StoredEvent[] {
  const deltas = [...final].map((_, index) =>
    stored({
      type: "message.appended",
      data: {
        messageDelta: final[index],
        messageSoFar: final.slice(0, index + 1),
        stepIndex,
        turnId,
      },
    }),
  );
  return complete
    ? [
        ...deltas,
        stored({
          type: "message.completed",
          data: { message: final, finishReason: "stop", stepIndex, turnId },
        }),
      ]
    : deltas;
}

describe("collapseStreamedDeltas", () => {
  it("projects Eve 0.51 workflow tools as dynamic tool parts", () => {
    const projected = project([
      stored({ type: "step.started", data: { stepIndex: 0, turnId: "turn_1" } }),
      stored({
        type: "actions.requested",
        data: {
          actions: [
            {
              callId: "call_1",
              input: { topic: "Eve 0.51" },
              kind: "workflow-tool-call",
              toolName: "research",
            },
          ],
          stepIndex: 0,
          turnId: "turn_1",
        },
      }),
    ]);

    expect(projected.messages[0]?.parts).toEqual([
      { type: "step-start" },
      expect.objectContaining({
        input: { topic: "Eve 0.51" },
        state: "input-available",
        toolCallId: "call_1",
        toolName: "research",
        type: "dynamic-tool",
      }),
    ]);
  });

  it("drops every delta of a finished run", () => {
    const events = [
      stored({ type: "message.received", data: { message: "Hi", turnId: "turn_1" } }),
      stored({ type: "step.started", data: { stepIndex: 0, turnId: "turn_1" } }),
      ...textRun("turn_1", 0, "Hello there"),
      stored({ type: "turn.completed", data: { turnId: "turn_1" } }),
    ];

    const collapsed = collapseStreamedDeltas(events);

    expect(collapsed.filter((event) => event.type === "message.appended")).toEqual([]);
    expect(collapsed).toHaveLength(4);
    expect(project(collapsed)).toEqual(project(events));
  });

  it("keeps only the newest delta of a run still streaming", () => {
    const events = [
      stored({ type: "step.started", data: { stepIndex: 0, turnId: "turn_1" } }),
      ...textRun("turn_1", 0, "Partial answer", { complete: false }),
    ];

    const collapsed = collapseStreamedDeltas(events);
    const deltas = collapsed.filter((event) => event.type === "message.appended");

    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toEqual({
      type: "message.appended",
      payload: {
        type: "message.appended",
        data: {
          messageDelta: "Partial answer",
          stepIndex: 0,
          turnId: "turn_1",
        },
        meta: (events.at(-1)?.payload as { meta: unknown }).meta,
      },
    });
    expect(project(collapsed)).toEqual(project(events));
  });

  it("collapses each step of a multi-step turn independently", () => {
    const events = [
      stored({ type: "step.started", data: { stepIndex: 0, turnId: "turn_1" } }),
      ...textRun("turn_1", 0, "First"),
      stored({ type: "step.started", data: { stepIndex: 1, turnId: "turn_1" } }),
      ...textRun("turn_1", 1, "Second", { complete: false }),
    ];

    const collapsed = collapseStreamedDeltas(events);

    expect(collapsed.filter((event) => event.type === "message.appended")).toHaveLength(1);
    expect(project(collapsed)).toEqual(project(events));
  });

  it("collapses reasoning runs the same way", () => {
    const events = [
      stored({ type: "step.started", data: { stepIndex: 0, turnId: "turn_1" } }),
      ...[..."Thinking"].map((_, index) =>
        stored({
          type: "reasoning.appended",
          data: {
            reasoningDelta: "Thinking"[index],
            reasoningSoFar: "Thinking".slice(0, index + 1),
            stepIndex: 0,
            turnId: "turn_1",
          },
        }),
      ),
      stored({
        type: "reasoning.completed",
        data: { reasoning: "Thinking", stepIndex: 0, turnId: "turn_1" },
      }),
      ...textRun("turn_1", 0, "Answer"),
    ];

    const collapsed = collapseStreamedDeltas(events);

    expect(
      collapsed.filter((event) => event.type === "reasoning.appended"),
    ).toEqual([]);
    expect(project(collapsed)).toEqual(project(events));
  });

  it("keeps one delta when the completion retracts its text", () => {
    const events = [
      stored({ type: "step.started", data: { stepIndex: 0, turnId: "turn_1" } }),
      ...textRun("turn_1", 0, "Draft", { complete: false }),
      stored({
        type: "message.completed",
        data: { message: null, finishReason: "tool-calls", stepIndex: 0, turnId: "turn_1" },
      }),
    ];

    const collapsed = collapseStreamedDeltas(events);

    // The retraction only marks the message complete if it removes a part, so
    // dropping the whole run would leave it projected as still streaming.
    expect(
      collapsed.filter((event) => event.type === "message.appended"),
    ).toHaveLength(1);
    expect(project(collapsed)).toEqual(project(events));
  });

  it("keeps runs from concurrent turns apart and preserves order", () => {
    const events = [
      stored({ type: "step.started", data: { stepIndex: 0, turnId: "turn_1" } }),
      ...textRun("turn_1", 0, "One"),
      stored({ type: "turn.completed", data: { turnId: "turn_1" } }),
      stored({ type: "step.started", data: { stepIndex: 0, turnId: "turn_2" } }),
      ...textRun("turn_2", 0, "Two", { complete: false }),
    ];

    const collapsed = collapseStreamedDeltas(events);

    expect(collapsed.map((event) => event.type)).toEqual([
      "step.started",
      "message.completed",
      "turn.completed",
      "step.started",
      "message.appended",
    ]);
    expect(project(collapsed)).toEqual(project(events));
  });

  it("leaves a stream without deltas untouched", () => {
    const events = [
      stored({ type: "session.started", data: {} }),
      stored({ type: "message.received", data: { message: "Hi", turnId: "turn_1" } }),
      stored({
        type: "message.completed",
        data: { message: "Hello", finishReason: "stop", stepIndex: 0, turnId: "turn_1" },
      }),
    ];

    expect(collapseStreamedDeltas(events)).toEqual(events);
  });

  it("preserves every current delta when a v25 run is persisted", () => {
    const events = [
      stored({ type: "step.started", data: { stepIndex: 0, turnId: "turn_1" } }),
      stored({
        type: "message.appended",
        data: { messageDelta: "Part", stepIndex: 0, turnId: "turn_1" },
      }),
      stored({
        type: "message.appended",
        data: { messageDelta: "ial", stepIndex: 0, turnId: "turn_1" },
      }),
    ];

    expect(collapseStreamedDeltas(events)).toEqual(events);
    expect(project(collapseStreamedDeltas(events))).toEqual(project(events));
  });
});
