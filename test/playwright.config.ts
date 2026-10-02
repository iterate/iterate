import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import {
  E2E_CI_RETRIES,
  SPEC_ACTION_TIMEOUT_MS,
  SPEC_EXPECT_TIMEOUT_MS,
  SPEC_TEST_TIMEOUT_MS,
} from "@iterate-com/shared/test-support/e2e-policy";
import { testEvidencePaths } from "@iterate-com/shared/test-support/test-evidence";
import { localWorkerPort, workerBaseUrl } from "./helpers/worker-base-url.ts";

// Playwright resolves this file's relative paths against test/. The runs start at the repository's
// root (root `pnpm spec`), and what they leave stays there: CI's evidence tooling reads
// test-results/ at the root.
const repoRoot = path.resolve(import.meta.dirname, "..");
const fromRoot = (file: string) => path.join(repoRoot, file);

const videoMode = process.env.VIDEO_MODE === "1";
// CI retry artifacts already include screenshots/traces; retaining videos can
// leave ffmpeg workers alive after a retry and keep the job open.
const videoArtifactsEnabled = videoMode || !process.env.CI;

/** The Notes Worker deployed against the OS under test, which the notes project's config worker
 *  fetches through to: the notes project's baseURL. Its session spec also signs in to the Dash
 *  (DASH_BASE_URL). Locally, unset skips it; in CI, unset fails it. */
const notesBaseUrl = process.env.NOTES_BASE_URL?.replace(/\/+$/, "");
/** The Docs Worker deployed against that OS, which the docs project's config worker fetches
 *  through to, as Notes'. Locally, unset skips its specs; in CI, unset fails them. */
const docsBaseUrl = process.env.DOCS_BASE_URL?.replace(/\/+$/, "");
/** The Voice app deployed against that OS: the voice project's baseURL. Locally, unset skips its
 *  specs; in CI, unset fails them. */
const voiceBaseUrl = process.env.VOICE_BASE_URL?.replace(/\/+$/, "");
/** The Dash and the Admin app deployed against that OS: the dash and admin projects' baseURLs.
 *  Locally, unset skips their specs; in CI, unset fails them. */
const dashBaseUrl = process.env.DASH_BASE_URL?.replace(/\/+$/, "");
const adminBaseUrl = process.env.ADMIN_BASE_URL?.replace(/\/+$/, "");
/** CI's Browser specs run as SPECS_SHARDS jobs, each SPECS_SHARD of them running its share of the
 *  tests (preview-os.yml's `specs-shard`). A shard writes a blob report instead of an HTML one, and
 *  the Browser specs job merges them all into the one HTML report (scripts/ci/specs-shards.ts). */
const shard = process.env.SPECS_SHARD
  ? { current: Number(process.env.SPECS_SHARD), total: Number(process.env.SPECS_SHARDS) }
  : null;
const desktopWebUse = {
  ...devices["Desktop Chrome"],
  viewport: { width: 1280, height: 900 },
};
// VIDEO_MODE=1 records every project at its own viewport size.
const recordedAtViewport = <Use extends { viewport: { width: number; height: number } }>(
  use: Use,
) => (videoMode ? { ...use, video: { mode: "on" as const, size: use.viewport } } : use);

export default defineConfig({
  testDir: ".",
  globalSetup: "./playwright/global-setup.ts",
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
  // Six browsers use about 2.7 of a 4x16's vCPUs (iterate/iterate#3258). CI runs enough shards of six that every
  // test has a worker from the start (scripts/ci/specs-shards.test.ts).
  workers: process.env.CI ? 6 : 1,
  shard,
  // Everything the run leaves goes into the test evidence folder (docs/test-evidence.md).
  outputDir: fromRoot(testEvidencePaths.playwrightOutput),
  reporter: [
    ["list"],
    shard
      ? ["blob", { outputDir: fromRoot(testEvidencePaths.playwrightBlob) }]
      : ["html", { outputFolder: fromRoot(testEvidencePaths.playwrightReport), open: "never" }],
    ["json", { outputFile: fromRoot(testEvidencePaths.playwrightResults) }],
    // The telemetry reporter writes the canonical test artifact and the plain tests' flake records
    // (retried passes and hard failures) the preview's CI finalizer uploads (docs/testing.md#flakes-and-pinned-failures).
    ["../scripts/ci/playwright-telemetry-reporter.ts"],
    // The trace reporter prints each attempt's `@@ci-trace` lifecycle records when
    // CI_TRACE_ENABLED=1 (docs/ci-traces.md).
    ["../scripts/ci/tracing/tracing.ts"],
  ],
  timeout: SPEC_TEST_TIMEOUT_MS,
  expect: { timeout: SPEC_EXPECT_TIMEOUT_MS },
  use: {
    // Tight on purpose; the middlewright spinner-waiter extends it only while
    // the app visibly reports progress (see e2e-policy/budgets.ts, which also
    // explains why there is no video-mode or per-project override).
    actionTimeout: SPEC_ACTION_TIMEOUT_MS,
    baseURL: workerBaseUrl,
    screenshot: "only-on-failure",
    // Preserve the original failure's network evidence; successful attempts
    // still discard their traces.
    trace: "retain-on-failure",
    video: videoMode ? "on" : videoArtifactsEnabled ? "retain-on-failure" : "off",
  },
  // One project per app host: its specs live in playwright/<app>/ and its baseURL is that app.
  projects: [
    {
      name: "os",
      testDir: "playwright/os",
      use: recordedAtViewport(desktopWebUse),
    },
    // the OS issuer's pages once more at a phone's width, with touch
    {
      name: "os-phone",
      testDir: "playwright/os",
      testMatch: ["**/auth.spec.ts", "**/issuer-pages.spec.ts"],
      use: recordedAtViewport(devices["Pixel 7"]),
    },
    {
      name: "notes",
      testDir: "playwright/notes",
      use: recordedAtViewport({ ...desktopWebUse, baseURL: notesBaseUrl }),
    },
    {
      name: "docs",
      testDir: "playwright/docs",
      use: recordedAtViewport({ ...desktopWebUse, baseURL: docsBaseUrl }),
    },
    {
      name: "voice",
      testDir: "playwright/voice",
      use: recordedAtViewport({ ...desktopWebUse, baseURL: voiceBaseUrl }),
    },
    {
      name: "dash",
      testDir: "playwright/dash",
      use: recordedAtViewport({ ...desktopWebUse, baseURL: dashBaseUrl }),
    },
    // the Dash's collection link once more at a phone's width, with touch: where it is often read
    {
      name: "dash-phone",
      testDir: "playwright/dash",
      testMatch: ["**/collect-secret.spec.ts"],
      use: recordedAtViewport({
        ...devices["Pixel 7"],
        viewport: { width: 390, height: 844 },
        baseURL: dashBaseUrl,
      }),
    },
    {
      name: "admin",
      testDir: "playwright/admin",
      use: recordedAtViewport({ ...desktopWebUse, baseURL: adminBaseUrl }),
    },
    // the suite's own specs, beside the app folders: the flake sentinel and the harness's
    // local-only specs (setContent, no deployment)
    {
      name: "suite",
      testMatch: ["playwright/flake-sentinel.spec.ts", "helpers/*.spec.ts"],
      use: desktopWebUse,
    },
  ],
  // unset WORKER_BASE_URL boots a local OS worker
  webServer: process.env.WORKER_BASE_URL
    ? []
    : [
        {
          command: `node scripts/os-dev.ts -- --port ${localWorkerPort}`,
          cwd: repoRoot,
          url: `${workerBaseUrl}/version`,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          stdout: "pipe" as const,
          stderr: "pipe" as const,
        },
      ],
});
