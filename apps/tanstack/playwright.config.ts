import { defineConfig, devices } from "@playwright/test";
import { E2E_CI_RETRIES } from "@iterate-com/shared/test-support/e2e-policy";

const localUrl = "http://127.0.0.1:5175";

export default defineConfig({
  testDir: "e2e/playwright",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: !!process.env.CI,
  workers: process.env.CI ? 2 : 1,
  retries: process.env.CI ? E2E_CI_RETRIES : 0,
  reporter: [["list"]],
  webServer: {
    command: "pnpm exec vite dev --host 127.0.0.1 --port 5175",
    url: localUrl,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: localUrl,
    trace: process.env.CI ? "on-first-retry" : "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
