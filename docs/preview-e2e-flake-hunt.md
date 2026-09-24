# Preview e2e flake hunt

The evidence behind the retry policy in
[testing.md → Retries and timeouts](testing.md#retries-and-timeouts). The hunt
ran in July 2026 against the legacy platform's preview fleet, which #2837
removed. Most of its log describes systems that no longer exist; the full log
stays readable at
[`bf72f92bd`](https://github.com/iterate/iterate/blob/bf72f92bd76365e85533d4296fb3ddb239379f98/docs/preview-e2e-flake-hunt.md).
This page keeps only what still holds.

## The measurement

On 2026-07-05 the complete preview pipeline (a full deploy, then every e2e
suite) ran 50 times in a row on Depot, all green. The audit of those runs
([#1673](https://github.com/iterate/iterate/pull/1673)) counted about 5,800
test executions. About 0.5% needed a retry, none needed a second one, and
no mechanism above the individual test fired except on genuine
infrastructure wedges. Earlier streaks ended on real bugs, which were fixed,
and on Cloudflare platform faults: a Durable Object storage reset during a
Cloudflare incident, and a WebSocket that lost its connection 392 ms after
opening. A burst of such faults that defeats one retry fails the run, on
purpose.

That is why `E2E_CI_RETRIES` is 1, why only the test retries, and why
everything above it is a watchdog
([`budgets.ts`](../packages/shared/src/test-support/e2e-policy/budgets.ts)).
The numbers come from the legacy fleet. Today's evidence for or against them
is the retry telemetry and the
[flake dashboard](https://github.com/iterate/iterate/issues/2580).

## Lessons still in the code

- **Vitest does not inherit `retry` from the root config into `projects`.**
  For a while CI's single retry was a no-op. The retry is set on the `e2e`
  project in [`apps/os/vitest.config.ts`](../apps/os/vitest.config.ts), and the
  options vitest reads only at the root (`sequence`, `onUnhandledError`) say
  so beside them.
- **An unhandled rejection kills the vitest worker before a retry can
  engage.** A test's failure then produces no test output and is never retried.
  The root `onUnhandledError` in the same config swallows only known
  transport-teardown signatures. Every other rejection stays fatal.
- **A tight action timeout finds blank loading states.** A route that renders
  nothing while it loads gives the spinner-waiter nothing to extend on, so the
  wait fails. The hunt traced such a failure (flake 21 in the full log) to a
  product bug: an `ssr: false` subtree with no pending component. Every client app's router now sets
  `defaultPendingComponent` with `defaultPendingMs: 300`, and
  `SPEC_ACTION_TIMEOUT_MS` stays tight on purpose.
- **Extra tabs need the page plugins too.** A page from `context.newPage()`
  has no spinner-waiter. [`specs/test-support/test.ts`](../specs/test-support/test.ts)
  wraps every page a spec opens later.
- **Two visible spinners are a normal state.** middlewright's spinner-waiter
  counts any visible spinner as progress instead of asking a strict locator.
