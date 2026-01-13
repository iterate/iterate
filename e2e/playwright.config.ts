import { defineConfig, devices } from "@playwright/test";

const DAEMON_URL = process.env.DAEMON_URL || "http://localhost:3000";
const OS_URL = process.env.OS_URL || "http://localhost:5173";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  timeout: 120_000,
  use: {
    actionTimeout: 1_000,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "os",
      testDir: ".",
      testIgnore: ["os/**"],
      use: {
        ...devices["Desktop Chrome"],
        baseURL: OS_URL,
      },
    },
    {
      name: "daemon",
      testDir: "./os",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: DAEMON_URL,
      },
    },
  ],
});
