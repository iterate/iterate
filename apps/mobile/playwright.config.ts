import { defineConfig, devices } from "@playwright/test";

const mobileWebUrl = "http://127.0.0.1:8082";

export default defineConfig({
  testDir: "e2e/playwright",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.01 },
  },
  snapshotPathTemplate: "{testDir}/screenshots/{arg}{ext}",
  outputDir: "test-results/playwright-output",
  use: {
    baseURL: mobileWebUrl,
    actionTimeout: 5_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "phone-sized-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 1,
      },
    },
  ],
  webServer: {
    command: "pnpm start:web --port 8082",
    url: mobileWebUrl,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
