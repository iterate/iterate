import { defineConfig, devices } from "@playwright/test";
import { E2E_CI_RETRIES } from "@iterate-com/shared/test-support/e2e-policy";

const workerUrl = process.env.WORKER_URL;
const localUrl = "http://127.0.0.1:5173";

export default defineConfig({
  testDir: "e2e/playwright",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  // Fleet-wide CI retry policy (docs/testing.md#retries-and-timeouts): one
  // retry re-rolls an isolated platform blip; a real regression still fails
  // both attempts fast.
  retries: process.env.CI ? E2E_CI_RETRIES : 0,
  webServer:
    workerUrl === undefined
      ? {
          command: "pnpm exec vite dev --host 127.0.0.1",
          url: localUrl,
          reuseExistingServer: !process.env.CI,
        }
      : undefined,
  use: {
    baseURL: workerUrl ?? localUrl,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
