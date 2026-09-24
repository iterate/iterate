import { defineConfig, devices } from "@playwright/test";
import {
  E2E_CI_RETRIES,
  SPEC_ACTION_TIMEOUT_MS,
  SPEC_EXPECT_TIMEOUT_MS,
  SPEC_TEST_TIMEOUT_MS,
} from "@iterate-com/shared/test-support/e2e-policy";

const videoMode = process.env.VIDEO_MODE === "1";
// CI retry artifacts already include screenshots/traces; retaining videos can
// leave ffmpeg workers alive after a retry and keep the job open.
const videoArtifactsEnabled = videoMode || !process.env.CI;

/** Note: we use DEMO_BASE_URL as the *os* base url; unset boots a local OS worker. */
const configuredOsBaseUrl = process.env.DEMO_BASE_URL?.replace(/\/+$/, "");
const localOsPort = Number(process.env.DEMO_PORT || 8788);
const osBaseUrl = configuredOsBaseUrl || `http://localhost:${localOsPort}`;
/** The Notes app deployed against that OS: the notes project's baseURL. Its session specs also
 *  sign in to the Dash (DASH_BASE_URL). Locally, unset skips them; in CI, unset fails them. */
const notesBaseUrl = process.env.NOTES_BASE_URL?.replace(/\/+$/, "");
/** The Voice app deployed against that OS: the voice project's baseURL. Locally, unset skips its
 *  specs; in CI, unset fails them. */
const voiceBaseUrl = process.env.VOICE_BASE_URL?.replace(/\/+$/, "");
const desktopWebUse = {
  ...devices["Desktop Chrome"],
  viewport: { width: 1280, height: 900 },
};
// VIDEO_MODE=1 records every project at its own viewport size.
const recordedAtViewport = <Use extends { viewport: { width: number; height: number } }>(
  use: Use,
) => (videoMode ? { ...use, video: { mode: "on" as const, size: use.viewport } } : use);

export default defineConfig({
  testDir: "specs",
  globalSetup: "./specs/setup.ts",
  testMatch: "**/*.spec.ts",
  // Stateful specs provision isolated fixture projects; local-only helper
  // specs share no remote state. Parallel in CI against a deployed preview;
  // sequential locally so a single dev server isn't hammered.
  fullyParallel: !!process.env.CI,
  forbidOnly: !!process.env.CI,
  // One retry in CI — the only retry layer, per the fleet-wide policy
  // (packages/shared/src/test-support/e2e-policy). A burst that defeats it fails
  // the run on purpose: platform weather should be visible, not absorbed.
  retries: process.env.CI ? E2E_CI_RETRIES : 0,
  workers: process.env.CI ? 6 : 1,
  outputDir: "test-results/playwright-output",
  reporter: [
    ["list"],
    ["html", { outputFolder: "test-results/playwright-html", open: "never" }],
    ["json", { outputFile: "test-results/playwright-results.json" }],
    // The telemetry reporter writes the canonical test artifact and the plain tests' flake records
    // (retried passes and hard failures) the preview's CI finalizer uploads (docs/testing.md#flakes-and-pinned-failures).
    ["./scripts/ci/playwright-telemetry-reporter.ts"],
    // The trace reporter prints each attempt's `@@ci-trace` lifecycle records when
    // CI_TRACE_ENABLED=1 (docs/ci-traces.md).
    ["./scripts/ci/tracing/tracing.ts"],
  ],
  timeout: SPEC_TEST_TIMEOUT_MS,
  expect: { timeout: SPEC_EXPECT_TIMEOUT_MS },
  use: {
    // Tight on purpose; the middlewright spinner-waiter extends it only while
    // the app visibly reports progress (see e2e-policy/budgets.ts, which also
    // explains why there is no video-mode or per-project override).
    actionTimeout: SPEC_ACTION_TIMEOUT_MS,
    baseURL: osBaseUrl,
    screenshot: "only-on-failure",
    // Preserve the original failure's network evidence; successful attempts
    // still discard their traces.
    trace: "retain-on-failure",
    video: videoMode ? "on" : videoArtifactsEnabled ? "retain-on-failure" : "off",
  },
  // One project per app host: its specs live in specs/<app>/ and its baseURL is that app.
  projects: [
    {
      name: "os",
      testDir: "specs/os",
      use: recordedAtViewport(desktopWebUse),
    },
    // the OS issuer's pages once more at a phone's width, with touch
    {
      name: "os-phone",
      testDir: "specs/os",
      testMatch: ["**/auth.spec.ts", "**/issuer-pages.spec.ts"],
      use: recordedAtViewport(devices["Pixel 7"]),
    },
    {
      name: "notes",
      testDir: "specs/notes",
      use: recordedAtViewport({ ...desktopWebUse, baseURL: notesBaseUrl }),
    },
    {
      name: "voice",
      testDir: "specs/voice",
      use: recordedAtViewport({ ...desktopWebUse, baseURL: voiceBaseUrl }),
    },
    // the suite's own specs, beside the app folders: the flake sentinel and the harness's
    // local-only specs (setContent, no deployment)
    {
      name: "suite",
      testMatch: ["flake-sentinel.spec.ts", "test-support/*.spec.ts"],
      use: desktopWebUse,
    },
  ],
  webServer: configuredOsBaseUrl
    ? []
    : [
        {
          command: `pnpm --dir apps/os dev -- --port ${localOsPort}`,
          url: `${osBaseUrl}/version`,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          stdout: "pipe" as const,
          stderr: "pipe" as const,
        },
      ],
});
