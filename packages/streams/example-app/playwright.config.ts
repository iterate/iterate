import { defineConfig, devices } from "@playwright/test";

const workerUrl = process.env.WORKER_URL;
const localUrl = "http://127.0.0.1:5173";

export default defineConfig({
  testDir: "e2e/playwright",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  webServer:
    workerUrl === undefined
      ? {
          command: "pnpm dev --host 127.0.0.1",
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
