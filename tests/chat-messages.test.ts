import { describe, expect, it } from "vitest";

import {
  deserializePendingUserContent,
  promptMessageToUserContent,
  serializePendingUserContent,
} from "@/lib/chat-messages";

describe("chat messages", () => {
  it("converts prompt attachments into Eve user content", () => {
    expect(
      promptMessageToUserContent({
        text: "  Review this  ",
        files: [
          {
            filename: "report.txt",
            mediaType: "text/plain",
            url: "data:text/plain;base64,aGVsbG8=",
          },
        ],
      }),
    ).toEqual([
      { type: "text", text: "Review this" },
      {
        type: "file",
        data: "data:text/plain;base64,aGVsbG8=",
        filename: "report.txt",
        mediaType: "text/plain",
      },
    ]);
  });

  it("round-trips structured content and reserved-prefix text", () => {
    const content = [
      {
        type: "file" as const,
        data: "data:text/plain;base64,aGVsbG8=",
        filename: "report.txt",
        mediaType: "text/plain",
      },
    ];
    const reservedText = "eve-chats:user-content:v1:not-structured-content";

    expect(deserializePendingUserContent(serializePendingUserContent(content))).toEqual(content);
    expect(
      deserializePendingUserContent(serializePendingUserContent(reservedText)),
    ).toBe(reservedText);
  });
});
