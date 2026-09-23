# OS end-to-end tests

These Vitest tests exercise public OS routes against a live deployment: one real worker, local workerd by default or a deployed one. Browser product specs live in root `specs/`.

- `vitest.config.ts` (its `e2e` project) owns selection, global setup and concurrency. `pnpm e2e` includes `e2e/**/*.e2e.test.ts` and `apps/agents/e2e/**/*.e2e.test.ts`; every file runs in parallel and every test within a file concurrently.
- Use `support/client.ts` for the admin itx client (`openItx`) and `freshCtx` for isolated test projects. Do not share project state between tests; a file whose rows genuinely need an order says so itself (`describe.sequential`).
- `<topic>.e2e.test.ts` files are hand-written engine contracts. Fix product regressions rather than weakening assertions.

Run from the repository root: `pnpm e2e [-t <filter>]` boots a local worker. Against a deployment: `doppler run --project project-worker --config <config> -- env WORKER_BASE_URL=<url> pnpm e2e [-t <filter>]`; its credentials come from that config's `APP_CONFIG` (`support/deployed-target.ts`). Environment variables, retries, timeouts and acceptance requirements are in [testing](../../../docs/testing.md).
