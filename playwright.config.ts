import { defineConfig, devices } from "@playwright/test";
import { localOsDevServer } from "./apps/os/scripts/dev.ts";

const videoMode = process.env.VIDEO_MODE === "1";
const configuredOsBaseUrl = process.env.OS_BASE_URL?.replace(/\/+$/, "");
const localOsTarget = configuredOsBaseUrl ? null : await localOsDevServer.resolveTarget();
const osBaseUrl = configuredOsBaseUrl || localOsTarget?.baseUrl;

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
    baseURL: osBaseUrl,
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
  webServer: localOsTarget
    ? {
        command: `node ./apps/os/scripts/dev.ts start --detach --keep-alive --port ${localOsTarget.port}`,
        env: process.env as Record<string, string>,
        url: `${localOsTarget.baseUrl}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: Math.max(
          10_000,
          new Date(localOsDevServer.readLive()?.startedAt || Date.now()).getTime() +
            180_000 -
            Date.now(),
        ),
        stdout: "pipe",
        stderr: "pipe",
      }
    : undefined,
});
