import { describe, expect, it } from "vitest";
import {
  defaultMessageReducer,
  type MessageStreamEvent,
} from "eve/client";

import { planChatCleanup } from "../scripts/cleanup-stream-deltas";
import { collapseStreamedDeltas } from "@/eve/stream-projection";

type SeededRow = {
  id: string;
  type: string;
  payload_json: string;
};

let nextId = 0;

function row(payload: { type: string; data: Record<string, unknown> }): SeededRow {
  nextId += 1;
  return {
    id: `evt_${String(nextId).padStart(4, "0")}`,
    type: payload.type,
    payload_json: JSON.stringify(payload),
  };
}

function project(rows: readonly SeededRow[]) {
  const reducer = defaultMessageReducer();
  let data = reducer.initial();
  const events = rows.map((item) => ({
    type: item.type,
    payload: JSON.parse(item.payload_json),
  }));
  for (const event of collapseStreamedDeltas(events)) {
    data = reducer.reduce(data, event.payload as MessageStreamEvent);
  }
  return data;
}

function textRun(turnId: string, stepIndex: number, final: string, complete = true): SeededRow[] {
  const deltas = [...final].map((_, index) =>
    row({
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
        row({
          type: "message.completed",
          data: { message: final, finishReason: "stop", stepIndex, turnId },
        }),
      ]
    : deltas;
}

describe("planChatCleanup", () => {
  it("deletes exactly the rows the read-path collapse hides", () => {
    const rows = [
      row({ type: "message.received", data: { message: "Hi", turnId: "turn_1" } }),
      row({ type: "step.started", data: { stepIndex: 0, turnId: "turn_1" } }),
      ...textRun("turn_1", 0, "Finished answer"),
      row({ type: "turn.completed", data: { turnId: "turn_1" } }),
      // A second turn that died mid-run keeps its newest delta.
      row({ type: "step.started", data: { stepIndex: 0, turnId: "turn_2" } }),
      ...textRun("turn_2", 0, "Partial", false),
    ];

    const plan = planChatCleanup("chat_1", rows);
    const remaining = rows.filter((item) => !plan.deleteIds.includes(item.id));

    // Finished run: all 15 deltas go. Unfinished run: 6 of 7 go.
    expect(plan.deltaRows).toBe("Finished answer".length + "Partial".length);
    expect(plan.deleteIds).toHaveLength("Finished answer".length + "Partial".length - 1);
    expect(
      remaining.filter((item) => item.type === "message.appended"),
    ).toHaveLength(1);
    expect(project(remaining)).toEqual(project(rows));
  });

  it("keeps the last delta of a run whose completion retracted its text", () => {
    const rows = [
      row({ type: "step.started", data: { stepIndex: 0, turnId: "turn_1" } }),
      ...textRun("turn_1", 0, "Draft", false),
      row({
        type: "message.completed",
        data: { message: null, finishReason: "tool-calls", stepIndex: 0, turnId: "turn_1" },
      }),
    ];

    const plan = planChatCleanup("chat_1", rows);
    const remaining = rows.filter((item) => !plan.deleteIds.includes(item.id));

    expect(
      remaining.filter((item) => item.type === "message.appended"),
    ).toHaveLength(1);
    expect(project(remaining)).toEqual(project(rows));
  });

  it("never plans a non-delta row for deletion", () => {
    const rows = [
      row({ type: "message.received", data: { message: "Hi", turnId: "turn_1" } }),
      ...textRun("turn_1", 0, "Answer"),
      row({ type: "input.requested", data: { requests: [], turnId: "turn_1" } }),
      row({ type: "session.waiting", data: { wait: "next-user-message" } }),
    ];

    const plan = planChatCleanup("chat_1", rows);
    const deleted = new Set(plan.deleteIds);
    const deletedTypes = new Set(
      rows.filter((item) => deleted.has(item.id)).map((item) => item.type),
    );

    expect([...deletedTypes]).toEqual(["message.appended"]);
  });
});
