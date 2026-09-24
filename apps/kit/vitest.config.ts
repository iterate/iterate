import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    // the tests stub `window` and spy on `console` without lifecycle hooks (lint/test-style-rules.md)
    unstubGlobals: true,
    restoreMocks: true,
  },
});
