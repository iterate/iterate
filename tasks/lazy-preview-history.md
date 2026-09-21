---
status: in-progress
size: medium
---

# Fetch preview planning history only when needed

Status: implementation and focused shallow-repository tests pass. Normal checkout, filtered metadata fetching, early head decisions, and bounded merge-base discovery are in place. Broader checks, real CI evidence, and review remain.

The Plan job should use the ordinary actions/checkout defaults to get the checked-in scripts. Planning must fetch additional Git metadata only as needed, rather than making checkout fetch the entire repository history before any decision is possible.

## Intended behavior

- [x] Remove Plan's explicit fetch-depth, retaining its exact-head ref and baked-worktree handling. *`preview-run.yml` now uses checkout's default depth.*
- [x] Classify head against its real first parent, fetching missing commit/tree objects without historic file contents. A product change must decide deploy without looking for main's merge-base or older preview evidence. *`CommitHistory.changedFiles` reads raw parent headers and fetches with `blob:none`; the product test verifies the old blob remains missing.*
- [x] Make further ancestry inspection lazy, fetching a small batch when the known history is exhausted. Prefer Git; use GitHub only if it makes the implementation materially simpler or faster. *The history iterator yields head before main lookup; filtered fetches start with three generations.*
- [x] Preserve docs inheritance (including failures), test-only deployment reuse, both paths of renames, first-parent merge semantics, and the merge-base stopping boundary. *Existing selection tests pass; shallow variants cover the two merge cases.*
- [x] Bound metadata retrieval and report fetches and any conservative deployment decision. Authentication, transport, and unexpected Git failures must remain visible failures. *Six bounded ancestry expansions; 15-second fetch timeouts; budget exhaustion has an explicit deployment reason.*
- [x] Add integration coverage with real shallow repositories and a controllable Git remote, including short-circuiting, history expansion, merges, roots, and fetch failures. *`change-plan.test.ts` uses local Git upload-pack with filtering enabled.*
- [ ] Run required repository checks; exercise the real preview workflow and document planning/checkout evidence.
- [ ] Address submitted review feedback, update the PR body, and move this task to complete.

## Decisions and assumptions

- Keep preview result/deployment validation and workflow coordination unchanged.
- `git diff --name-only` reads local trees; an explicit filtered fetch must supply missing metadata first.
- Choose the small fetch batch and traversal budget from implementation evidence. Incomplete ancestry cannot justify reusing an older result or deployment.
- No history rewrites, lease-cycling changes, or changes to root-worktree files.

## Implementation log

- 2026-09-21: Read the current planner, merge-boundary tests, CI workflow, repository rules, and PR workflow. Created this independent worktree from `origin/main` (`97ffd6fd65`).
- First red/green case: a depth-one product checkout originally failed on missing `origin/main`; it now deploys using one filtered fetch, retaining a clean checkout and no main ref. The docs case originally failed at the same boundary; it now expands metadata until the merge-base is proven and inherits the failed base result.
- Deliberate limit: older candidates require proving the merge boundary first. We do not inherit from a nearby ancestor before that proof, because another shallow path may conceal a newer or second merge-base. The dominant product-head path needs none of that work.
