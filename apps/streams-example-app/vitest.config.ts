import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("../os/src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["e2e/vitest/**/*.test.ts"],
    testTimeout: 30_000,
    // Fleet-wide CI retry policy (see apps/os/e2e/vitest.config.ts): each
    // test opens its own fresh connection, so a retry re-rolls transient
    // edge/platform faults ("Network connection lost." killed a marathon run
    // here on a 392ms-old socket) while a real regression still fails all
    // three attempts fast.
    retry: process.env.CI ? 2 : 0,
  },
});
