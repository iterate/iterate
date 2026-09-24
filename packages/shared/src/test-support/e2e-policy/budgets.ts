/**
 * The e2e retry policy and timeout ladder, in one place.
 *
 * The policy (evidence and rationale: docs/testing.md#retries-and-timeouts,
 * distilled from the 50-run marathon audit in docs/preview-e2e-flake-hunt.md):
 *
 * 1. Retries live in exactly ONE layer: the individual test — the smallest
 *    unit that owns its state (every test provisions its own project). One
 *    retry in CI, zero locally.
 * 2. Everything above a test is a watchdog: it fails, it never retries.
 *    Re-running is the outer edge's job (Depot re-run / next push).
 * 3. Watchdogs are sized to ~2x the healthy p99 of what they bound — never
 *    to accommodate worst-case retry stacks. A run burning retries against a
 *    wedged platform SHOULD get killed.
 * 4. Waits are progress-based (spinner-waiter); static budgets are backstops.
 * 5. Retries are measured, never silent (RetryTelemetryReporter, beside this file).
 */

/**
 * Per-test retries in CI, everywhere (vitest `retry`, playwright `retries`).
 * One, not two: across the 50-green-run marathon audit (~5,800 test
 * executions) no test ever needed a second retry, and a platform-incident
 * burst that defeats a single retry should fail the run — weather we want to
 * see, not absorb. Zero locally so a flaky test stays loud at your desk.
 */
export const E2E_CI_RETRIES = 1;

/**
 * Pause before the vitest retry (vitest `retry.delay`). Zero-delay retries
 * re-run INTO the blip that failed the first attempt: observed twice on the
 * streams-example-app capnweb suite, where a fresh websocket died and the
 * instant re-roll died the same way within the same second (post-deploy
 * rollout propagation / a brief edge wobble). 5s is longer than every blip
 * observed and far below any test timeout. Playwright needs no equivalent:
 * its retry tears down and rebuilds the whole browser worker, which takes
 * seconds by construction.
 */
export const E2E_CI_RETRY_DELAY_MS = 5_000;

/**
 * THE ROW BUDGET. The e2e run starts every file at once and every row within a file concurrently,
 * so its wall is its startup plus its slowest row: one slow row makes every PR wait for it
 * (docs/testing.md#the-row-budget). A row that runs on every PR finishes within
 * `E2E_ROW_BUDGET_MS` at its p95. RetryTelemetryReporter prints each e2e row that ran longer than
 * `E2E_ROW_WARN_MS` (`[row-budget]`), and the flake dashboard's Cost section proposes making a row
 * faster, or tagging it `slow`, once its p95 passes the budget.
 */
export const E2E_ROW_WARN_MS = 45_000;
export const E2E_ROW_BUDGET_MS = 60_000;

/**
 * The longest timeout an e2e row that runs on every PR may declare: a hung row holds the run for
 * its timeout, twice with `E2E_CI_RETRIES`. scripts/ci/e2e-policy.test.ts reads every row's
 * declared timeout; only an `E2E_BUDGET_EXEMPTIONS` entry with its own `timeoutMs` goes higher.
 */
export const E2E_ROW_TIMEOUT_CEILING_MS = 90_000;

/**
 * The longest fixed wait (`sleep`, `setTimeout`) an e2e row that runs on every PR may make. A row
 * that has to wait out real platform time (a quiet minute, a sweep, an alarm) is a `slow` row.
 */
export const E2E_SLEEP_CEILING_MS = 30_000;

/** The timeout of a `slow` row: one that waits real platform time and does not run on every PR. */
export const E2E_SLOW_ROW_TIMEOUT_MS = 300_000;

/**
 * Rows over the budget on purpose, by title: each guards a production incident or a behaviour no
 * faster row can show. The reporter marks them exempt, and the Cost section never proposes them
 * for `slow` or deletion, only for making faster. `timeoutMs` is the row's own timeout when it
 * needs more than `E2E_ROW_TIMEOUT_CEILING_MS`.
 */
export const E2E_BUDGET_EXEMPTIONS: Record<string, { reason: string; timeoutMs?: number }> = {
  "a facet's claimed background work finishes across its context's incarnations, and no birth resets the claimed facet":
    {
      reason:
        "the one residency row that guards behaviour, not cost: work started with runInBackground survives its context's birth. It sleeps 60 s of real platform time so the claim's alarm lands mid-sleep, then waits up to 30 s for the work",
      timeoutMs: 120_000,
    },
  "a website project's facets do not outlive their contexts after a page load": {
    reason:
      "guards the 2026-09-22 residency billing incident: after one page load a website project's facets were billed every minute until the next deploy",
  },
  "creating a repo does not keep the project root resident": {
    reason:
      "guards the 2026-09-22 residency billing incident: handles kept contexts resident and billed around the clock",
  },
  "a repo read through its facet does not keep its own context resident": {
    reason:
      "guards the 2026-09-22 residency billing incident: handles kept contexts resident and billed around the clock",
  },
};

/**
 * Changing one of these files runs the `slow` e2e rows on the PR: the code whose residency and
 * alarm behaviour those rows prove, and the rows themselves.
 */
export const SLOW_ROW_PATHS = [
  "apps/os/src/context/facet-host.ts",
  "apps/os/src/context/residency.ts",
  "apps/os/src/context/rpc-stubs.ts",
  "apps/os/src/context/built-ins.ts",
  "apps/os/src/iterate-context-durable-object.ts",
  "apps/os/src/alarm-coordinator.ts",
  "apps/os/src/project/processor.ts",
  "packages/iterate/src/stream/processor.ts",
  "apps/os/wrangler.base.jsonc",
  "apps/os/e2e/context-residency.e2e.test.ts",
  "apps/os/e2e/support/residency-facets.ts",
];

/**
 * The Test job's row budget: the telemetry finalizer (scripts/ci/upload-test-telemetry.ts) prints
 * every unit or Workers row that ran longer than this and is not listed below. A warning only.
 */
export const UNIT_ROW_WARN_MS = 10_000;

/** Unit and Workers rows that wait a real deadline on purpose, by title, with the reason. */
export const UNIT_ROW_WARN_EXEMPTIONS: Record<string, string> = {
  "a push the watchdog timed out is caught up from the log by the restarted facet — no later event needed, reduced exactly once":
    "waits the facet push watchdog's real 60 s window",
  "a live session rides out a deploy's Durable Object reset during its re-check":
    "waits the grant's real 30 s re-check",
  "a socket holding no project re-checks its grant every thirty seconds and reads no membership":
    "waits the grant's real 30 s re-check",
  "a live session loses held capabilities after membership within 60 seconds":
    "waits the grant's real 30 s re-check",
  "a live session loses held capabilities after revoked within 60 seconds":
    "waits the grant's real 30 s re-check",
  "NO PIN ARMS AN ALARM: a facet owes nothing (a loaded one arms only the in-memory unclaimed-facet sweep), a borrowed stub arms nothing — the stub is returned by a TIMER 30 s after its last use, and a call after that borrows it again":
    "waits the borrowed stub's real 30 s release timer",
  "cursor rows: 160 cursor rows fed 900 KiB ephemerals retain the ring and the in-flight batches, never a batch per row":
    "a heap-capped child process; its cursor watchdogs keep it alive after its report",
  "control: 2 cursor rows fed 900 KiB ephemerals from the ring stay within the budget":
    "a heap-capped child process; its cursor watchdogs keep it alive after its report",
  "cursor rows: 20 behind cursor rows and ONE commit — the commit path drains them under the in-flight budget, never a page per row at once":
    "a heap-capped child process",
};

/**
 * Playwright per-action wait — ONE number, every project, video mode
 * included. Deliberately tight: the middlewright spinner-waiter extends it
 * (up to ~30s) only while the app visibly reports progress, so an app that
 * goes blank fails fast instead of being slept through. This tightness is
 * what caught the blank `ssr: false` outlet bug (flake 21) — do not widen
 * it to paper over a missing loading state.
 *
 * To future agents tempted to re-add a video-mode or mobile override: this
 * number was set after removing unmeasured 5s/10s margins. Video mode's
 * runtime cost is one click-moment screenshot (~100-300ms — pointer
 * animation and holds are post-production). If a flake tempts you to raise
 * this, measure the actual action latency first.
 */
export const SPEC_ACTION_TIMEOUT_MS = 1_000;

/** Playwright `expect` polling budget — one UI assertion, not a whole flow. */
export const SPEC_EXPECT_TIMEOUT_MS = 15_000;

/** Playwright per-spec budget: a full product flow against the deployed preview or local worker. */
export const SPEC_TEST_TIMEOUT_MS = 240_000;
