import { defineConfig, devices } from "@playwright/test";

const DAEMON2_URL = process.env.DAEMON2_URL || "http://localhost:3000";
const OS2_URL = process.env.OS2_URL || "http://localhost:5173";

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
      name: "os2",
      testDir: ".",
      testIgnore: ["os2/**"],
      use: {
        ...devices["Desktop Chrome"],
        baseURL: OS2_URL,
      },
    },
    {
      name: "daemon2",
      testDir: "./os2",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: DAEMON2_URL,
      },
    },
  ],
});
