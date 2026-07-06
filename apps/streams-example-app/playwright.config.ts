import { defineConfig, devices } from "@playwright/test";

const workerUrl = process.env.WORKER_URL;
const localUrl = "http://127.0.0.1:5173";

export default defineConfig({
  testDir: "e2e/playwright",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  // Fleet-wide CI retry policy (see the root playwright.config.ts):
  // platform-fault bursts need re-rolls; real regressions still fail all
  // three attempts fast.
  retries: process.env.CI ? 2 : 0,
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
