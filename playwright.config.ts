import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.APP_URL || "http://localhost:5173";

export default defineConfig({
  testDir: "spec",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  outputDir: "test-results/output",
  reporter: [
    ["list"],
    ["html", { outputFolder: "test-results/html", open: "never" }],
    ["json", { outputFile: "test-results/json/results.json" }],
  ],
  timeout: 120_000,
  use: {
    actionTimeout: 1_000,
    baseURL,
    trace: process.env.CI ? "on-first-retry" : "on",
    video: {
      mode: "retain-on-failure",
    },
    screenshot: {
      mode: "only-on-failure",
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1024, height: 712 } },
    },
  ],
  webServer: {
    command: "pnpm dev", // todo: uncomment when dev script runs os and daemon
    url: baseURL,
    reuseExistingServer: true,
    timeout: 180_000,
    stdout: "pipe", // without this on startup failure it just says "Couldn't start. Exit code 1."
  },
});
