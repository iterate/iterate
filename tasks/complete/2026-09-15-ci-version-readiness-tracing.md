# Version-aware preview readiness and project creation traces

Status: implementation complete and exercised on a leased preview. Full deployed
suites passed with three test retries; preview data was erased and the lease
released. The evidence below records remaining release-validation questions.
This follows the shared Playwright/Vitest setup change in #2653.

## Request

Replace OS's fixed deployment-age wait with evidence that the code handling
work is the expected deployment. Make the time spent creating a project
visible in traces and CI. Work in a new worktree, commit and push, but **do not
open a pull request**; return a GitHub compare link.

## Scope and acceptance

- [x] Check the actual Durable Object's version before running requested work.
      *`deployment-readiness.ts` wraps every bound OS class and namespace.*
      A representative object cannot establish readiness for the whole fleet.
      Include objects first reached later, during project creation or tests.
- [x] Bound version waits, report object/expected/actual versions and elapsed
      time, and propagate unrelated failures. Never replay a mutation merely
      because it threw or its connection reset.
      *Only an inert receiving-version mismatch permits another attempt.*
- [x] Remove OS's 90-second deployment-age wait once the replacement is proven.
      Let agent smoke, Vitest and Playwright run independently after their own
      prerequisites; all remain required. Keep Chromium installation concurrent.
      *Actual preview shell tests prove both suites start before smoke finishes.*
- [x] Turn existing project-creation timing steps into native Cloudflare spans,
      with project identity usable across background stream processing.
      *`timedStep` emits native spans; project ID joins background traces.*
- [x] Separate smoke-client connection, creation, description and agent timings;
      emit enough identity and timing information to find the deployed traces.
      *Smoke writes lookup records; CI prints trace links and preserves records.*
- [x] Test version transitions and failures through real runtime behavior, and
      test CI ordering with controlled commands. Keep existing timeout budgets.
      *Unit tests cover version transitions; the preview covers native RPC,
      getters, cancellation and WebSocket fetch. No real mismatch was observed.*
- [x] Deploy to a separately leased preview, exercise creation and both suites,
      inspect version/trace/state evidence, and clean up and release the lease.
      *Preview 2: full suites green; erase succeeded and release returned true.*
- [x] Record validation and limits, finish the task file, commit and push the
      branch, and send the compare link without opening a PR.
      *Evidence and limits below; deliver `main...codex/ci-version-readiness-tracing`.*

## Design constraints

Edge `/api/health` already checks the deployed Worker version. It does not prove
that every Durable Object has updated. The new check must run before the
operation on the receiving object, not merely before making a later call.
Readiness describes a particular operation and version; it is not a promise
that an object can never reset afterwards.

Use existing project IDs and creation-event offsets to correlate background
steps. Preserve the difference between elapsed critical-path time and the sum
of concurrent spans. Do not claim missing trace context is propagated unless
the deployed trace proves it.

## Implementation log

- Started from `origin/main` at `4a364c3b6b8204d439208fda3203ae132e5e5672`.
  Branch: `codex/ci-version-readiness-tracing`.
- The version guard applies to OS `preview_*` bindings only. Production keeps
  mixed-version behavior. Every receiving class checks its version before an
  RPC method/getter or native fetch executes; later objects are checked when
  reached. Constructors, alarms and WebSocket callbacks keep native lifecycle
  behavior, and in-flight work can still be reset by a later deployment.
- Native getters and fetch needed separate handling. Initial deployed probes
  exposed getter and RequestInfo/WebSocket regressions; both were corrected
  before the final successful runs. The guard is for current internal OS
  binding usage, not a general native RPC replacement: unawaited result
  pipelining is not supported by its ordinary Promise return.
- `timedStep` retains structured logs and creates native `create-timing.*`
  spans. Smoke preallocates a project ID and records authentication, creation,
  description, agent creation and reply separately. The diagnostic lookup runs
  after all suites; its failure is visible but cannot fail a product test.

## Validation — 2026-09-15

- `pnpm install --frozen-lockfile`, `pnpm --filter iterate build`, full
  `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and
  `git diff --check` passed. The final focused checks passed 12 readiness/timing
  tests and 159 preview scheduling/policy tests. No timeout budgets increased.
- Leased `preview-2` exclusively. Auth, OS, Docs and Petshop were deployed.
  Unchanged SDK tarballs used the base SHA because this branch has no package
  publication; deployed OS code is identified by its actual Cloudflare UUID.
- Final OS version: `85983f02-16e4-48a7-9ad2-58bd0b76fe2a`.
  Auth version: `0c098626-068b-4811-b323-2df6757bfa99`.
  Actual OS preview shell ran with CI concurrency and version override headers
  from 11:03:14 UTC. Overall: **169,997ms**, exit 0. Smoke: 22s;
  Vitest: 137s; Playwright: 166s. Chromium was already installed locally.
  This is test-phase time, not an end-to-end Depot deployment measurement.
- Vitest: 59 files passed, 3 skipped; 216 tests passed, 10 expected failures,
  4 skipped. One retry: `repeating a receive command reuses its original now
  cursor` timed out waiting 15s for delivery after resuming a paused stream.
- Playwright: 85 passed, 2 passed after retry, 4 skipped. Retries were
  `repl-examples / run-script` (Run button not visible) and
  `mobile/notifications` (Organization name field not ready). Both failed at
  middlewright's 1ms UI readiness check. These are observations, not proof
  that the retries predate this change.
- A preceding focused deployed run passed smoke, all 7 live-state tests and
  all 4 dashboard specs in 35.8s with zero retries. The complete run also
  exercised native RPC capabilities, binary streams, cancellation, worker
  WebSocket upgrades and deliberate DO resets.

### Creation trace proof

Smoke created `prj_2853332bcb5e4fc19a65e0cbe3654c2c` in **11,312ms**, excluding
1,395ms connection/authentication and 111ms description. Agent creation took
3,749ms; reply wait took 3,848ms. The API returned the project and the agent
produced a reply without retry.

The query found **21 creation spans**, all `iterate.outcome=ok`, across five
traces. Foreground steps are children of `itx Project.create`; background
steps are children of their native invocation and carry the same project ID.
Creation processing also carries `createRequestedAtOffset=5`.

| Step | Duration |
| --- | ---: |
| Root append | 2,328ms |
| Wait for project-created | 8,553ms |
| Wait for project birth | 3,284ms |
| Seed API key | 3,124ms |
| Config repo append | 2,261ms |
| Artifact get/create | 1,983ms |
| Artifact seed | 1,325ms |
| Worker probe | 155ms |

Several steps overlap; these durations must not be summed.

- [Foreground creation](https://dash.cloudflare.com/376ef7ed81b0573f93524de763666c15/observability/traces/c6298b72b581af5b7ae15e4b5b572932)
- [Project processor](https://dash.cloudflare.com/376ef7ed81b0573f93524de763666c15/observability/traces/e90f0ac09bb10247f319dfe26016b1a5)
- [Artifact creation](https://dash.cloudflare.com/376ef7ed81b0573f93524de763666c15/observability/traces/442e90deec598ed2a277d7d772e51bd9)
- [Artifact seeding](https://dash.cloudflare.com/376ef7ed81b0573f93524de763666c15/observability/traces/0c28ccd1c5244b9d928b350eb576f29b)

### Limits and follow-up before release

- No actual version mismatch was observed in the final deployed run. The
  old/new refusal, timeout, disposal and no-mutation-replay cases are tested
  with controlled receivers; live validation proves the matching-version
  native transport. This is not the 25-run stability proof described in
  `docs/ci-preview-performance.md`.
- The broad test window emitted errors, including intentional kill/pause and
  negative API cases. A repo recovery error and a hung `ItxEntrypoint.get`
  invocation still need classification before release; a green suite is not
  evidence that all these errors are harmless. The repo was `/repos/e2e-side`
  in `workspace.itx.e2e.test.ts`, which did complete its create/write/commit
  assertions. The hung invocation reaches the controlled endpoint in
  `itx-egress.e2e.test.ts`'s response-URL secret-confinement test, which also
  passed; neither observation explains away the error:
  [hung invocation](https://dash.cloudflare.com/376ef7ed81b0573f93524de763666c15/observability/traces/b8ce09a2cd232d3797165e8f2eff0703),
  [repo recovery](https://dash.cloudflare.com/376ef7ed81b0573f93524de763666c15/observability/traces/bb522daf10fed041bf3abf7c3414821d).
- The four background creation traces had no error events. The foreground
  trace's WebSocket reports `Network connection lost` 30ms after the smoke
  process completed successfully. Its close-time error classification remains
  a product telemetry issue; creation spans themselves all completed normally.
- Local evidence is preserved in `validation.ignoreme/` and
  `/tmp/iterate-version-*.log` in this worktree. No raw traces or test data are
  committed.
- Cleanup retired the OS DO classes, parked the Worker, cleared D1 and 1,564
  directory KV keys, and deleted 647 Artifacts repos within the existing GC
  budget. More inert artifact repositories remain for subsequent GC. R2 files
  and sandbox backups retain the existing three-hour expiry. Preview lease
  `a858acc4-9780-4153-bada-e30f138caaf4` was released successfully.
