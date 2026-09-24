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
