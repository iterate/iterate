import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";
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

// Observed wall-clock seconds per file on a green preview lane (Depot run
// 1wd5nxb87d, 2026-07-09). Used for longest-first scheduling below — vitest
// hands files to workers in sort order, so a slow file starting LAST becomes
// the whole lane's tail (the itx catalogue at ~100s used to routinely start
// mid-run and stretch the lane past 3 minutes). Unlisted files default to 15s
// (roughly the observed median); exact numbers matter much less than the
// slow/fast partition, so refresh only when the ranking visibly drifts.
const observedFileSeconds: Record<string, number> = {
  "agent-tools.itx.e2e.test.ts": 78,
  "script-execution-concurrency.e2e.test.ts": 38,
  "streams.e2e.test.ts": 34,
  "stream-lifecycle.e2e.test.ts": 33,
  "sandbox-egress.e2e.test.ts": 33,
  "live-capability-websocket.e2e.test.ts": 31,
  // The itx-*.e2e.test.ts entries are the old itx.e2e.test.ts catalogue
  // (104s as one file) split for file-level parallelism; per-file numbers
  // are estimates proportional to test counts, not yet observed.
  "itx-agents.e2e.test.ts": 25,
  "integrations-userspace.e2e.test.ts": 23,
  "agent-codemode-fence.itx.e2e.test.ts": 19,
  "itx-connect.e2e.test.ts": 18,
  "itx-workers.e2e.test.ts": 18,
  "slack-agent.e2e.test.ts": 18,
  "project-ingress.e2e.test.ts": 18,
  "scheduler.e2e.test.ts": 16,
  "agent-script-result-spill.itx.e2e.test.ts": 16,
  "itx-live-capabilities.e2e.test.ts": 15,
  "stream-security.e2e.test.ts": 15,
  "worker-build.e2e.test.ts": 15,
  "workspace.itx.e2e.test.ts": 13,
  "github-backed-repo.e2e.test.ts": 12,
  "itx-core.e2e.test.ts": 10,
  "itx-subscribe.e2e.test.ts": 10,
  "repo-history.itx.e2e.test.ts": 10,
  "stream-wire.e2e.test.ts": 10,
  "itx-egress.e2e.test.ts": 8,
  "admin-project.itx.e2e.test.ts": 8,
  "repo-binary.itx.e2e.test.ts": 8,
  "preview-smoke.e2e.test.ts": 8,
  "mcp-oauth.e2e.test.ts": 2,
};

/** Longest-processing-time-first: start the slow files so they never tail the lane. */
class SlowestFirstSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const seconds = (spec: TestSpecification) => observedFileSeconds[basename(spec.moduleId)] ?? 15;
    return [...files].sort((left, right) => seconds(right) - seconds(left));
  }
}

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
    // reads them, even with `projects`. Parallel in CI: each test provisions
    // its own project against a deployed slot, so FILES are independent.
    // Sequential locally so a single dev server isn't hammered.
    fileParallelism: ci,
    // 6 workers × maxConcurrency 2 = peak ~12 concurrent tests. History of
    // this number: 4×4 = ~16 overloaded a very cold slot pre-#1601
    // (DO-storage timeouts), 4×3 = ~12 still produced rotating
    // stream-delivery timeouts on #1638's runs, so it sat at 4×2 = ~8 for a
    // while. Peak 12 was subsequently revalidated green, and the 2026-07-18
    // trace audit showed project birth taking ~1,067 aggregate seconds across
    // 176 successful creates without a capacity failure. The failures seen at
    // lower concurrency were product lifecycle defects, not evidence that the
    // preview slot needed protection from independent tests. The preview
    // runner overlaps this peak with Playwright's eight workers and one TUI
    // test: aggregate peak 21. Keep that load visible; project reuse removes
    // needless births, while fresh-project lifecycle tests still exercise it.
    maxWorkers: 6,
    sequence: { concurrent: ci, sequencer: SlowestFirstSequencer },
    maxConcurrency: 2,
    passWithNoTests: true,
    // Retry telemetry (policy rule 5 — see @iterate-com/shared
    // test-support/e2e-policy/budgets.ts): reporters DO belong at the root
    // test level and apply across projects — unlike `retry`, which vitest
    // only reads from each project config (see the note on the node project).
    reporters: ["default", new RetryTelemetryReporter()],
    projects: [
      {
        resolve: sharedResolve,
        test: {
          name: "node",
          environment: "node",
          // The engine e2e suites and the itx catalogue matrix are both node
          // black boxes against the deployed slot — one lane.
          include: ["./e2e/vitest/**/*.test.ts", "./e2e/examples/*.e2e.test.ts"],
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
