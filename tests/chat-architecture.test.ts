import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("chat architecture", () => {
  it("uses Eve events and AI Elements without the legacy message transport", () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const chatApi = readFileSync(resolve(root, "src/app/api/chats/api.ts"), "utf8");
    const eveClient = readFileSync(resolve(root, "src/eve/client.ts"), "utf8");
    const repository = readFileSync(resolve(root, "src/db/repository.ts"), "utf8");

    expect(packageJson.dependencies).not.toHaveProperty("@assistant-ui/react");
    expect(packageJson.dependencies).not.toHaveProperty("@assistant-ui/react-markdown");
    expect(packageJson.dependencies?.eve).toMatch(/^0\.47\./);
    expect(existsSync(resolve(root, "src/components/assistant-ui"))).toBe(false);
    expect(existsSync(resolve(root, "src/app/api/chats/[chatId]/messages/route.ts"))).toBe(false);
    expect(chatApi).not.toMatch(/sendChatMessage|sendEveTurn|streamEveTurn/);
    expect(eveClient).not.toMatch(/sendEveTurn|normalizeEveTurnEvent/);
    expect(repository).not.toMatch(/appendMessage|listMessages/);
    expect(existsSync(resolve(root, "src/eve/events.ts"))).toBe(false);
  });
});
