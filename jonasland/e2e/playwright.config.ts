import { defineConfig, devices } from "@playwright/test";

const videoMode = !!process.env.VIDEO_MODE;

export default defineConfig({
  testDir: "playwright",
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
  timeout: videoMode ? 300_000 : 180_000,
  use: {
    actionTimeout: videoMode ? 10_000 : 5_000,
    trace: process.env.CI ? "on-first-retry" : "on",
    video: {
      mode: videoMode ? "on" : "retain-on-failure",
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
});
