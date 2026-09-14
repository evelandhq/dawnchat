import { describe, expect, it } from "vitest";

import { namespaceTurnIds, namespacedTurnId, rawTurnId } from "@/eve/turn-namespace";

describe("turn namespace", () => {
  it("prefixes turn ids with the session generation, once", () => {
    expect(namespacedTurnId("turn_0", 1)).toBe("g1:turn_0");
    expect(namespacedTurnId("g1:turn_0", 1)).toBe("g1:turn_0");
    expect(namespacedTurnId("turn_0", undefined)).toBe("turn_0");
    expect(namespacedTurnId("turn_0", 0)).toBe("turn_0");
  });

  it("strips the prefix for Eve and leaves plain ids alone", () => {
    expect(rawTurnId("g3:turn_7")).toBe("turn_7");
    expect(rawTurnId("turn_7")).toBe("turn_7");
  });

  it("rewrites data.turnId on any event of a replacement session and nothing else", () => {
    const received = {
      type: "message.received" as const,
      data: { message: "hi", sequence: 0, turnId: "turn_0" },
    };
    expect(namespaceTurnIds(received as never, 2)).toEqual({
      type: "message.received",
      data: { message: "hi", sequence: 0, turnId: "g2:turn_0" },
    });
    expect(namespaceTurnIds(received as never, undefined)).toBe(received);
    const waiting = { type: "session.waiting" as const, data: { wait: "next-user-message" } };
    expect(namespaceTurnIds(waiting as never, 2)).toBe(waiting);
  });
});
