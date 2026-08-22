import { describe, expect, it } from "vitest";

import nextConfig from "../next.config";

describe("Next configuration", () => {
  it("proxies cookie-bearing Identity requests through Dawn", async () => {
    const rewrites = await nextConfig.rewrites?.();

    expect(Array.isArray(rewrites)).toBe(true);
    expect(rewrites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "/identity/:path*",
          destination: expect.stringMatching(/\/identity\/:path\*$/),
        }),
      ]),
    );
  });
});
