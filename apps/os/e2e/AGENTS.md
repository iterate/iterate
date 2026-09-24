# OS end-to-end tests

These Vitest tests exercise public OS routes against a live deployment: one real worker, local workerd by default or a deployed one. Browser product specs live in root `specs/`.

- `vitest.config.ts` (its `e2e` project) owns selection, global setup and concurrency. `pnpm e2e` includes `e2e/**/*.e2e.test.ts` and `apps/agents/e2e/**/*.e2e.test.ts`; every file runs in parallel and every test within a file concurrently.
- Use `support/client.ts` for the admin itx client (`openItx`) and `freshCtx` for isolated test projects. Do not share project state between tests; a row that genuinely needs an order says so itself (`test.sequential`, or `test.sequential.for` for a table; `iterate/no-describe` bans `describe`, see [test-style rules](../../../lint/test-style-rules.md)).
- `<topic>.e2e.test.ts` files are hand-written engine contracts. Fix product regressions rather than weakening assertions.
- No wall-clock budgets in e2e rows: beside 15 other files a latency measures the suite's contention. A latency or throughput budget is a `perf/<topic>.perf.test.ts` row (`pnpm perf`), which runs alone; its loads live in `support/` so the e2e row proves the same load correct.
- Assert only what the deployment guarantees. A read Cloudflare documents as eventually consistent (a KV `list` after a write, up to about 60 s) is not a deadline to wait on here; pin that logic in the workers project (`__workers-tests__/`), where miniflare's KV reads its own writes (`kv-list-pagination.test.ts`).

Run from the repository root: `pnpm e2e [-t <filter>]` boots a local worker. Against a deployment: `doppler run --project project-worker --config <config> -- env WORKER_BASE_URL=<url> pnpm e2e [-t <filter>]`; its credentials come from that config's `APP_CONFIG` (`support/deployed-target.ts`). Environment variables, retries, timeouts and acceptance requirements are in [testing](../../../docs/testing.md).
