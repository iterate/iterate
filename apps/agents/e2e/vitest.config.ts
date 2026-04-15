import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { createVitestRunSlug, VITEST_RUN_SLUG_KEY } from "./test-support/vitest-naming.ts";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const vitestRunSlug = createVitestRunSlug();

export default defineConfig({
  resolve: {
    alias: {
      "~": resolve(appRoot, "src"),
    },
  },
  test: {
    environment: "node",
    fileParallelism: false,
    hookTimeout: 120_000,
    include: ["./e2e/vitest/**/*.test.ts"],
    provide: {
      [VITEST_RUN_SLUG_KEY]: vitestRunSlug,
    },
    testTimeout: 120_000,
  },
});
