import { defineConfig, devices } from "@playwright/test";
import { cloudflareWorkerVersionOverrideHeaders } from "@iterate-com/shared/test-support/cloudflare-worker-version-overrides";
import { E2E_CI_RETRIES } from "@iterate-com/shared/test-support/e2e-policy";
import { resolveDeployedEnv } from "./e2e/auth.ts";
import { STORAGE_STATE_PATH } from "./e2e/playwright-global-setup.ts";

const workerUrl = process.env.WORKER_URL;
const localUrl = "http://127.0.0.1:5173";
// The global setup writes the saved session only for a DEPLOYED (admin-only)
// target; a loopback WORKER_URL is the auth-less playground. Gate storageState
// on the SAME predicate so the config never points at a file setup skipped.
const usesSavedSession = !!resolveDeployedEnv(workerUrl);

export default defineConfig({
  testDir: "e2e/playwright",
  // Deployed playgrounds are admin-only: the global setup forge-mints a
  // session and saves its storage state; local dev is auth-less and skips it.
  globalSetup: "./e2e/playwright-global-setup.ts",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Every test creates its own unique stream paths and its own browser
  // contexts (fresh OPFS origin per context), so tests are independent.
  // Parallel in CI so the FULL suite fits the preview sub-lane watchdog
  // (docs/testing.md#retries-and-timeouts); sequential locally, where the
  // manual lane often shares a single vite dev server with a human.
  fullyParallel: !!process.env.CI,
  workers: process.env.CI ? 4 : 1,
  // Fleet-wide CI retry policy (docs/testing.md#retries-and-timeouts): one
  // retry re-rolls an isolated platform blip; a real regression still fails
  // both attempts fast.
  retries: process.env.CI ? E2E_CI_RETRIES : 0,
  reporter: [
    ["list"],
    // Retry telemetry (policy rule 5): the preview lane folds this JSON into
    // the PR-body table via scripts/preview/preview.ts.
    ["json", { outputFile: "test-results/playwright-results.json" }],
    ["../../scripts/ci/playwright-telemetry-reporter.ts"],
  ],
  webServer: !workerUrl
    ? {
        command: "pnpm exec vite dev --host 127.0.0.1",
        url: localUrl,
        reuseExistingServer: !process.env.CI,
      }
    : undefined,
  use: {
    baseURL: workerUrl ?? localUrl,
    extraHTTPHeaders: cloudflareWorkerVersionOverrideHeaders(process.env),
    storageState: usesSavedSession ? STORAGE_STATE_PATH : undefined,
    // CI records traces only on the retry attempt (fleet convention, same as
    // the root config): always-on recording taxes every healthy test in the
    // watchdogged sub-lane, and the retry is the attempt worth dissecting.
    trace: process.env.CI ? "on-first-retry" : "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
