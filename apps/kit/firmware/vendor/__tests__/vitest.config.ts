import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["firmware/vendor/__tests__/c-interop.test.ts"],
    testTimeout: 10_000,
  },
});
