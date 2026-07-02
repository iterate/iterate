# test-quarantine

Suites parked here are EXCLUDED from typecheck and test runs (see
`apps/os/tsconfig.json` "exclude" and the `test-quarantine/**` exclude in
`apps/os/vitest.config.ts`). Each file carries a header with its origin path,
what it covered, and why it was quarantined. They are kept as reference for
behavior that should eventually be re-proven against the next itx engine.

## itx-e2e (legacy itx surface, removed in the itx-v4 cutover)

Superseded by the `apps/os/e2e/engine/*` engine suites unless noted. Path back:
port the scenario onto the next engine surface (`apps/os/src/next/types.ts`)
and land it in `apps/os/e2e/engine/`.

- `itx-e2e/itx.e2e.test.ts` — legacy catalogue matrix runner + live-cap scenario suite (provide/promote/shadow/fetch-intercept/errors) — path back: `apps/os/src/itx/e2e/itx.e2e.test.ts` (rewritten) + engine suites.
- `itx-e2e/itx-egress.e2e.test.ts` — explicit + implicit egress doors with getSecret(...) substitution — path back: engine egress tests in `apps/os/e2e/engine/itx.e2e.test.ts`.
- `itx-e2e/itx-extend.e2e.test.ts` — itx.extend() child contexts, shadowing, itx.super middleware — extend() has no next-engine equivalent yet.
- `itx-e2e/itx-http.e2e.test.ts` — facet caps + `{cap}--{project}` hostname routing — path back: stateful dynamic workers + project-ingress engine e2e.
- `itx-e2e/itx-mcp-auth.e2e.test.ts` — authenticated remote MCP via secret-substituted egress — path back: engine MCP built-in tests.
- `itx-e2e/itx-openapi.e2e.test.ts` — OpenApiClient capability (operationId dispatch, refusals) — path back: engine OpenAPI built-in tests.
- `itx-e2e/itx-subscribe.e2e.test.ts` — Cap'n Web stream subscriptions (replay/tail/teardown) — path back: engine subscribe-callback tests + streams engine suites.
- `itx-e2e/itx-scripts.ts` — shared worker-cap sources for the legacy scenario suites — path back: inline sources inside engine tests.
