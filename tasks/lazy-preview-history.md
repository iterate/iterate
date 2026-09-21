---
status: in-progress
size: medium
---

# Fetch preview planning history only when needed

Status: specified; implementation has not started. The branch starts from main, independently of the depth-ten / lease-cycling experiment. Lazy metadata fetching, regression tests, and CI evidence remain.

The Plan job should use the ordinary actions/checkout defaults to get the checked-in scripts. Planning must fetch additional Git metadata only as needed, rather than making checkout fetch the entire repository history before any decision is possible.

## Intended behavior

- [ ] Remove Plan's explicit fetch-depth, retaining its exact-head ref and baked-worktree handling.
- [ ] Classify head against its real first parent, fetching missing commit/tree objects without historic file contents. A product change must decide deploy without looking for main's merge-base or older preview evidence.
- [ ] Make further ancestry inspection lazy, fetching a small batch when the known history is exhausted. Prefer Git; use GitHub only if it makes the implementation materially simpler or faster.
- [ ] Preserve docs inheritance (including failures), test-only deployment reuse, both paths of renames, first-parent merge semantics, and the merge-base stopping boundary.
- [ ] Bound metadata retrieval and report fetches and any conservative deployment decision. Authentication, transport, and unexpected Git failures must remain visible failures.
- [ ] Add integration coverage with real shallow repositories and a controllable Git remote, including short-circuiting, history expansion, merges, roots, and fetch failures.
- [ ] Run required repository checks; exercise the real preview workflow and document planning/checkout evidence.
- [ ] Address submitted review feedback, update the PR body, and move this task to complete.

## Decisions and assumptions

- Keep preview result/deployment validation and workflow coordination unchanged.
- `git diff --name-only` reads local trees; an explicit filtered fetch must supply missing metadata first.
- Choose the small fetch batch and traversal budget from implementation evidence. Incomplete ancestry cannot justify reusing an older result or deployment.
- No history rewrites, lease-cycling changes, or changes to root-worktree files.

## Implementation log

- 2026-09-21: Read the current planner, merge-boundary tests, CI workflow, repository rules, and PR workflow. Created this independent worktree from `origin/main` (`97ffd6fd65`).
