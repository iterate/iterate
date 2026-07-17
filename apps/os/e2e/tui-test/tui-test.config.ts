import { defineConfig } from "@microsoft/tui-test";
import { E2E_CI_RETRIES, TUI_TEST_TIMEOUT_MS } from "@iterate-com/shared/test-support/e2e-policy";

export default defineConfig({
  testMatch: "*.spec.ts",
  retries: process.env.CI ? E2E_CI_RETRIES : 0,
  timeout: TUI_TEST_TIMEOUT_MS,
  trace: true,
  workers: 1,
});
