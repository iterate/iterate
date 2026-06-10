# os e2e test infrastructure

Use this folder for Vitest end-to-end tests that exercise OS through public routes against a live
deployment (dev tunnel, preview, or prod).

## Shape

- `vitest.config.ts` owns run-level config, artifact roots, and console capture. `pnpm e2e` runs
  `e2e/vitest/**/*.test.ts` through it.
- `test-support/e2e-test.ts` is the thin Vitest shell. Call `const e2e = await setupE2E(ctx)` in
  tests that need per-test artifacts, run slugs, or isolated stream paths.
- `test-support/create-test-project.ts` creates an OS project via public oRPC using the admin
  bearer token and deletes it on dispose (`createTestProject` / `createTestProjectFixture`). It
  also exports `createProjectEgressInterceptTunnel` (captun tunnel to the project's
  `/__iterate/intercept-project-egress` route) and `createPublicTunnel`.
- `test-support/os-client.ts` contains deployment-targeted oRPC/WebSocket helpers and stream
  waiters.
- `test-support/codemode-builder.ts` builds and appends codemode script-execution events for a
  test project.

## Lanes

All Vitest lanes require `APP_CONFIG_BASE_URL` plus an admin credential (one of
`OS_E2E_ADMIN_API_SECRET`, `OS_ADMIN_API_SECRET`, `APP_CONFIG_ADMIN_API_SECRET`; some helpers also
accept `OS_E2E_BEARER_TOKEN` or `OS_E2E_COOKIE`). The usual invocation is
`doppler run --config <config> -- pnpm e2e [-t <filter>]` from `apps/os`.

- Live deployment tests: `pnpm e2e` (agents, codemode, admin-project, e2e-test-map suites).
- Egress interception: `pnpm e2e -t "Project Egress Intercept Tunnel"` — codemode `fetch` is
  captured through a Project Egress Intercept Tunnel opened on the project-owned route, so tests
  can mock the project's outbound traffic without exposing a local server.
- MCP deployment smoke: `pnpm e2e -t "project MCP exec_js"`.
- Preview smoke: `preview-smoke.e2e.test.ts` exercises a deployed preview's project MCP route
  (it derives its project slug from `GITHUB_SHA` when set).
- Stream TUI behavior specs: `tsx ./e2e/tui-test/run.ts` (see `tui-test/README.md`). The script
  creates a disposable OS project before launching Microsoft TUI Test and deletes it afterward.
