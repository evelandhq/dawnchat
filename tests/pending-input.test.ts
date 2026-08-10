import { describe, expect, it } from "vitest";

import {
  derivePendingInput,
  parsePendingInput,
  serializePendingInput,
  settlePendingInput,
  type PendingInputState,
  type StoredChatEvent,
} from "@/eve/proxy-contract";

let nextIndex = 1;

function event(
  type: string,
  payload: unknown,
  options: { sessionId?: string | null } = {},
): StoredChatEvent {
  return {
    eventIndex: nextIndex++,
    sessionId: options.sessionId === undefined ? "ses_1" : options.sessionId,
    type,
    payload,
  };
}

function inputRequested(
  requests: Array<{ requestId: string; kind?: string; callId?: string }>,
  options: { sessionId?: string | null } = {},
): StoredChatEvent {
  return event(
    "input.requested",
    {
      type: "input.requested",
      data: {
        requests: requests.map((request) => ({
          requestId: request.requestId,
          ...(request.kind ? { kind: request.kind } : {}),
          prompt: "?",
          action: {
            kind: "tool-call",
            callId: request.callId ?? request.requestId,
            toolName: "ask",
            input: {},
          },
        })),
      },
    },
    options,
  );
}

function responded(requestIds: string[]): StoredChatEvent {
  return event(
    "client.input.responded",
    {
      type: "client.input.responded",
      data: {
        createdAt: 1,
        responses: requestIds.map((requestId) => ({ requestId, optionId: "approve" })),
      },
    },
    { sessionId: null },
  );
}

function actionResult(callId: string): StoredChatEvent {
  return event("action.result", {
    type: "action.result",
    data: {
      result: { kind: "tool-result", callId, toolName: "ask", output: {} },
      status: "completed",
    },
  });
}

function derive(events: StoredChatEvent[], overrides: Partial<{ sessionId: string | null; active: boolean }> = {}): PendingInputState {
  return derivePendingInput({
    events,
    sessionId: overrides.sessionId === undefined ? "ses_1" : overrides.sessionId,
    active: overrides.active ?? true,
  });
}

describe("legacy pending-input derivation", () => {
  it("derives an unanswered required batch at the tail as open", () => {
    nextIndex = 1;
    const events = [
      inputRequested([{ requestId: "req_1", kind: "tool-approval" }]),
      event("session.waiting", { type: "session.waiting", data: {} }),
    ];
    expect(derive(events).batches).toEqual([
      expect.objectContaining({ eventIndex: 1, answered: [] }),
    ]);
  });

  it("derives a required batch closed when a stored response covers it", () => {
    nextIndex = 1;
    const events = [
      inputRequested([{ requestId: "req_1", kind: "tool-approval" }]),
      responded(["req_1"]),
    ];
    expect(derive(events).batches).toEqual([]);
  });

  it("derives an approval closed when its action later resolved", () => {
    nextIndex = 1;
    const events = [
      inputRequested([{ requestId: "req_1", kind: "tool-approval", callId: "call_1" }]),
      actionResult("call_1"),
    ];
    expect(derive(events).batches).toEqual([]);
  });

  it("keeps a required batch open across later turn activity", () => {
    nextIndex = 1;
    const events = [
      inputRequested([{ requestId: "req_1", kind: "tool-approval" }]),
      // A re-parked required batch emits boundaries without resolving (R2).
      event("turn.started", { type: "turn.started", data: {} }),
      event("turn.completed", { type: "turn.completed", data: {} }),
    ];
    expect(derive(events).batches).toHaveLength(1);
  });

  it("derives a dismissable batch at the stream tail as open", () => {
    nextIndex = 1;
    const events = [inputRequested([{ requestId: "req_q", kind: "question" }])];
    expect(derive(events).batches).toHaveLength(1);
  });

  it("derives a dismissable batch closed once a later turn moved past it", () => {
    nextIndex = 1;
    const events = [
      inputRequested([{ requestId: "req_q", kind: "question" }]),
      event("turn.started", { type: "turn.started", data: {} }),
    ];
    expect(derive(events).batches).toEqual([]);
  });

  it("does not let one park's request close another still-open park", () => {
    nextIndex = 1;
    // Concurrent subagent parks stack without boundaries between them; the
    // second batch's request proves nothing about the first.
    const events = [
      inputRequested([{ requestId: "req_a", kind: "question" }]),
      inputRequested([{ requestId: "req_b", kind: "question" }]),
    ];
    expect(derive(events).batches).toHaveLength(2);
  });

  it("ignores batches from a replaced session", () => {
    nextIndex = 1;
    const events = [
      inputRequested([{ requestId: "req_old", kind: "tool-approval" }], {
        sessionId: "ses_dead",
      }),
      inputRequested([{ requestId: "req_new", kind: "question" }]),
    ];
    const derived = derive(events);
    expect(derived.batches).toHaveLength(1);
    expect(derived.batches[0]?.requests[0]?.requestId).toBe("req_new");
  });

  it("derives nothing after a cancel boundary or for an inactive chat", () => {
    nextIndex = 1;
    const cancelled = [
      inputRequested([{ requestId: "req_1", kind: "tool-approval" }]),
      event("turn.cancelled", { type: "turn.cancelled", data: {} }),
    ];
    expect(derive(cancelled).batches).toEqual([]);

    nextIndex = 1;
    const parked = [inputRequested([{ requestId: "req_1", kind: "tool-approval" }])];
    expect(derive(parked, { active: false }).batches).toEqual([]);
    expect(derive(parked, { sessionId: null }).batches).toEqual([]);
  });

  it("classifies requests predating `kind` by their shape, not their action", () => {
    // Old questions and approvals both carry an action.callId; display and
    // options are what their emitters actually differed on.
    const kindOf = (request: Record<string, unknown>): string | undefined => {
      nextIndex = 1;
      const derived = derive([
        event("input.requested", {
          type: "input.requested",
          data: { requests: [{ requestId: "req_1", ...request }] },
        }),
      ]);
      return derived.batches[0]?.requests[0]?.kind;
    };
    const action = { kind: "tool-call", callId: "call_1", toolName: "delete_record", input: {} };
    const ask = { ...action, toolName: "ask_question" };

    expect(
      kindOf({
        display: "confirmation",
        options: [{ id: "approve", label: "Allow" }, { id: "deny", label: "Deny" }],
        action,
      }),
    ).toBe("tool-approval");
    expect(
      kindOf({
        display: "select",
        options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
        action: ask,
      }),
    ).toBe("question");
    expect(kindOf({ display: "text", allowFreeform: true, action: ask })).toBe("question");
    expect(kindOf({ action: ask })).toBe("question");
    // Unrecognisable shapes err required: a locked composer is answerable on
    // screen, a dismissed approval silently defers every later message.
    expect(kindOf({ action })).toBe("tool-approval");
  });
});

describe("settlePendingInput", () => {
  const parked: PendingInputState = {
    batches: [
      {
        eventIndex: 1,
        requests: [
          { requestId: "req_a", kind: "tool-approval" },
          { requestId: "req_b", kind: "question" },
        ],
        answered: [],
      },
      {
        eventIndex: 2,
        requests: [{ requestId: "req_c", kind: "question" }],
        answered: [],
      },
    ],
  };

  it("closes only the addressed batch and leaves the rest parked", () => {
    const settled = settlePendingInput(parked, [
      { requestId: "req_a", optionId: "approve" },
      { requestId: "req_b", optionId: "opt" },
    ]);
    expect(settled.batches).toEqual([parked.batches[1]]);
  });

  it("keeps an addressed required batch open until every required answer is in", () => {
    const settled = settlePendingInput(parked, [{ requestId: "req_b", optionId: "opt" }]);
    expect(settled.batches[0]).toMatchObject({ eventIndex: 1, answered: ["req_b"] });
  });

  it("closes nothing for a message-only turn", () => {
    expect(settlePendingInput(parked, [])).toEqual(parked);
  });
});

describe("pending-input serialization", () => {
  it("round-trips and treats unreadable values as legacy", () => {
    const state: PendingInputState = {
      batches: [
        {
          eventIndex: 7,
          requests: [{ requestId: "req_1", kind: "session-limit" }],
          answered: ["req_1"],
        },
      ],
    };
    expect(parsePendingInput(serializePendingInput(state))).toEqual(state);
    expect(parsePendingInput(null)).toBeNull();
    expect(parsePendingInput("not json")).toBeNull();
    expect(parsePendingInput('{"batches":[{"eventIndex":"x"}]}')).toBeNull();
  });
});
