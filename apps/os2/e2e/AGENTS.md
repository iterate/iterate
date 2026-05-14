# os2 e2e test infrastructure

Use this folder for Vitest end-to-end tests that exercise OS2 through public routes, local dev
servers, temporary workers, or mocked upstream services.

## Shape

- `vitest.config.ts` owns run-level config, artifact roots, and console capture.
- `test-support/e2e-test.ts` is the thin Vitest shell. Call `const e2e = await setupE2E(ctx)` in
  tests that need per-test artifacts, run slugs, or isolated stream paths.
- `test-support/create-mock-internet.ts` is the OS2-owned mock internet fixture. It records HARs
  when `OS2_E2E_RECORD_HAR=1` or the HAR file is missing, otherwise it replays with unhandled
  requests treated as errors.
- `test-support/create-local-dev-server.ts` starts OS2 locally, optionally with a Cloudflare tunnel.
- `test-support/create-test-project.ts` creates an OS2 project via public oRPC using the admin
  bearer token and deletes it on dispose.
- `test-support/tmp-rescued-from-agents/` holds raw agents helper copies for later adaptation. Do
  not import these directly.
- `test-support/os2-client.ts` contains deployment-targeted oRPC/WebSocket helpers and stream
  waiters.

## Lanes

- Mocked internet tests run through `pnpm test:e2e:mocked-internet`. They require `OS2_BASE_URL`
  or `APP_CONFIG_BASE_URL`, an admin bearer token, and `SEMAPHORE_API_TOKEN` so deployed OS2 can
  reach the local mock proxy through a Cloudflare tunnel.
- Live deployment tests run through `pnpm test:e2e` and require `OS2_BASE_URL`.
- MCP deployment smoke runs through `pnpm test:e2e:codemode-mcp`.
- Admin project fixture smoke runs when `OS2_BASE_URL` and one of `OS2_E2E_ADMIN_API_SECRET`,
  `OS2_ADMIN_API_SECRET`, or `APP_CONFIG_ADMIN_API_SECRET` is set.
- Stream TUI behavior specs run through `pnpm test:e2e:tui`. The script creates a disposable OS2
  project before launching Microsoft TUI Test and deletes it afterward.

Prefer committed HAR fixtures under `e2e/vitest/__snapshots__/` for deterministic mocked-internet
tests. Use per-test artifact paths for smoke tests that only prove the fixture wiring.

OS2 does not currently install a global app-level egress proxy. Mocked-internet tests that need real
OS2 traffic should configure a project-level `externalEgressProxyUrl`.
