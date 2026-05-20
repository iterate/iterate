# os e2e test infrastructure

Use this folder for Vitest end-to-end tests that exercise OS through public routes, local dev
servers, temporary workers, or mocked upstream services.

## Shape

- `vitest.config.ts` owns run-level config, artifact roots, and console capture.
- `test-support/e2e-test.ts` is the thin Vitest shell. Call `const e2e = await setupE2E(ctx)` in
  tests that need per-test artifacts, run slugs, or isolated stream paths.
- `test-support/create-mock-internet.ts` is the OS-owned mock internet fixture. It records HARs
  when `OS_E2E_RECORD_HAR=1` or the HAR file is missing, otherwise it replays with unhandled
  requests treated as errors.
- `test-support/create-local-dev-server.ts` starts OS locally, optionally with a Cloudflare tunnel.
- `test-support/create-test-project.ts` creates an OS project via public oRPC using the admin
  bearer token and deletes it on dispose.
- `test-support/os-client.ts` contains deployment-targeted oRPC/WebSocket helpers and stream
  waiters.

## Lanes

- Mocked internet tests run through `pnpm e2e -t "Project Egress Intercept Tunnel"`. They require
  `APP_CONFIG_BASE_URL` and an admin bearer token. The test opens a Project Egress Intercept Tunnel through
  the project-owned route instead of exposing the local mock server through Semaphore/Cloudflare
  Tunnel.
- Live deployment tests run through `pnpm e2e` and require `APP_CONFIG_BASE_URL`.
- MCP deployment smoke runs through `pnpm e2e -t "project MCP exec_js"`.
- Admin project fixture smoke requires `APP_CONFIG_BASE_URL` and one of `OS_E2E_ADMIN_API_SECRET`,
  `OS_ADMIN_API_SECRET`, or `APP_CONFIG_ADMIN_API_SECRET`.
- Stream TUI behavior specs run through `tsx ./e2e/tui-test/run.ts`. The script creates a
  disposable OS project before launching Microsoft TUI Test and deletes it afterward.

Prefer committed HAR fixtures under `e2e/vitest/__snapshots__/` for deterministic mocked-internet
tests. Use per-test artifact paths for smoke tests that only prove the fixture wiring.

OS does not install a global app-level egress proxy. Mocked-internet tests that need real OS traffic
should use `createProjectEgressInterceptTunnel` from `test-support/project-egress-intercept-tunnel.ts`.
