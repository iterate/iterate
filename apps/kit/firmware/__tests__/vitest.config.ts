import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["firmware/__tests__/runtime-diagnostics-interop.test.ts"],
    testTimeout: 10_000,
  },
});
