# Testing

Run commands from the repository root unless stated otherwise.

| Command                                  | Coverage                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `pnpm typecheck`                         | Every retained workspace                                                     |
| `pnpm lint`                              | Source lint and applicable repository rules                                  |
| `pnpm format:check`                      | Formatting                                                                   |
| `pnpm knip`                              | Unused files, exports and dependencies (OS, Kit, shared, UI, SDK/CLI)        |
| `pnpm test`                              | Workspace unit tests, including OS unit and Workers projects                 |
| `pnpm e2e`                               | OS integration suite; local Worker unless a deployed target is configured    |
| `pnpm spec`                              | Chromium issuer and mini-app browser flows, plus mobile-width authentication |
| `pnpm --dir apps/kit firmware:test:host` | Firmware host tests                                                          |

The platform's [Vitest config](../apps/os/vitest.config.ts) defines unit, Workers, e2e, and benchmark projects. Its [Playwright config](../apps/os/playwright.config.ts) starts a local Worker or uses `DEMO_BASE_URL`. Set `WORKER_BASE_URL` for deployed integration tests and supply that deployment's credentials as described in the [platform README](../apps/os/README.md). For test style (`test.for` tables with literal expectations, polling instead of sleeps), see [Vitest patterns](vitest-patterns.md).

Tests own their project state. Retry only at the test boundary, keep recovery bounded, and report first-attempt failures through test telemetry. Fix product regressions; do not widen timeouts or silently skip tests to make them green. A fake must state which runtime behavior it cannot prove.

## Parked tests expire

A `skip`, `fixme`, or `todo` marker that parks a known issue carries its terms beside the marker:

```ts
// parked: <what is broken, with evidence> — revisit by 2026-11-15
test.skip("…", () => {});
```

Undated markers are for structural reasons only: env- or platform-gated cases that cannot run against a given target. They are allowlisted with a note in [`lint/dated-skips.test.ts`](../lint/dated-skips.test.ts), which runs in `pnpm test` and fails on any `revisit by` date in the past. An expired date is a decision: fix and un-park the test, or renew the date with the reason re-argued. `test.fails` needs no date; it runs, and turns red once the bug is fixed.

## Flakes and pinned failures

Two wrappers in `packages/shared/src/test-support` register through the runner's own expected-fail variant (Vitest `test.fails`, Playwright `test.fail`) and let exactly one error pattern through:

- `createFlake(test, /pattern/)` ([flake-test.ts](../packages/shared/src/test-support/flake-test.ts)) marks a known flake. The body asserts real behavior. A pass or a failure matching the pattern is green, any other failure or a hang is red, and the test is never retried: one sample per run.
- `createFailing(test, /pattern/)` ([failing-test.ts](../packages/shared/src/test-support/failing-test.ts)) pins a known bug. The body asserts the desired behavior and must fail with the pattern. A pass (the bug looks fixed) or a different failure is red. A bare `test.fails` behind a guard that returns early on the wrong failure does the same job.

Every outcome of either wrapper, and every plain test that failed and then passed on its CI retry (an unknown flake, with the first attempt's error), is one JSON line in `FLAKE_RECORD_DIR`. The CI finalizer (`scripts/ci/upload-test-telemetry.ts --flake-suites <unit|preview>`) adds each suite's `suite-summary.json`, and the job uploads `flake-records-<suite>` artifacts for the flake dashboard to fold. Local runs without the variable record nothing.

Each suite carries a monthly `flake sentinel`: a `createFlake` test that throws its allowed error about 10% of the time until its month ends. A sentinel that reads 0% or goes red means the pipeline is broken. When its month ends, roll the date forward instead of unwrapping it.

The Depot Test workflow runs workspace tests and keeps their normalized telemetry as a job artifact; PostHog delivery has been off since #2494. Production deployment runs the integration suite against the deployed platform. The Preview OS workflow deploys a per-PR platform and all four hosted clients, then runs integration and browser tests. Operational changes require coherent preview state and telemetry as well as passing tests; see the [engineering invariant](engineering-invariants.md).
