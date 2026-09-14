---
status: complete
size: small
---

# Prepare the environment before timing OS test suites

Status: implementation and local validation complete. Both suites wait
outside their test clocks; Playwright auth is prepared before workers start.
A smoke-teardown telemetry defect is recorded below; this is not a claim of
an error-free platform. Branch: `codex/ci-suite-readiness`.

Before this change, Playwright waited for deployment propagation inside project/sign-in
fixtures, so individual test durations include shared deployment setup.
Vitest waited outside the runner. Auth configuration was also loaded lazily
in Playwright workers. These shared prerequisites now run outside individual tests.

- [x] Give Playwright and Vitest one external readiness boundary: the existing
      deployment-age delay and successful agent smoke. Start both suites
      concurrently after readiness; keep Chromium installation concurrent
      with setup and keep readiness visible in CI output.
      *Implemented in `scripts/preview/preview.ts`; readiness failure blocks both suites.*
- [x] Load and validate Playwright auth configuration before workers start,
      for both CI and local `pnpm spec`. Pass prepared settings through the
      environment; keep test identities, tokens and projects isolated.
      *`specs/setup.ts` prepares auth before workers; fixture readers are synchronous.*
- [x] Remove Playwright's deployment sleeps and associated timeout extensions.
      *Removed from project and email-signup helpers, including unused TestInfo plumbing.*
- [x] Cover readiness ordering, setup failure, concurrent suite execution and
      auth setup with behavior tests; update affected documentation.
      *Actual preview shell is exercised with controlled commands; auth setup and fixture reads use a controlled Doppler executable. Browser integration is covered by the preview proof below.*
- [x] Run focused tests, type/lint/format checks and available runtime proof;
      record any validation limitations explicitly.
      *193 preview tests, scripts/spec typechecks, lint and formatting pass; fresh preview proof below.*
- [x] Commit and push the completed branch; return the compare link only,
      without creating a PR.
      *Branch pushed to origin; compare against main.*

## Scope decisions

- Keep the 90-second deployment-age rule. Replacing it with a better readiness
  signal is separate work.
- Preserve Vitest's existing agent-smoke prerequisite and apply it to
  Playwright as well. Readiness failures must prevent both suites from starting.
- No test-selection changes, concurrency increases, timeout increases, or
  changes to resource cleanup.
- The normal preview workflow requires a PR. Do not create one merely for
  validation, or borrow another PR's preview lease.

## Implementation log

- 2026-09-14: created worktree from `origin/main` at `3a5ea998e1`.
- 2026-09-14: after reviewing the compare link, the user authorized opening a PR.
  Full-workspace validation exposed five-second timeouts starting nested
  Playwright runners in the auth tests. Those tests now exercise real suite
  setup and fixture config reads with a controlled Doppler executable, without
  starting another test framework. The fresh preview proves worker integration.
  Product code and timeout budgets were unchanged by this test simplification.

## Validation — 2026-09-14

- Before opening the PR: full `pnpm typecheck`, `pnpm lint`, `pnpm knip`,
  `pnpm format:check` and `pnpm test` passed. The final full test run includes
  all 311 scripts tests; the three auth setup tests took 867ms together.
  Scripts typecheck and changed-file lint/format were rechecked after simplifying
  the harness. No timeout increases or added retries.
- `pnpm --dir scripts exec vitest run preview`: **193 passed**, eight files.
  The actual preview shell is checked for concurrent starts, early-start
  rejection, and smoke/rollout failure. Auth tests check prepared settings,
  one Doppler lookup across repeated fixture reads, no lookup when env is
  supplied, and setup failure on invalid settings.
- `pnpm --dir scripts typecheck` and `pnpm exec tsc --noEmit -p specs/tsconfig.json`:
  passed. Changed TypeScript files: zero lint warnings/errors. Formatting and
  `git diff --check`: passed.
- Fresh manual lease of `preview-2`, holder `codex-ci-suite-readiness`.
  Erased OS data before deployment, then deployed OS, Auth, Docs and Petshop.
  SDK packages were pinned to base commit `3a5ea998e1` because this branch
  changes no SDK/product code and has no PR package publication.
- Executed the production OS preview command with private log paths and
  focused test filters: `e2e/vitest/live-state.e2e.test.ts` (two-worker cap),
  `specs/dashboard.spec.ts` and `specs/signup.spec.ts` (four workers).
  These caps apply only to the local proof; committed CI concurrency is unchanged.
- **7 Vitest tests + 5 Playwright tests + agent smoke passed, zero retries.**
  TUI remains the existing explicit quarantine skip. This was a focused
  deployed check, not the complete preview catalogue or hosted CI workflow.

Observed ordering (UTC):

| Event | Time / duration |
| --- | --- |
| OS deploy finished | 20:58:01.024 |
| Deployment-age deadline | 20:59:31.024 |
| Agent smoke completed | 20:59:56.479 |
| Shared environment readiness | 109 seconds total; rollout timer 84 seconds remaining |
| Vitest started | 20:59:57.292 |
| Playwright started | 20:59:57.585 |
| Playwright auth setup | 1 millisecond, outside individual tests |
| Vitest finished | 21:00:21.109; 7 test durations 9.1–16.7 seconds |
| Playwright finished | 21:00:33.673; 5 test durations 13.3–18.1 seconds |

The readiness phase remains the existing age rule plus agent smoke. Both
runners now exclude that shared delay from individual test durations.

<details>
<summary>Observability limitation: smoke WebSocket teardown</summary>

Queried Cloudflare account `376ef7ed81b0573f93524de763666c15`, services
`os-preview-2` and `auth-preview-2`, from **20:58:01.024 to 21:00:51.293 UTC**.
Auth had no error-level events. OS had four error-level events, all representations
of one `Network connection lost.` outcome for the smoke WebSocket. This error
signal needs classification/fixing; passing tests alone do not make it acceptable.
The error happened before either main test runner started. Neither the smoke
client nor the deployed application code is changed by this branch.

[Smoke trace](https://dash.cloudflare.com/376ef7ed81b0573f93524de763666c15/observability/traces/1adec4029ee54a1443fc885f83ee1f80):
OS version `552e7a88-0281-4825-84be-0e81cd624965`. Its root span
`a3c6788ded5cc642` runs from 20:59:31.219 to 20:59:56.497 (25.278 seconds).
The nine semantic `itx` spans all have this parent, fit inside its time range,
and report `itx.outcome: ok`. They cover authentication, project creation,
agent creation, message delivery, waiting for the response and reading events.
The last successful `Stream.getEvents` ended at 20:59:56.465; the smoke finished
14ms later, and the root connection error followed 18ms after smoke completion.
This is consistent with client teardown; it does not establish that the native
error is correctly classified. Fixing that product/transport behavior is outside
this CI scheduling change.

Queries used the Workers Observability API directly (the Cloudflare MCP
connector was unavailable). The [API reference](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/)
was checked before querying. For each service, queried `datasets: []`, filtered
`$metadata.service eq <service>`, then:

- `view: calculations`, `calculations: [{operator: count}]`,
  `groupBys: [{type: string, value: $metadata.level}]`;
- `view: events`, `limit: 100`, with an additional string filter
  `$metadata.level eq error`.

The correlated trace query used `datasets: []`, `view: events`, `limit: 2000`,
`traceId eq 1adec4029ee54a1443fc885f83ee1f80`, timeframe
20:59:30–21:00:00 UTC; returned 1,773 `otel` records. The service-wide error
query also supplied the corresponding native invocation/exception records.
Raw logs, test telemetry, queries and responses are kept locally under
`validation.ignoreme/` and `/tmp/iterate-ci-readiness-*`; no credentials or raw
telemetry are committed.

Semantic spans (all in the linked trace, parent `a3c6788ded5cc642`, outcome `ok`):

| Operation | Span ID | Start UTC | End UTC | Duration |
| --- | --- | --- | --- | --- |
| itx ProjectCollection.get | `8cb8242d6dbf7578` | 20:59:32.145 | 20:59:32.462 | 317ms |
| itx UnauthenticatedOs.authenticate | `9beab588176c7679` | 20:59:32.145 | 20:59:32.145 | 0ms |
| itx Project.create | `9c850942fd391c77` | 20:59:32.462 | 20:59:45.909 | 13447ms |
| itx Project.__describe | `292eb54109923184` | 20:59:45.929 | 20:59:45.973 | 44ms |
| itx Agent.create | `49cd24fbd7c3ca77` | 20:59:46.029 | 20:59:49.609 | 3580ms |
| itx AgentCollection.get | `3d2b1d11694f76c2` | 20:59:46.029 | 20:59:46.029 | 0ms |
| itx Agent.message | `ac69bd3da1238d92` | 20:59:49.625 | 20:59:50.900 | 1275ms |
| itx Stream.waitForEvent | `d5c98f0ff8d3ac91` | 20:59:50.919 | 20:59:56.397 | 5478ms |
| itx Stream.getEvents | `8446dac8f0054759` | 20:59:56.414 | 20:59:56.465 | 51ms |

</details>


## Cleanup

Post-proof OS erase succeeded: DO classes retired, D1/KV cleared, Worker parked.
Artifacts GC deleted 649 repositories before its existing deadline; older
repositories remain for subsequent GC passes, and R2 uses the existing TTL.
The manual `preview-2` lease was released successfully before PR creation was authorized.
