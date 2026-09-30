---
status: ready
size: small
---

# The e2e asks the deployed worker for its routing and MCP origin

Pre-work for moving apps/os into `core/`: apps/os's last `envs.ts` import. `envs.ts` is outside
core, and core never imports outside.

`apps/os/e2e/support/deployed-target.ts` turns `WORKER_BASE_URL` into what the suites need
against a deployment. The credentials already come from the deployment's own `APP_CONFIG`
(Doppler). The project routing and MCP origin come from `envs.ts`: the entry whose host the URL
is, or the per-PR deployment its worker name names.

The worker already answers both: `session.info()` returns `ingressRouting` and `mcpOrigin`, from
its app config ("safe bootstrap data for every app"). The suites hold the admin bearer, so
`deployedTarget` can open `/api`, authenticate as admin and ask. Every entry point that passes
only `WORKER_BASE_URL` (CI's preview runs, the soak, crash-hunt, latency and real-model workflows,
manual runs) keeps working unchanged.

Status: not started.

## Checklist

- [ ] `deployedTarget` reads routing and MCP origin from `session.info()`, not `envs.ts`; it
      becomes async
- [ ] its callers await it: `e2e/support/global-setup.ts`, `specs/setup.ts`
- [ ] `build.test.ts`'s outside-imports snapshot loses `envs.ts <- apps/os/e2e/support/deployed-target.ts`
- [ ] docs that say routing comes from `envs.ts` (`docs/testing.md`, `apps/os/e2e/AGENTS.md`,
      `docs/dev-environments.md`, comments)
- [ ] a deployed run: the vitest e2e against this PR's preview (CI's E2E tests) and prd's routing
      read by hand

## Out of scope

- The test helpers apps/os takes from `packages/shared` (failing-test, flake-test,
  fetch-safe-port, e2e-policy): a separate decision.

## Implementation notes
