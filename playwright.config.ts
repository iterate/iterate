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
// Preview is the latency-sensitive full suite. Give its deliberately long
// reconnect/resume proofs their own first project so Playwright queues those
// test groups before the ordinary web catalogue and overlaps their real
// outage/recovery windows with useful work. Outside preview, keep the public
// `web` / `mobile` project interface unchanged.
const previewSlowFirst = process.env.PLAYWRIGHT_PREVIEW_SLOW_FIRST === "1";
// `pnpm preview test` runs outside GitHub Actions during local experiments but
// still targets an isolated deployed slot. Treat it like CI for concurrency;
// only a developer's single local OS server needs the one-worker default.
const parallelDeployedSuite = !!process.env.CI || process.env.E2E_PREVIEW_PARALLEL === "1";
const resumeAfterSuspendSpec = "**/stream-resume-after-suspend.spec.ts";
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
const desktopWebUse = {
  ...devices["Desktop Chrome"],
  viewport: { width: 1280, height: 900 },
};

export default defineConfig({
  testDir: "specs",
  testMatch: "**/*.spec.ts",
  // Specs isolate mutable state with fresh projects or unique resource
  // namespaces in worker-local projects, so they remain parallel-safe. Run
  // parallel against a deployed preview slot (CI or `pnpm preview test`);
  // sequential only against a developer's single local server.
  fullyParallel: parallelDeployedSuite,
  forbidOnly: !!process.env.CI,
  // One retry in CI — the only retry layer, per the fleet-wide policy
  // (docs/testing.md#retries-and-timeouts). A burst that defeats it fails
  // the run on purpose: platform weather should be visible, not absorbed.
  retries: process.env.CI ? E2E_CI_RETRIES : 0,
  // Twenty-four is this suite's explicit deployed-slot share. The eight-core
  // preview runner spent most of the old 12-worker lane at 70-82% total CPU,
  // so the 16-core runner has real work for the extra browser processes. It
  // overlaps Vitest's configured peak of 64, one TUI workflow, and the
  // one-project onboarding smoke (aggregate configured peak 90). Every spec
  // owns a fresh project or unique resource namespace; lane timing and retry
  // telemetry keep any actual platform saturation visible.
  workers: parallelDeployedSuite ? 24 : 1,
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
    // Record the original failed attempt, not merely its retry. The Experiment
    // 13 hydration flake was an asset GET error on attempt one; on-first-retry
    // preserved only the healthy replacement and discarded the useful network
    // evidence. Successful attempts still discard their traces.
    trace: "retain-on-failure",
    video: videoMode ? "on" : videoArtifactsEnabled ? "retain-on-failure" : "off",
  },
  projects: [
    ...(previewSlowFirst
      ? [
          {
            name: "preview-resilience",
            testMatch: resumeAfterSuspendSpec,
            use: desktopWebUse,
          },
        ]
      : []),
    {
      name: "web",
      testIgnore: previewSlowFirst ? ["**/mobile/**", resumeAfterSuspendSpec] : "**/mobile/**",
      use: desktopWebUse,
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
