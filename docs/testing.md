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

The Depot Test workflow runs workspace tests and uploads normalized telemetry. Production deployment runs the integration suite against the deployed platform. The Preview OS workflow deploys a per-PR platform and all four hosted clients, then runs integration and browser tests. Operational changes require coherent preview state and telemetry as well as passing tests; see the [engineering invariant](engineering-invariants.md).
