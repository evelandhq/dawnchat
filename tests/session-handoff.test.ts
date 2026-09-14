import { describe, expect, it } from "vitest";

import {
  buildSessionHandoff,
  SESSION_HANDOFF_CLOSE,
  SESSION_HANDOFF_OPEN,
  stripHandoffText,
  stripSessionHandoff,
  withSessionHandoff,
} from "@/eve/session-handoff";

const received = (message: string, turnId = "turn_1") => ({
  type: "message.received",
  data: { message, sequence: 0, turnId },
});
const completed = (message: string, turnId = "turn_1") => ({
  type: "message.completed",
  data: { message, finishReason: "stop", sequence: 1, stepIndex: 0, turnId },
});

describe("buildSessionHandoff", () => {
  it("carries the user and assistant lines of the stored conversation, in order", () => {
    const handoff = buildSessionHandoff([
      received("My dog is Biscuit", "turn_0"),
      completed("Noted.", "turn_0"),
      received("And I like teal", "turn_1"),
      completed("Teal it is.", "turn_1"),
    ]);
    expect(handoff).not.toBeNull();
    expect(handoff!.startsWith(SESSION_HANDOFF_OPEN)).toBe(true);
    expect(handoff!.endsWith(SESSION_HANDOFF_CLOSE)).toBe(true);
    expect(handoff).toContain(
      "User: My dog is Biscuit\nAssistant: Noted.\nUser: And I like teal\nAssistant: Teal it is.",
    );
  });

  it("reads stored rows that wrap the event in `payload`", () => {
    const handoff = buildSessionHandoff([
      { id: "evt_1", payload: received("Hello there") },
      { id: "evt_2", payload: completed("Hi!") },
    ]);
    expect(handoff).toContain("User: Hello there\nAssistant: Hi!");
  });

  it("keeps one assistant line per turn: the final message supersedes tool narration", () => {
    const handoff = buildSessionHandoff([
      received("Check the weather"),
      completed("Let me look that up.", "turn_1"),
      completed("It is 21°C in Paris.", "turn_1"),
    ]);
    expect(handoff).toContain("Assistant: It is 21°C in Paris.");
    expect(handoff).not.toContain("Let me look that up.");
  });

  it("keeps the newest turns inside the budget and says older ones were omitted", () => {
    const events = [];
    for (let index = 0; index < 30; index += 1) {
      events.push(received(`question ${index}`, `turn_${index}`));
      events.push(completed(`answer ${index}`, `turn_${index}`));
    }
    const handoff = buildSessionHandoff(events, { maxTurns: 3 });
    expect(handoff).toContain("User: question 29");
    expect(handoff).toContain("User: question 27");
    expect(handoff).not.toContain("User: question 26");
    expect(handoff).toContain("Older turns were omitted");

    const bounded = buildSessionHandoff(events, { maxChars: 120 });
    expect(bounded!.length).toBeLessThan(SESSION_HANDOFF_OPEN.length + 400);
    expect(bounded).toContain("User: question 29");
  });

  it("does not nest an earlier handoff a replacement session already received", () => {
    const earlier = buildSessionHandoff([received("first"), completed("one")])!;
    const handoff = buildSessionHandoff([
      received(`${earlier}\nsecond`),
      completed("two"),
    ]);
    expect(handoff).toContain("User: second\nAssistant: two");
    expect(handoff!.split(SESSION_HANDOFF_OPEN)).toHaveLength(2);
  });

  it("returns null when nothing has been said yet", () => {
    expect(buildSessionHandoff([])).toBeNull();
    expect(buildSessionHandoff([{ type: "session.started", data: {} }])).toBeNull();
  });
});

describe("withSessionHandoff", () => {
  it("prepends the handoff as its own text part for a string or parts message", () => {
    expect(withSessionHandoff("hi", "H")).toEqual([
      { type: "text", text: "H" },
      { type: "text", text: "hi" },
    ]);
    expect(
      withSessionHandoff([{ type: "file", data: "data:x", mediaType: "text/plain" }], "H"),
    ).toEqual([
      { type: "text", text: "H" },
      { type: "file", data: "data:x", mediaType: "text/plain" },
    ]);
  });
});

describe("stripSessionHandoff", () => {
  const handoff = `${SESSION_HANDOFF_OPEN}\nUser: earlier\n${SESSION_HANDOFF_CLOSE}`;

  it("removes the handoff part and its span in the flattened message", () => {
    const event = {
      type: "message.received" as const,
      data: {
        message: `${handoff}\n\nwhat now?`,
        parts: [
          { type: "text", text: handoff },
          { type: "text", text: "what now?" },
        ],
        sequence: 0,
        turnId: "turn_0",
      },
    };
    expect(stripSessionHandoff(event as never)).toEqual({
      type: "message.received",
      data: {
        message: "what now?",
        parts: [{ type: "text", text: "what now?" }],
        sequence: 0,
        turnId: "turn_0",
      },
    });
  });

  it("leaves ordinary messages and other events alone", () => {
    const plain = received("just a question");
    expect(stripSessionHandoff(plain as never)).toBe(plain);
    const other = completed("answer");
    expect(stripSessionHandoff(other as never)).toBe(other);
  });

  it("strips only the fenced span of the text", () => {
    expect(stripHandoffText(`${handoff}\n\nkeep me`)).toBe("keep me");
    expect(stripHandoffText("no handoff here")).toBe("no handoff here");
  });
});
