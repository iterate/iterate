---
status: done
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

Status: code done, verified by hand against prd and the preview parent; CI's E2E tests and Browser specs exercise the per-PR preview.

## Checklist

- [x] `deployedTarget` reads routing and MCP origin from `session.info()`, not `envs.ts`; it
      becomes async _opens `/api` bare, authenticates as admin, zod-parses the two fields_
- [x] its callers await it: `e2e/support/global-setup.ts`, `specs/setup.ts` _specs' `setup` is async now_
- [x] `build.test.ts`'s outside-imports snapshot loses `envs.ts <- apps/os/e2e/support/deployed-target.ts`
- [x] docs that say routing comes from `envs.ts` (`docs/testing.md`, `apps/os/e2e/AGENTS.md`,
      `docs/dev-environments.md`, comments) _testing.md (4 places), dev-environments.md, preview.ts, project-host.ts, global-setup.ts; e2e/AGENTS.md never said it_
- [x] a deployed run: the vitest e2e against this PR's preview (CI's E2E tests) and prd's routing
      read by hand _prd and the preview parent match envs.ts exactly; the per-PR preview is CI's_

## Out of scope

- The test helpers apps/os takes from `packages/shared` (failing-test, flake-test,
  fetch-safe-port, e2e-policy): a separate decision.

## Implementation notes

- `session.ts`'s `IterateRpcTarget` type can't be imported: `specs/setup.ts` reaches this file,
  and session.ts's types pull in the Workers types, which `specs/tsconfig.json` lacks
  (`pnpm typecheck:specs` failed on `ExecutionContext`). So the transport is `any` and the
  answer goes through a zod schema, which also fails loudly if `info()` ever drops a field.
- By hand, under `doppler run --project os --config <prd|preview>`: prd reports
  `{"type":"subdomains","hostname":"iterate.app"}` and `https://mcp.iterate.com`, the preview
  parent `{"type":"paths"}` and `<origin>/mcp`, each what envs.ts says.
