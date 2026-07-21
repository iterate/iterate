import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import {
  appendConsoleLineSync,
  createVitestRunRoot,
  E2E_PROJECT_ROOT_KEY,
  E2E_RUN_ROOT_KEY,
} from "@iterate-com/shared/test-support/vitest-e2e";
import {
  E2E_CI_RETRIES,
  E2E_CI_RETRY_DELAY_MS,
  E2E_TEST_TIMEOUT_MS,
  RetryTelemetryReporter,
} from "@iterate-com/shared/test-support/e2e-policy";
import { E2E_FILE_TEST_CONCURRENCY } from "./test-support/concurrency.ts";
import { E2E_REPO_ROOT_KEY, E2E_RUN_SLUG_KEY } from "./test-support/provide-keys.ts";
import { createVitestRunSlug } from "./test-support/vitest-naming.ts";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const e2eRoot = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

const vitestRunSlug = createVitestRunSlug();
const vitestRunRoot = createVitestRunRoot("os-e2e-");

console.log(`[vitest-artifacts] run root: ${vitestRunRoot}`);
console.log(`[vitest] run slug: ${vitestRunSlug}`);

const ci = process.env.CI === "true";

const sharedProvide = {
  [E2E_RUN_ROOT_KEY]: vitestRunRoot,
  [E2E_PROJECT_ROOT_KEY]: e2eRoot,
  [E2E_RUN_SLUG_KEY]: vitestRunSlug,
  [E2E_REPO_ROOT_KEY]: repoRoot,
};
const sharedResolve = {
  alias: {
    "~": resolve(appRoot, "src"),
  },
};

// One e2e suite, one project (`node`), driving a real deployed OS
// (APP_CONFIG_BASE_URL — local dev, preview, or prod). Browser-side catalogue
// coverage lives in specs/repl-examples.spec.ts, which runs the examples
// through the real REPL. Preview CI invokes `pnpm e2e --project node`; the
// project keeps that name so the invocation stays valid.
export default defineConfig({
  test: {
    // Run-scheduler options live at the ROOT test level — this is where vitest
    // reads them, even with `projects`. Parallel in CI: files either provision
    // isolated projects or lease exclusive projects from the matrix's
    // runtime-specific pools.
    // Sequential locally so a single dev server isn't hammered.
    fileParallelism: ci,
    // These tests spend almost all their wall time waiting on isolated remote
    // projects. Give every current file a worker immediately instead of
    // creating scheduling waves on the Depot host. 64 is only a ceiling:
    // Vitest starts at most one worker per runnable file (currently 48).
    maxWorkers: 64,
    sequence: { concurrent: ci },
    maxConcurrency: E2E_FILE_TEST_CONCURRENCY,
    passWithNoTests: true,
    // Retry telemetry (policy rule 5 — see @iterate-com/shared
    // test-support/e2e-policy/budgets.ts): reporters DO belong at the root
    // test level and apply across projects — unlike `retry`, which vitest
    // only reads from each project config (see the note on the node project).
    reporters: ["default", new RetryTelemetryReporter({ testKind: "e2e", lane: "vitest" })],
    projects: [
      {
        resolve: sharedResolve,
        test: {
          name: "node",
          environment: "node",
          // The engine e2e suites and the itx catalogue matrix are both node
          // black boxes against the deployed slot — one lane.
          include: [
            "./e2e/vitest/**/*.test.ts",
            "./e2e/examples/*.e2e.test.ts",
            "./e2e/test-support/*.test.ts",
          ],
          // Ensure the target exists before any test runs: no-op against a
          // deployed APP_CONFIG_BASE_URL, otherwise reuse-or-start the local
          // dev server — the `pnpm spec` webServer contract (see
          // global-setup.ts). Vitest reads globalSetup per project (like
          // `retry` below), and the setup dedupes itself — harmless if more
          // projects ever list it again.
          // Absolute so vitest (project-root-relative) and knip
          // (config-dir-relative) agree on where this file lives.
          globalSetup: [resolve(e2eRoot, "test-support/global-setup.ts")],
          setupFiles: ["./e2e/vitest/setup.ts"],
          provide: sharedProvide,
          // #1601 fixed cold-slot creates to ~3-5s per saga under 4-way load
          // (tasks/os-cold-create-latency.md), so 120s is ample headroom
          // without letting a wedged saga eat the whole job.
          hookTimeout: E2E_TEST_TIMEOUT_MS,
          testTimeout: E2E_TEST_TIMEOUT_MS,
          // One retry in CI, the only retry layer in the whole lane
          // (docs/testing.md#retries-and-timeouts): tests are self-contained
          // (fresh project per test), so a rare platform blip re-rolls in
          // seconds. A burst that defeats the single retry fails the run —
          // deliberately: platform weather should be visible, not absorbed
          // (the 50-run marathon audit saw zero second retries; the
          // RetryTelemetryReporter above counts the first ones).
          // Lives HERE and not at the root: vitest does not inherit `retry`
          // into project configs — the root-level retry silently never
          // applied (verified: a CI-profile run showed a failed test with
          // zero retry attempts).
          retry: ci ? { count: E2E_CI_RETRIES, delay: E2E_CI_RETRY_DELAY_MS } : 0,
        },
      },
    ],
    onConsoleLog(log, type, entity) {
      if (entity?.type !== "test") return;

      appendConsoleLineSync({
        runRoot: vitestRunRoot,
        projectRoot: e2eRoot,
        moduleId: entity.module.moduleId,
        testFullName: entity.fullName,
        testId: entity.id,
        log,
        type,
      });
    },
  },
});
