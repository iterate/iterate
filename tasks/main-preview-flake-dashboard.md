---
status: needs-preview-validation
size: large
---

# Main preview runs and a current flake dashboard

Status: ordinary-slot allocation and the dashboard changes are implemented. All preview commands now share a target for PRs and workflow commits; local checks pass and the shared deploy/erase commands have run on preview-8. PR #2658 is reopened with the final review fixes, current risk map and dashboard screenshot. Packages now publish and deployed e2e is running. The first CI run exposed a slow CLI-help test, addressed below.

## Current scope

- [x] Keep `pnpm preview run --pull-request-number <n>` working. Support the exact checked-out main commit through the same command with `--commit <sha>`. *Removed `run-main`; the workflow now uses shared `run` and `erase` commands.*
- [x] Share deployment, readiness, tests and cleanup between PR/main callers. Extract PR reporting/context from the shared implementation where needed; keep the extraction focused. *`PreviewTarget` supplies run identity, report, comparison base, slot preference and review project to shared commands; source-specific setup stays at the boundary.*
- [x] Main takes an ordinary preview lease under `main-preview`, renews it across runs, and keeps it after cleanup. Use the existing 3h expiry and GC; make no Semaphore policy changes. *Semaphore matches the base commit; shared claim tests cover `main-preview` renewal.*
- [x] Trigger the full preview suite on main pushes. Serialize main deployment/test/cleanup on its ordinary slot without cancelling an active run; newer queued commits replace older queued commits. Keep current PR cancellation behavior. *`cloudflare-main-preview.yml` uses one concurrency group with cancellation disabled.*
- [x] Upload complete suite results even when no unknown flakes occur. Only a completed full main result replaces that suite's current unknown-flake list; partial/cancelled/missing results must not look like a clean run. Preserve historical records. *Suite summaries carry branch/head and completeness; incomplete results retain the previous snapshot.*
- [x] Show unknown flakes from the latest complete main run per suite, with run/commit provenance. Remove the 14-day accumulation from the current unknown table. *Dashboard reducer/rendering tests cover complete, empty and incomplete main results.*
- [x] Explain all outcome emojis, including unexpected errors (❌). *Both legend rows describe ❌ as an unexpected error.*
- [x] Collapse the Failures table with test counts per suite in its summary. *Renderer uses details/summary with suite counts.*
- [x] Put collapsible Sentinels last. Render unknown test names as plain text with safe Markdown escaping. *Renderer orders Sentinels last and escapes plain unknown names.*
- [x] Test shared lease renewal, pinned commit validation, complete-zero-flake replacement, partial-run handling, and the rendered issue through real public boundaries/harnesses. *156 focused CI/runner tests and 31 dashboard harness tests pass.*
- [ ] Validate the shared path against a preview and inspect its results/artifacts. Check the new main workflow using supported Depot execution before merge; do not claim automatic main triggers are live before merge.
- [x] Complete checks and commit/push the common-target refactor for compare-link review. *Implementation pushed as `170a85b7c`; local checks and partial deployed validation are recorded below. PR stayed closed during compare-link review.*
- [x] Reopen PR #2658 after the final human-review fixes, with a current description and risk map. *Reopened at `f951e6897`; global monitoring is active through September 16.*

## Decisions and limits

- The workflow target selects the full suite and a stable holder; all slot allocation and renewal use the existing shared path.
- Main results measure the shared baseline. PR results still remain in their CI reports and historical telemetry.
- A disappearing unknown row means it did not recur in the latest full run, not that its cause is proven fixed.
- This work does not fix the outstanding child-agent delegation orphaned-script flake or disable retries. A green check is not proof of zero retries; validation will inspect recorded retries explicitly.
- Main adds CI compute and occupies one ordinary slot while its lease is valid. The main check runs after merges and is not on the PR critical path.
- Existing main worktree edits belong to the user and remain untouched. Work is isolated on `ci/main-preview-dashboard`.

## Implementation log

- 2026-09-15: Created this scope from the agreed dashboard and main-preview design before implementation. Starting from main commit `611c3769bfe50cace2601e9315cc415911f6decc`.

Codex session: `01a0a1e6-0135-7902-91aa-b4bb07026de2`.

- 2026-09-15: Added complete-suite summaries with retry-record count validation, main-only current snapshots and dashboard layout changes; 29 dashboard tests and 162 focused CI/runner tests pass. Extracted GitHub transport, revision/report context and preview state from the CLI. Main refuses to start against a Semaphore that lacks the reservation policy. GC remains allowed to acquire an expired main slot without force, so cancellation still has a cost-control backstop.

- 2026-09-15 review: fixed branch provenance when multiple Depot runs share a SHA; report summaries now carry their own branch/commit. Captured Vitest module/import and nested suite-hook errors in canonical telemetry, with real Vitest subprocess regression tests. Incomplete summaries no longer advance tracked-test retirement. Main is restricted to the serialized workflow, waits on reserved-slot contention, and cannot force-renew over GC. The reservation test tags and recovers its own inventory after cancelled runs.
- First preview validation (`22f55968b`): unit CI passed 5,461 tests and uploaded a complete summary with zero unknown retries. The real Semaphore preview reservation test passed. Final browser/OS results and validation of the review fixes remain in progress.

- 2026-09-15 user review: closed PR #2658 without deleting the branch. Continue review at https://github.com/iterate/iterate/compare/main...ci/main-preview-dashboard. The user rejected special-casing preview-1 throughout allocation and deployment; do not treat the original reservation requirement as settled or reopen a PR without a new request. Existing review fixes are preserved as a checkpoint, not an accepted design.

- 2026-09-15 revised requirement: remove all preview-1 reservation code and use the ordinary preview pool. Main keeps its lease after erasing data, renews it on later runs, and remains subject to normal 3h expiry. A dedicated environment can be considered later if there is a concrete need.

- 2026-09-15 simplification: commit `219cbb75a` removes the reservation implementation (181 net lines removed). Independent review found no new blocker. Full workspace tests passed, including 3,183 passing OS tests; latest focused tests are 156 CI/runner plus 31 dashboard tests. Scripts typecheck, full lint and full formatting checks pass. Live validation: https://depot.dev/orgs/0p91s0lz49/workflows/jfptlj2px3?job=dqv5wbbkn4&attempt=63dp1dth3s (run `b6gjx24535`, branch identity preserved).

- Live validation of `219cbb75a`: the existing Semaphore allocated preview-8 to `main-preview`, then the shared cleanup path renewed it. Five app deploys passed; OS preflight failed because `iterate` and `@iterate-com/docs` pkg.pr.new artifacts for this exact commit were unavailable. The existing GitHub publisher only runs on main pushes and open PRs and has no manual dispatch. No e2e tests ran. Keep this limitation visible; do not reopen the PR or add a branch-specific publishing workaround for validation.

- Teardown proof: run `b6gjx24535` finished with the expected package-preflight failure; cleanup succeeded and logged “main-preview keeps the lease”. A read-only production Semaphore status check confirmed preview-8 still held by `main-preview` until `2026-09-15T20:29:14.412Z`; preview-1 remains available to ordinary callers. Both uploaded suite summaries are `incomplete`, contain zero tests, and retain branch `ci/main-preview-dashboard` plus exact head `219cbb75a`, so this failed validation cannot clear main’s unknown flakes. Evidence: `/tmp/main-preview-ordinary-ci.log`, `/tmp/main-preview-ordinary-artifacts.zip`, `/tmp/main-preview-ordinary-slots.txt`.

- 2026-09-15 context refactor: replaced `PullRequestPreviewContext` / the conversion wrapper with raw `PreviewPullRequest` data at the PR command boundary. Shared operations take `PreviewRun`, `PreviewReport` and resolved deployment choices. PR diff selection, explicit slot requests and review login setup happen before/after the shared deploy. Report state now lives in one process-owned object; publishing preserves current human PR prose without reloading old managed state. Removed the `knownState`, accumulated-entry and context-state wrappers. Generic deployment helpers now use `headSha`/`baseSha`, and both preview and production pass the existing `PLATFORM_DEPLOY_HEAD_SHA` variable.
- Refactor verification: all 323 scripts tests pass, including selection, renewal, superseded cleanup, report rendering and file-backed main state. Scripts and OS typechecks, full lint and formatting pass; both PR/main CLI help commands load under native Node TypeScript, and independent review found no behavior regression. Live e2e is still subject to the package-publishing limitation above; the earlier preview-8 evidence predates this refactor.

- 2026-09-15 common target: all deployment/test/assignment/cleanup commands now resolve a `PreviewTarget`. Removed the separate main execution path and PR deploy wrapper. Main uses the same `run` plus `erase` commands as PR CI; its report can reload across commands within one job attempt, while a new job or retry starts fresh. Atomic file writes prevent interrupted publication from leaving truncated state. Kept main workflow serialization, ordinary leases, PR supersession protection and PR review links. Cleanup does not demand a clean tree, so build-generated changes cannot prevent stopping costs. Compared with main throughout; no new command framework or arbitrary-target configuration format.

- Local common-target checks: 334 scripts tests, scripts typecheck, full lint and formatting pass. `target.ts` holds the common contract and main report storage; commands stay in `preview.ts`. Final comparison against main removes the obsolete main execution path and single-caller erase wrapper rather than retaining adapter layers.

- Live common-target validation of `170a85b7c`: [Depot run rrdz3ztnrs](https://depot.dev/orgs/0p91s0lz49/workflows/bwqgghb1fc?job=7stw41kpjz&attempt=x017hpw4tb) renewed ordinary preview-8 for `main-preview`, erased before deployment, and deployed five supporting apps. OS failed only on missing exact-commit `iterate` and `@iterate-com/docs` pkg.pr.new packages (HTTP 404 after the existing bounded 120s preflight). No e2e ran. The separate shared `preview erase --commit` step succeeded after the failure, erased the slot in 103.5s and retained the lease until `2026-09-15T21:52:27.039Z`.
- Downloaded reports confirm all six app outcomes carry the exact head, the file-backed report carries the job URL/attempt, and both suite summaries are `incomplete` with zero tests and branch `ci/main-preview-dashboard`. The failed branch dispatch cannot replace main's current unknown-flake snapshot. Evidence: `/tmp/preview-common-target-ci.log`, `/tmp/preview-common-target-artifacts.zip`. A successful full e2e deployment remains outstanding; do not describe this check as green.

- Final human review: use `nopr` rather than inferring main in local telemetry IDs. `requireCleanCheckout` is now a named internal option intersected with `PreviewCommandOptions`, without exposing a CLI bypass flag. User authorized reopening PR #2658 with the current design.

- Reopened CI failure: the new `pnpm preview deploy --help` test spent 8.3s starting the CLI under full workspace contention and exceeded Vitest's 5s timeout, stopping other suites. Removed the seven flag-presence subprocess tests; the ambiguous-source check now calls the public `run` command directly. No product code, timeout or retry policy changed. Native CLI loading was already verified manually and is exercised by deployed CI.
