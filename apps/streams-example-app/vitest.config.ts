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
  },
});
