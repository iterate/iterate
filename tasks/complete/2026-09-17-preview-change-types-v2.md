---
status: complete
size: medium
base: main
---

# Choose preview work from ordered change types

Implementation and live acceptance are complete in draft PR #2712. Prepare
starts alongside planning and reads milestone values as step outputs; both the
full run and setup-only inheritance passed. Tests-only reuse was verified earlier.
No runs were interrupted. Based on main after #2695.

## Request and decisions

- Classify paths changed in the head commit with a checked-in ordered glob map;
  last match wins. Docs need no new tests, Tests need tests, all other types need
  a complete deployment and tests. Merge commits compare with their first parent;
  deletions and both sides of renames count.
- Docs/empty commits inherit a conclusive ancestor preview result, including
  failure. Walk first-parent history through the main merge-base, inclusive
  when it is on that chain; otherwise stop before leaving its descendants.
  Do not walk past an untested product/test change to an older green result:
  execute the work still required by that change. Missing/ambiguous history
  falls back to deployment. A cancelled or still-running run is inconclusive.
- Restrict Docs to explicit docs/tasks/explainers trees and package/app/root
  README files. Markdown shipped as application/config content remains product
  work. The initial rule order otherwise follows the user's proposed map.
- Tests-only work searches each candidate for a live deployment before deciding
  whether its changed files require deployment. Stop at an undeployed product
  commit; stop after the merge-base; deploy head if none is usable. Tests always
  execute from head, not from the backend's revision.
- Main CI continues full deployment/tests. Read completed PR/main preview check
  outcomes from GitHub, preserving newest-run boundaries and never combining
  old green jobs with a newer incomplete run. Inherited red must produce red CI.
- Preview reuse remains restricted to a verified live fleet owned by this PR,
  with sufficient lease lifetime and matching recorded deployment versions.
  Recheck before testing. Do not borrow another PR/main lease, weaken cleanup,
  or treat a parked Worker as live. Main has completed results but no safe
  borrowable deployment registry; fallback is expected there.
- Keep the visible algorithm short. Git, GitHub check parsing, live deployment
  validation and workflow outputs belong outside its reading path. Test public
  decisions with real temporary Git histories and controlled evidence sources;
  do not reshape product code around mocks.
- Preserve overlapped preparation, six identical shards, all-settled cleanup,
  exact head/run identity and the caller's lifecycle lock. One small planning
  job may install dependencies before expensive jobs are admitted.

## Work

- [x] Restore the readable classification/history algorithm and add result inheritance. *`scripts/preview/change-plan.ts` starts with the decision loop; `commit-history.ts` handles Git.*
- [x] Validate conclusive GitHub outcomes and safe deployment reuse. *Newest complete workflow only; own live lease, exact fleet versions and readiness; prepare rechecks.*
- [x] Wire plan outputs and inherited failures into current PR/main workflows. *Small `plan` job gates expensive work; inherited red throws; main/manual remain full.*
- [x] Test precedence, meaningful ancestry barriers, outcomes, merge boundaries and stale previews. *Real Git histories, structured GitHub checks and Cloudflare deployment responses.*
- [x] Review algorithm semantics, runtime safety and readability in separate passes. *Three self-review passes plus independent review; version and transport findings fixed.*
- [x] Run relevant local checks and read-only live lookup checks; document acceptance limits. *386 scripts tests, typecheck and scoped lint pass; details below and in `docs/preview-change-selection.md`.*
- [x] Push a no-PR stacked branch and provide its compare link. *Restacked as `codex/preview-change-types-v3`, based on `codex/preview-park-restore`; no PR created.*

## Implementation log

- Base `7ebcd78809`, PR #2693. Storage-only cleanup did not establish reusable
  previews; normal retirement remains the default. The planner must be useful
  for inherited docs results while conservatively deploying when reuse fails.
- TDD exposed the missing inherited-red behavior, overbroad markdown policy,
  absent check-result adapter, workflow gating and second-parent merge boundary.
  Deployment parsing rejects stale historical versions and mixed deployments.
- Semantics review: retain lookup-before-product-barrier order; docs cannot
  hide an untested product/test commit; renames count both paths; a main merge
  cannot substitute main's tree for the feature branch.
- Runtime review: newest workflow and partial rerun handling, lifecycle lock,
  exact head/run plan identity, a full hour of remaining lease time, no foreign
  lease adoption, revalidation before use, inventory errors remain errors.
  Independent review found missing version proof on apps without headers and
  transport failures that bypassed fallback. Both are fixed. All six app
  accounts were checked against the preview slot's account.
- Readability review: ordered map is policy, `planPreview` is the algorithm,
  adapters own Git/GitHub/Cloudflare mechanics. No exported test-only product
  helpers or mocks were added. Existing workflow tests track the new gating
  and `checks: read` permission.
- Read-only live checks: `7ebcd78809` reports successful PR preview;
  `8bac0d467` reports failed PR preview; `a9f5eddef6` reports successful main
  preview. Actual `trpc-cli ... ci-plan --pull-request-number 2693` inherited
  success from the parent checkout. The Cloudflare deployment parser accepted
  the current preview-15 version and rejected a stale ID without calling DOs.
- Full scripts suite: 32 files / 386 tests passed. Scripts typecheck and scoped
  oxlint passed. No live gated workflow or full reuse claim: this branch has
  no PR and did not acquire an environment. Require the planning check before
  rollout so inherited red cannot be hidden by skipped downstream checks.
- Restacked only the two ancestry commits onto PR #2695 at `ca226f195b`, keeping
  `checks: write`, `set-pending-check-green`, and park/restore cleanup intact.
  PR #2695 and the old ancestry branches are unchanged. The old storage-wipe
  changes are not included. Documented the two remaining lifecycle integration
  blockers rather than expanding this requested restack into implementation.
- Restack validation: 385 scripts tests across 32 files, scripts typecheck, scoped
  lint, formatting and diff checks passed on the new base. No live deployment
  or PR was created for this transfer.

- Review follow-up: moved the ordered globs into `change-types.ts` and derive
  `ChangeType` from its keys. Planner change maps use that union; unmatched types
  remain absent. Removed YAML parsing and filesystem reads without changing policy.
  All 14 planner tests, scripts typecheck, scoped lint and formatting passed.

- Merged main at `b3b4dfa406` after PR #2695 landed. Kept its status helper and
  tracing changes, and resolved the workflow-test overlap around the plan gate.
- Added `preview-settled` as the final finish step. Conclusive result collection
  writes a success/failure output even when tests fail; actual restoration writes
  a separate completion output. Both are needed to publish. No pending status or
  branch-protection change. Incomplete collection and failed restoration publish
  no certificate. The reader requires the signal, producer identity and current
  checks; live deployment reuse still verifies the lease and Worker versions.

- Settlement validation: 405 scripts tests across 32 files, scripts typecheck,
  scoped lint and CLI help passed. A read-only lookup of the earlier successful
  #2695 run returned no inheritable result because it has no marker. No live
  gated workflow or publication was run on this compare-only branch.

- PR acceptance follow-up: merged main at `35c662a72`, keeping planning in place
  of cumulative workflow path filters. Restoration now validates the current CI
  preparation artifact and the exact deployed app identities. Reused fleets are
  restored fully from the tested head after cleanup so later reuse has one SHA.
- [x] Observe a complete initial PR run, including restoration and settlement. *`e1a5838dc`, workflow `hwk5nxq2x4`: deployed tests passed; restored and published `tests=success`.*
- [x] Push only test changes; prove preparation reuses the existing deployment. *`0dcb04c42`, workflow `bzhzzvxxwn`: all six prepared Worker versions match the parent's restoration artifact; new-head tests pass; cleanup restores all six apps.*
- [x] After settlement, push only docs changes; prove expensive preview jobs skip. *`a41561887`, workflow `kf201tf7t8`: planning inherited success in 32 seconds; all nine downstream jobs skipped without runner attempts.*
- [x] Handle review feedback and record links, timings and deployment evidence. *No submitted review threads outstanding; evidence in `docs/preview-change-selection.md` and PR #2712. Global PR monitor registered.*

- Live runs exposed native Node's rejection of constructor parameter properties
  in `CloudflareApiError`; ordinary fields fixed it. The initial full-CLI
  regression test exceeded CI's five-second budget under load; a focused native
  module subprocess retains the regression proof in about 120ms. All 441 scripts
  tests and the subsequent full unit CI pass, without raising timeout budgets.
- A temporary health spec added to the first tests-only acceptance push timed
  out on Playwright's one-second request budget. Removed it: the preparation
  artifact provides exact version evidence without adding a remote probe. Its
  failed run still restored all six apps and published `tests=failure`; the next
  tests-only push successfully reused that restored deployment. The final
  Playwright report has 88 passed, four existing skips, no failures or retries.
- Full local workspace tests, typecheck, lint, knip and formatting passed. No
  CI runs were cancelled or interrupted; every push waited for previous CI to
  finish. No branch protection settings were changed.

- [x] Start prepare setup concurrently with planning, then gate later steps on its signal. *`preview-run.yml` removes prepare's job dependency and uses `steps.plan.outputs`; app/shard gates remain.*
- [x] Carry compact values through attempt-scoped milestones into step outputs. *`status.ts set --values` validates and publishes `key=value; …`; `wait-for` converts separators directly into output lines. Inherited failures publish their decision before the job stops.*
- [x] Verify the overlapped full run in Depot. *`8f4df71e3` / `czk85wphzh`: all workflows passed, including unchanged unit tests, deployed suites, restoration and settlement.*
- [x] Verify setup-only inheritance through the new milestone outputs. *`2e5011617` / `wj7jlq6mb5`: inherited success, prepare received `tests=false` and skipped everything after its wait; eight other jobs skipped without attempts.*
- Failure-path review: a plan publication can succeed before its job fails. The
  finalizer therefore admits `tests=true` even with a failed plan job, preserving
  cleanup for preparation already underway. Test jobs still require plan success.
- First overlap run `a511549af` / `hg2flkdj90`: preparation installed dependencies
  before the plan signal, received all four values, and completed deployment,
  all deployed suites, restoration and `preview-settled`. Separate unit CI hit
  the existing dependency-install test's five-second timeout; unchanged tests
  will run again with the finalizer follow-up. No run was interrupted.
- Format follow-up: use `options.values || { milestone }` for signal values,
  with the milestone first in `ci/<milestone>/<attemptId>` contexts.
  Unique attempt IDs suffice; workflow membership and retry guards remain.
  Validate names and reserve semicolons/newlines in values before publication;
  the waiter can append the description as output lines without JSON decoding.
- Main integration: preserve #2718's trace collection before cleanup and verdict
  outputs, #2720's early Metro startup, #2722's Vitest spans, and #2717's fast
  dependency tests. Keep ancestry gates and publish settlement after restoration.
  Select only the four plan values for the signal: the new shell tracer also
  appends `ci-trace-end`, which must not enter the 140-character description.
