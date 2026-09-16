---
status: in-progress
size: medium
base: codex/preview-do-storage-cleanup
---

# Choose preview work from ordered change types

Specification committed first. Refresh the earlier planner onto current preview
orchestration, inherit completed ancestor results for docs, and retain safe
fallback deployment. No PR: review through a compare link against
`codex/preview-do-storage-cleanup` (PR #2693).

## Request and decisions

- Classify paths changed in the head commit with a checked-in ordered glob map;
  last match wins. Docs need no new tests, Tests need tests, all other types need
  a complete deployment and tests. Merge commits compare with their first parent;
  deletions and both sides of renames count.
- Docs/empty commits inherit a conclusive ancestor preview result, including
  failure. Walk first-parent history through the main merge-base, inclusive.
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

- [ ] Restore the readable classification/history algorithm and add result inheritance.
- [ ] Validate conclusive GitHub outcomes and safe deployment reuse.
- [ ] Wire plan outputs and inherited failures into current PR/main workflows.
- [ ] Test precedence, meaningful ancestry barriers, outcomes, merge boundaries and stale previews.
- [ ] Review algorithm semantics, runtime safety and readability in separate passes.
- [ ] Run relevant local checks and read-only live lookup checks; document acceptance limits.
- [ ] Push a no-PR stacked branch and provide its compare link.

## Implementation log

- Base7ebcd78809, PR #2693. Storage-only cleanup did not establish reusable
  previews; normal retirement remains the default. The planner must be useful
  for inherited docs results while conservatively deploying when reuse fails.
