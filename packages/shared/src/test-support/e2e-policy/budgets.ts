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
 * 5. Retries are measured, never silent (RetryTelemetryReporter next door).
 *
 * scripts/preview/e2e-policy.test.ts asserts the ladder stays ordered and
 * that files which cannot import these constants (shell) stay in sync.
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
 * streams-example-app capnweb lane, where a fresh websocket died and the
 * instant re-roll died the same way within the same second (post-deploy
 * rollout propagation / a brief edge wobble). 5s is longer than every blip
 * observed and far below the lane watchdogs. Playwright needs no equivalent:
 * its retry tears down and rebuilds the whole browser worker, which takes
 * seconds by construction.
 */
export const E2E_CI_RETRY_DELAY_MS = 5_000;

/**
 * Playwright per-action wait. Deliberately tight: the middlewright
 * spinner-waiter extends it (up to ~30s) only while the app visibly reports
 * progress, so an app that goes blank fails fast instead of being slept
 * through. This tightness is what caught the blank `ssr: false` outlet bug
 * (flake 21) — do not widen it to paper over a missing loading state.
 */
export const SPEC_ACTION_TIMEOUT_MS = 750;

/** Playwright `expect` polling budget — one UI assertion, not a whole flow. */
export const SPEC_EXPECT_TIMEOUT_MS = 15_000;

/** Playwright per-spec budget: a full product flow against a deployed slot. */
export const SPEC_TEST_TIMEOUT_MS = 90_000;

/**
 * Vitest e2e per-test/per-hook budget: one itx flow against a deployed slot,
 * including a project create saga (~3-5s cold, see #1601) with ample headroom.
 */
export const E2E_TEST_TIMEOUT_MS = 120_000;

/**
 * Ceiling for individual heavy tests that pay a container cold boot (sandbox
 * exec, worker build, slack agent turns). Tests opt in per-test with
 * `{ timeout: ... }`; nothing under apps/os/e2e may exceed this (guarded).
 */
export const E2E_HEAVY_TEST_TIMEOUT_MS = 240_000;

/**
 * Watchdog on each preview sub-lane (`timeout N pnpm e2e` and
 * `timeout N pnpm spec` in scripts/preview/preview.ts). Kills, never
 * retries: a lane that blows this is wedged, not slow — before the specs
 * lane was bounded, a wedged onboarding agent stretched one preview test
 * step to 13 minutes (2026-07-09, run dpmddk1b75).
 *
 * "Healthy" includes one absorbed heavy-test retry: since #1826 the agent
 * processor spaces LLM retries 10/20/40s apart, so an agent test whose first
 * attempt eats a Workers-AI rate-limit blip legitimately takes ~190s before
 * its re-roll passes (observed on the slack-agent e2e). A 360s ceiling
 * killed an all-green lane bloated by exactly that. Both sub-lanes run
 * concurrently, so even a fully watchdogged attempt stays inside the
 * preview job's 10-minute timeout-minutes ceiling.
 */
export const OS_PREVIEW_LANE_TIMEOUT_SECS = 480;

/**
 * Watchdog on one whole preview e2e run (flake-hunt-loop.sh, marathon). A
 * healthy full-fleet run is a few minutes; per rule 3 this deliberately does
 * NOT budget for a test double-burning its heavy-cap retry — both historical
 * watchdog kills were genuine infra wedges where retrying was hopeless.
 */
export const PREVIEW_RUN_WATCHDOG_SECS = 600;
