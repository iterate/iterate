import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["e2e/**", "example-app/e2e/**", "scripts/**/*.test.ts", "**/node_modules/**"],
    testTimeout: 30_000,
  },
});
