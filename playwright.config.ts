import { createServer } from "node:net";
import { defineConfig, devices } from "@playwright/test";
import {
  E2E_CI_RETRIES,
  SPEC_ACTION_TIMEOUT_MS,
  SPEC_EXPECT_TIMEOUT_MS,
  SPEC_TEST_TIMEOUT_MS,
} from "@iterate-com/shared/test-support/e2e-policy";
import { localOsDevServer } from "./apps/os/scripts/dev.ts";

const videoMode = process.env.VIDEO_MODE === "1";
// CI retry artifacts already include screenshots/traces; retaining videos can
// leave ffmpeg workers alive after a retry and keep the job open.
const videoArtifactsEnabled = videoMode || !process.env.CI;

/** Note: we use APP_CONFIG_BASE_URL as the *os* base url, even though that same variable name is used for other services too */
const configuredOsBaseUrl = process.env.APP_CONFIG_BASE_URL?.replace(/\/+$/, "");
const localOsTarget = configuredOsBaseUrl ? null : await localOsDevServer.resolveTarget();
const osBaseUrl = configuredOsBaseUrl || localOsTarget?.baseUrl;
const mobileWebPort = Number(
  process.env.PLAYWRIGHT_MOBILE_WEB_PORT ||
    (await pickFreePort(localOsTarget ? localOsTarget.port : null)),
);
process.env.PLAYWRIGHT_MOBILE_WEB_PORT = String(mobileWebPort);
const mobileWebUrl = `http://127.0.0.1:${mobileWebPort}`;

export default defineConfig({
  testDir: "specs",
  testMatch: "**/*.spec.ts",
  // Every spec provisions its own fixture project, so specs are independent.
  // Parallel in CI against a deployed slot; sequential locally so a single
  // dev server isn't hammered.
  fullyParallel: !!process.env.CI,
  forbidOnly: !!process.env.CI,
  // One retry in CI — the only retry layer, per the fleet-wide policy
  // (docs/testing.md#retries-and-timeouts). A burst that defeats it fails
  // the run on purpose: platform weather should be visible, not absorbed.
  retries: process.env.CI ? E2E_CI_RETRIES : 0,
  // Eight is also the deployed-slot concurrency ceiling for this suite. The
  // OS preview runner executes its remote suites sequentially: allowing this
  // suite's eight workers to overlap vitest's eight in-flight tests caused
  // project-processor timeouts even though each suite was clean in isolation.
  workers: process.env.CI ? 8 : 1,
  outputDir: "test-results/playwright-output",
  reporter: [
    ["list"],
    ["html", { outputFolder: "test-results/playwright-html", open: "never" }],
    ["json", { outputFile: "test-results/playwright-results.json" }],
  ],
  timeout: videoMode ? 300_000 : SPEC_TEST_TIMEOUT_MS,
  expect: { timeout: SPEC_EXPECT_TIMEOUT_MS },
  use: {
    // Tight on purpose; the middlewright spinner-waiter extends it only while
    // the app visibly reports progress (see e2e-policy/budgets.ts).
    actionTimeout: videoMode ? 10_000 : SPEC_ACTION_TIMEOUT_MS,
    baseURL: osBaseUrl,
    screenshot: "only-on-failure",
    trace: process.env.CI ? "on-first-retry" : "retain-on-failure",
    video: videoMode ? "on" : videoArtifactsEnabled ? "retain-on-failure" : "off",
  },
  projects: [
    {
      name: "web",
      testIgnore: "**/mobile/**",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
    },
    {
      name: "mobile",
      testMatch: "**/mobile/**/*.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        // Metro reports its HTTP server ready before the first JS bundle has
        // compiled and hydrated, so the mobile route needs a small startup
        // budget beyond the web app's already-running action timeout.
        actionTimeout: 5_000,
        baseURL: mobileWebUrl,
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 1,
      },
    },
  ],
  webServer: [
    ...(localOsTarget
      ? [
          {
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
            stdout: "pipe" as const,
            stderr: "pipe" as const,
          },
        ]
      : []),
    {
      command: `pnpm --dir apps/mobile start:web --port ${mobileWebPort}`,
      url: mobileWebUrl,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});

async function pickFreePort(excludedPort: number | null): Promise<number> {
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a port for Expo Web."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
  return port === excludedPort ? await pickFreePort(excludedPort) : port;
}
