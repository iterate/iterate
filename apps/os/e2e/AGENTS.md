# os e2e test infrastructure

Use this folder for Vitest end-to-end tests that exercise OS through public routes against a live
deployment (local dev, preview, or prod).

## Shape

Active e2e tests drive OS through **itx** — the same project capability handle the dashboard,
REPL, and CLI use. The oRPC product surface is gone; nothing here talks to oRPC anymore.

- `vitest.config.ts` owns run-level config, artifact roots, and console capture. `pnpm e2e` runs
  `e2e/vitest/**/*.test.ts` plus the itx e2e suites in `e2e/vitest/**/*.e2e.test.ts` through it.
- `test-support/os-client.ts` exposes the admin itx handle (`createAdminOsItx`) plus base-URL /
  bearer-token resolution.
- `test-support/create-test-project.ts` creates a disposable OS project via itx
  (`createTestProject` → `{ project, itx(), agent(path), [Symbol.asyncDispose] }`; removal is a
  no-op until itx grows `projects.remove`). `handle.itx()` returns a fresh admin itx
  handle narrowed to the project; reach streams and agents through it
  (`itx.streams.get(path).{append,getEvents,waitForEvent,subscribe}`,
  `itx.agents.get(path).{sendMessage,ask}`).

## Lanes

The usual invocation is `doppler run --config <config> -- pnpm e2e [-t <filter>]` from `apps/os`.
How to target local dev / previews / prd and the canonical env vars
(`APP_CONFIG_BASE_URL`, `APP_CONFIG_ADMIN_API_SECRET`, the `OS_E2E_*` harness knobs) are documented
in [docs/testing.md](../../../docs/testing.md).

- Live deployment tests: `pnpm e2e` (itx e2e suites in `e2e/vitest/`, agents, admin-project,
  preview smoke).
- Egress + secret substitution coverage lives in itx suite
  (`e2e/vitest/itx.e2e.test.ts`); the cross-runtime example matrix is `pnpm e2e:examples`
  (`e2e/examples/`).
- Preview smoke: `pnpm e2e -t "OS preview smoke"` (`preview-smoke.e2e.test.ts`) exercises a
  deployed preview, including its project MCP route (it derives its project slug from
  `GITHUB_SHA` when set).
- Stream TUI behavior specs: `tsx ./e2e/tui-test/run.ts` (see `tui-test/README.md`). The script
  creates a disposable OS project before launching Microsoft TUI Test and deletes it afterward.
