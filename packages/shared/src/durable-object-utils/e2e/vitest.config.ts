import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("../../..", import.meta.url).href);

export default defineConfig({
  test: {
    include: ["./src/durable-object-utils/e2e/**/*.e2e.test.ts"],
    hookTimeout: 60_000,
    testTimeout: 45_000,
  },
  root,
});
