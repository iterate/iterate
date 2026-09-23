# Testing

Run commands from the repository root unless stated otherwise.

| Command                                  | Coverage                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| `pnpm typecheck`                         | Every retained workspace                                                       |
| `pnpm lint`                              | Source lint and applicable repository rules                                    |
| `pnpm format:check`                      | Formatting                                                                     |
| `pnpm test`                              | Workspace unit tests, including os-next's unit and Workers projects            |
| `pnpm e2e`                               | os-next integration suite; local Worker unless a deployed target is configured |
| `pnpm spec`                              | Chromium issuer and mini-app browser flows, plus mobile-width authentication   |
| `pnpm --dir apps/kit firmware:test:host` | Firmware host tests                                                            |

The platform's [Vitest config](../apps/os-next/vitest.config.ts) defines unit, Workers, e2e, and benchmark projects. Its [Playwright config](../apps/os-next/playwright.config.ts) starts a local Worker or uses `DEMO_BASE_URL`. Set `WORKER_BASE_URL` for deployed integration tests and supply that deployment's credentials as described in the [platform README](../apps/os-next/README.md).

Tests own their project state. Retry only at the test boundary, keep recovery bounded, and report first-attempt failures through test telemetry. Fix product regressions; do not widen timeouts or silently skip tests to make them green. A fake must state which runtime behavior it cannot prove.

The Depot Test workflow runs workspace tests and uploads normalized telemetry. Production deployment runs the integration suite against the deployed platform. The Preview OS-Next workflow deploys a per-PR platform and all four hosted clients, then runs integration and browser tests. Operational changes require coherent preview state and telemetry as well as passing tests; see the [engineering invariant](engineering-invariants.md).
