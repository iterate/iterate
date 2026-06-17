import { defineConfig, devices } from "@playwright/test";

const videoMode = process.env.VIDEO_MODE === "1";
const readyPort = Number(process.env.OS_PLAYWRIGHT_READY_PORT || 17604);

export default defineConfig({
  testDir: "specs",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  outputDir: "test-results/playwright-output",
  reporter: [
    ["list"],
    ["html", { outputFolder: "test-results/playwright-html", open: "never" }],
    ["json", { outputFile: "test-results/playwright-results.json" }],
  ],
  timeout: videoMode ? 300_000 : 90_000,
  expect: { timeout: 15_000 },
  use: {
    actionTimeout: videoMode ? 10_000 : 750,
    screenshot: "only-on-failure",
    trace: process.env.CI ? "on-first-retry" : "retain-on-failure",
    video: videoMode ? "on" : "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
    },
  ],
  webServer: process.env.OS_PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: `pnpm exec tsx ./specs/start-local-dev.ts --ready-port ${readyPort}`,
        url: `http://127.0.0.1:${readyPort}/ready`,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        stdout: "pipe",
        stderr: "pipe",
      },
});
