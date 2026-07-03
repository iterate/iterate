import { defineConfig } from "vitest/config";

// Only the pure-TS pieces (the voice session state machine) run under vitest;
// anything touching React Native ships untested here and is exercised in the
// simulator instead.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
