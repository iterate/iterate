# OS end-to-end tests

These Vitest tests exercise public OS routes against a live deployment. Browser product specs live in root `specs/`.

- `vitest.config.ts` owns selection, artifacts and console capture. `pnpm e2e` includes `vitest/**/*.test.ts`, the examples matrix, and its support tests.
- Use `test-support/os-client.ts` for the admin itx client and `test-support/create-test-project.ts` for isolated test projects. Do not share project state between tests.
- `itx-<topic>.e2e.test.ts` files are hand-written engine contracts. Fix product regressions rather than weakening assertions. The historical infix `.itx.` does not control test selection; omit it in new names.
- User-facing example scripts belong in `src/itx/examples-source.ts` and are exercised through `runExample()`. Protocol probes and incident repros use `itxScript()`; scripts in agent-chat fences use `defineItxScript()`.
- The TUI tests are quarantined; `tui-test/run.ts` reports a skip. See [the restoration task](../../../tasks/quarantined-tui-e2e.md), not the dormant specs, for current status.

Run from `apps/os`: `doppler run --config <config> -- pnpm e2e [-t <filter>]`. Environment variables, retries, timeouts and acceptance requirements are in [testing](../../../docs/testing.md).
