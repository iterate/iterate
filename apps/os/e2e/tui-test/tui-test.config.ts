import { defineConfig } from "@microsoft/tui-test";

export default defineConfig({
  expect: {
    timeout: 15_000,
  },
  testMatch: "*.spec.ts",
  timeout: 45_000,
  trace: true,
  workers: 1,
});
