# os e2e test infrastructure

Use this folder for Vitest end-to-end tests that exercise OS through public routes against a live
deployment (dev tunnel, preview, or prod).

## Shape

- `vitest.config.ts` owns run-level config, artifact roots, and console capture. `pnpm e2e` runs
  `e2e/vitest/**/*.test.ts` through it.
- `test-support/create-test-project.ts` creates an OS project via public oRPC using the admin
  bearer token and deletes it on dispose (`createTestProject` / `createTestProjectFixture`). The
  fixture's `egressFetch` option shadows the project's `fetch` capability with a live itx cap
  (intercepting all project egress for the fixture's lifetime); it also exports
  `createPublicTunnel` (captun tunnel for test-defined HTTP servers).
- `test-support/os-client.ts` contains deployment-targeted oRPC/WebSocket helpers and stream
  waiters.

## Lanes

All Vitest lanes require `APP_CONFIG_BASE_URL` plus an admin credential (one of
`OS_E2E_ADMIN_API_SECRET`, `OS_ADMIN_API_SECRET`, `APP_CONFIG_ADMIN_API_SECRET`; some helpers also
accept `OS_E2E_BEARER_TOKEN` or `OS_E2E_COOKIE`). The usual invocation is
`doppler run --config <config> -- pnpm e2e [-t <filter>]` from `apps/os` — the config supplies the
base URL: `prd` → `os.iterate.com`, `preview_N` → `os.iterate-preview-N.com`, `dev_<you>` → your
tunnel, `dev_localhost` → `http://localhost:<port>`.

Exception: the fully-local `dev` config (random port, parallel-safe) has **no** `APP_CONFIG_BASE_URL`,
so `doppler run --config dev -- pnpm e2e` fails the base-URL check. Target a `dev_<you>` tunnel or
`dev_localhost` instead, or override explicitly:
`OS_ITX_E2E_BASE_URL=http://os.localhost:<port> doppler run --config dev -- pnpm e2e`.

- Live deployment tests: `pnpm e2e` (agents, admin-project suites).
- Egress interception: itx script `fetch` rides project egress; the fetch-cap shadowing coverage
  lives in the itx e2e suite (`pnpm e2e:itx`, `itx-egress.e2e.test.ts`).
- MCP deployment smoke: `pnpm e2e -t "project MCP exec_js"`.
- Preview smoke: `preview-smoke.e2e.test.ts` exercises a deployed preview's project MCP route
  (it derives its project slug from `GITHUB_SHA` when set).
- Stream TUI behavior specs: `tsx ./e2e/tui-test/run.ts` (see `tui-test/README.md`). The script
  creates a disposable OS project before launching Microsoft TUI Test and deletes it afterward.
