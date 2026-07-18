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
// `pnpm preview test` also runs from developer machines. Its target is the
// same isolated deployed slot as CI, so exercise the production concurrency
// profile there too; only direct local-dev-server runs stay sequential.
const parallelDeployedSuite = ci || process.env.E2E_PREVIEW_PARALLEL === "1";

// Observed wall-clock seconds per file on a zero-retry preview lane (Depot run
// r9whdcvbwl, 2026-07-18). Used for longest-first scheduling below — vitest
// hands files to workers in sort order, so a slow file starting LAST becomes
// the whole lane's tail (the itx catalogue at ~100s used to routinely start
// mid-run and stretch the lane past 3 minutes). Unlisted files default to 15s
// (roughly the observed median); exact numbers matter much less than the
// slow/fast partition, so refresh only when the ranking visibly drifts.
const observedFileSeconds: Record<string, number> = {
  "examples-matrix.e2e.test.ts": 72,
  "itx-workers.e2e.test.ts": 66,
  "project-ingress.e2e.test.ts": 61,
  "script-execution-concurrency.e2e.test.ts": 46,
  "sandbox-timeout.e2e.test.ts": 46,
  "agent-response-cache.e2e.test.ts": 35,
  "itx-agents.e2e.test.ts": 33,
  "stateful-worker-alarm.e2e.test.ts": 30,
  "workspace.itx.e2e.test.ts": 26,
  "sandbox-egress.e2e.test.ts": 25,
  "streams.e2e.test.ts": 23,
  "agent-tools.itx.e2e.test.ts": 22,
  "itx-egress.e2e.test.ts": 21,
  "itx-connect.e2e.test.ts": 21,
  "integrations-userspace.e2e.test.ts": 18,
  "slack-agent.e2e.test.ts": 17,
  "worker-build.e2e.test.ts": 17,
  "agent-script-result-spill.itx.e2e.test.ts": 17,
  "repo-history.itx.e2e.test.ts": 16,
  "agent-handle-pipelining.itx.e2e.test.ts": 15,
  "agent-codemode-fence.itx.e2e.test.ts": 14,
  "integrations-petshop.e2e.test.ts": 14,
  "github-backed-repo.e2e.test.ts": 14,
  "stream-ancestor-announcements.e2e.test.ts": 13,
  "integrations-github.e2e.test.ts": 12,
  "admin-project.itx.e2e.test.ts": 12,
  "live-capability-websocket.e2e.test.ts": 12,
  "itx-subscribe.e2e.test.ts": 12,
  "itx-live-capabilities.e2e.test.ts": 11,
  "worker-stale-serve.e2e.test.ts": 11,
  "guestbook-wake.e2e.test.ts": 11,
  "scheduler.e2e.test.ts": 10,
  "live-state.e2e.test.ts": 10,
  "egress-approvals.e2e.test.ts": 10,
  "stream-wire.e2e.test.ts": 9,
  "itx-core.e2e.test.ts": 9,
  "worker-build-version.e2e.test.ts": 9,
  "repo-binary.itx.e2e.test.ts": 9,
  "stream-security.e2e.test.ts": 7,
  "preview-smoke.e2e.test.ts": 6,
  "operator-sessions.e2e.test.ts": 1,
  "mcp-oauth.e2e.test.ts": 0,
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
    // reads them, even with `projects`. Parallel in CI: each file either uses
    // unique state or a bounded family-owned project pool, so FILES are
    // independent. `pnpm preview test` uses the same parallel profile even
    // outside CI; direct runs against a local dev server remain sequential.
    fileParallelism: parallelDeployedSuite,
    // 12 workers × maxConcurrency 2 = peak ~24 concurrent tests. History of
    // this number: 4×4 = ~16 overloaded a very cold slot pre-#1601
    // (DO-storage timeouts), 4×3 = ~12 still produced rotating
    // stream-delivery timeouts on #1638's runs, so it sat at 4×2 = ~8 for a
    // while. Peak 12 was subsequently revalidated green, and the 2026-07-18
    // trace audit showed project birth taking ~1,067 aggregate seconds across
    // 176 successful creates without a capacity failure. The failures seen at
    // lower concurrency were product lifecycle defects, not evidence that the
    // preview slot needed protection from independent tests. The preview
    // runner overlaps this peak with Playwright's twelve workers, one TUI test,
    // and the one-project onboarding smoke: aggregate peak 38. Experiment 5
    // cut Vitest from 210s to 138s at six workers; its only retry was a traced,
    // explicitly marked cold-build response rather than a capacity rejection.
    // Experiment 6 ran an aggregate peak of 30 with zero retries and no
    // capacity failures; Experiments 8 and 10 ran the configured peak of 38.
    // Experiment 7's one retry was a proven assertion race:
    // the test read history before an independently projected context event,
    // despite every service operation succeeding. Keep that load visible;
    // project reuse removes needless births, while fresh-project lifecycle
    // tests still exercise project creation.
    maxWorkers: 12,
    sequence: { concurrent: parallelDeployedSuite, sequencer: SlowestFirstSequencer },
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
          // through a fresh project, unique resource names, or an exclusive
          // family-pool lease, so a rare platform blip can re-run without
          // colliding with another test. A burst that defeats the single retry fails the run —
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
