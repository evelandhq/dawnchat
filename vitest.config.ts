import { defaultExclude, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
    // Agent worktrees carry their own checkout (and node_modules); running
    // their copies from here mixes two React instances and doubles the suite.
    exclude: [...defaultExclude, ".claude/worktrees/**"],
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
});
