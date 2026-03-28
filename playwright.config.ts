import { devices, type PlaywrightTestConfig } from "@playwright/test";

const baseURL = process.env.APP_URL || "http://localhost:5173";
const videoMode = !!process.env.VIDEO_MODE;

export default {
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
  timeout: videoMode ? 300_000 : 120_000,
  use: {
    actionTimeout: videoMode ? 10_000 : 1_000,
    baseURL,
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
  webServer: {
    command: isAgent()
      ? `sh -c "echo 'Agents are not allowed to start the dev server through playwright. They need to run it themselves separately, ideally with nohup and writing output to a file they can check.' && exit 1"`
      : "pnpm dev", // todo: uncomment when dev script runs os and daemon
    url: baseURL,
    reuseExistingServer: true,
    timeout: 180_000,
    stdout: "pipe", // without this on startup failure it just says "Couldn't start. Exit code 1."
  },
} as const satisfies PlaywrightTestConfig;

function isAgent() {
  // Check all known agent env vars for robustness
  return (
    process.env.CODEX_CI === "1" ||
    process.env.AGENT === "1" ||
    process.env.OPENCODE === "1" ||
    !!process.env.OPENCODE_SESSION ||
    !!process.env.CLAUDE_CODE
  );
}
