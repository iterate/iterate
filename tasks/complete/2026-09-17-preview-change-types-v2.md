---
status: complete
size: medium
base: codex/preview-park-restore
---

# Choose preview work from ordered change types

Implemented and locally checked. The head-path decision loop, inherited red/green,
safe reuse checks and workflow gating are complete. Live lookup checks passed;
a gated CI run and successful tests-only reuse remain rollout acceptance work.
Restacked without the failed storage-wipe experiment. No PR: review
`codex/preview-change-types-v3` against `codex/preview-park-restore` (PR #2695).
The restore-identity guard and final Depot result check still need integration
before rollout; see `docs/preview-change-selection.md`.

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
