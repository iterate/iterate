import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { playwright } from "@vitest/browser-playwright";
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
import { resolveBaseUrl } from "./test-support/dev-server.ts";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const e2eRoot = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

const vitestRunSlug = createVitestRunSlug();
const vitestRunRoot = createVitestRunRoot("os-e2e-");
const baseUrl = resolveBaseUrl(appRoot) ?? "";

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

// One e2e suite, two projects. Both drive a real deployed OS
// (APP_CONFIG_BASE_URL — local dev, preview, or prod); the split is only the
// runtime the test code executes in. `pnpm e2e` runs everything; preview CI
// runs `pnpm e2e --project node` (the browser catalogue is also covered by the
// root Playwright REPL specs, so it stays out of the preview lane).
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
    // while. Since then the slot got materially cheaper per test (#1601
    // cold creates, #1801 eviction recovery, #1806 drain collapse, #1808
    // agent processor consolidation), the onboarding smoke pre-warms the
    // create path before the fan-out, and the lane's 634 test-seconds at
    // peak 8 left the 8-core Depot box mostly idle at ~186s wall. Peak 12
    // via FILE parallelism (safer than intra-file per
    // tasks/raise-e2e-maxconcurrency.md) measured green — revalidate with a
    // preview-e2e-marathon dispatch when touching either knob.
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
      {
        define: {
          __ITX_BROWSER_E2E__: JSON.stringify({
            baseUrl,
          }),
        },
        resolve: sharedResolve,
        test: {
          name: "browser",
          include: ["./e2e/examples/examples-browser.test.ts"],
          provide: sharedProvide,
          testTimeout: 45_000,
          hookTimeout: 45_000,
          // See the node project: `retry` must live on each project config,
          // and one retry is the policy.
          retry: ci ? { count: E2E_CI_RETRIES, delay: E2E_CI_RETRY_DELAY_MS } : 0,
          browser: {
            commands: {
              // The test page deliberately lives on Vitest's origin. Mint an
              // explicit short-lived grant server-side instead of exposing
              // the deployment admin secret to that browser bundle.
              async mintItxOperatorToken(_context: any, input: { url: string }) {
                const secret = process.env.APP_CONFIG_ADMIN_API_SECRET?.trim();
                if (!secret) throw new Error("APP_CONFIG_ADMIN_API_SECRET is required.");
                const response = await fetch(new URL("/api/operator-sessions", input.url), {
                  body: JSON.stringify({
                    kind: "admin",
                    operatorId: "itx-browser-e2e",
                    ttlSeconds: 900,
                  }),
                  headers: {
                    authorization: `Bearer ${secret}`,
                    "content-type": "application/json",
                  },
                  method: "POST",
                });
                if (!response.ok) {
                  throw new Error(
                    `operator session issuance failed (${response.status}): ${await response.text()}`,
                  );
                }
                const result = (await response.json()) as { token?: unknown };
                if (typeof result.token !== "string") throw new Error("issuer returned no token");
                return { token: result.token };
              },
            },
            enabled: true,
            headless: true,
            instances: [{ browser: "chromium" }],
            provider: playwright(),
          },
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
