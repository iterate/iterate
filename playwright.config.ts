import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.APP_URL || "http://localhost:5173";

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  timeout: 120_000,
  use: {
    actionTimeout: 1_000,
    baseURL,
    trace: process.env.CI ? "on-first-retry" : "on",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "pnpm dev", // todo: uncomment when dev script runs os and daemon
    url: baseURL,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
