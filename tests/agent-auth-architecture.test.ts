import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Agent Auth architecture", () => {
  it("keeps method-specific branching out of the main server call paths", () => {
    for (const path of [
      "src/eve/client.ts",
      "src/app/api/agents/api.ts",
      "src/app/api/chats/eve-proxy.ts",
    ]) {
      const source = readFileSync(resolve(root, path), "utf8");
      expect(source).not.toMatch(
        /authType\s*[!=]==?\s*["'](?:local-dev|none|basic|bearer|vercel-oidc|oidc|headers)["']/,
      );
    }
  });

  it("keeps the form descriptor and validation contract browser-safe", () => {
    const source = readFileSync(resolve(root, "src/eve/auth-methods.ts"), "utf8");
    expect(source).not.toMatch(/from ["']node:/);
    expect(source).not.toMatch(/@\/db\//);
    expect(source).not.toMatch(/@\/eve\/(?:auth-runtime|oidc)/);
  });
});
