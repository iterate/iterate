---
status: ready-for-review
size: medium
---

# Fetch preview planning history only when needed

Status: lazy metadata fetching passed local checks and a full settled preview run. Docs-only acceptance exposed a pre-existing result-parser bug with Depot's nested job names; its regression, small fix, and replay of the real settled GitHub response now pass; repeat CI and docs inheritance remain. The draft awaits review; PR monitoring is registered.

The Plan job should use the ordinary actions/checkout defaults to get the checked-in scripts. Planning must fetch additional Git metadata only as needed, rather than making checkout fetch the entire repository history before any decision is possible.

## Intended behavior

- [x] Remove Plan's explicit fetch-depth, retaining its exact-head ref and baked-worktree handling. *`preview-run.yml` now uses checkout's default depth.*
- [x] Classify head against its real first parent, fetching missing commit/tree objects without historic file contents. A product change must decide deploy without looking for main's merge-base or older preview evidence. *`CommitHistory.changedFiles` reads raw parent headers and fetches with `blob:none`; the product test verifies the old blob remains missing.*
- [x] Make further ancestry inspection lazy, fetching a small batch when the known history is exhausted. Prefer Git; use GitHub only if it makes the implementation materially simpler or faster. *The history iterator yields head before main lookup; filtered fetches start with three generations.*
- [x] Preserve docs inheritance (including failures), test-only deployment reuse, both paths of renames, first-parent merge semantics, and the merge-base stopping boundary. *Existing selection tests pass; shallow variants cover the two merge cases.*
- [x] Bound metadata retrieval and report fetches and any conservative deployment decision. Authentication, transport, and unexpected Git failures must remain visible failures. *Six bounded ancestry expansions; 15-second fetch timeouts; budget exhaustion has an explicit deployment reason.*
- [x] Add integration coverage with real shallow repositories and a controllable Git remote, including short-circuiting, history expansion, merges, roots, and fetch failures. *`change-plan.test.ts` uses local Git upload-pack with filtering enabled.*
- [x] Run required repository checks; exercise the real preview workflow and document planning/checkout evidence. *Typecheck, lint, knip, format, 31 focused tests, and the full workspace-by-workspace suite passed. CI at `44107d152` passed every test, restored the preview, and published `preview-settled: tests=success`; measurements are in `docs/preview-change-selection.md`.*
- [x] Address submitted review feedback, update the PR body, and move this task to complete. *No submitted reviews or unresolved threads as of this commit; the draft PR body includes behavior, risk, checks, and timings. The global monitor watches through 2026-09-22 09:03 UTC.*

## Decisions and assumptions

- Keep preview result/deployment validation and workflow coordination unchanged.
- `git diff --name-only` reads local trees; an explicit filtered fetch must supply missing metadata first.
- Choose the small fetch batch and traversal budget from implementation evidence. Incomplete ancestry cannot justify reusing an older result or deployment.
- No history rewrites, lease-cycling changes, or changes to root-worktree files.

## Implementation log

- 2026-09-21: Read the current planner, merge-boundary tests, CI workflow, repository rules, and PR workflow. Created this independent worktree from `origin/main` (`97ffd6fd65`).
- First red/green case: a depth-one product checkout originally failed on missing `origin/main`; it now deploys using one filtered fetch, retaining a clean checkout and no main ref. The docs case originally failed at the same boundary; it now expands metadata until the merge-base is proven and inherits the failed base result.
- Deliberate limit: older candidates require proving the merge boundary first. We do not inherit from a nearby ancestor before that proof, because another shallow path may conceal a newer or second merge-base. The dominant product-head path needs none of that work.

- Live product acceptance: [workflow `tt77gkjqqt`](https://depot.dev/orgs/0p91s0lz49/workflows/tt77gkjqqt) passed deployment, app tests, all six browser shards and restoration. Settlement recorded `tests=success; deployment=restored; check=106277241289`. Plan took 31s versus 55s in the spec-only baseline; checkout fetch took 0.432s versus 27.185s.
- This evidence-only commit also provides the docs inheritance acceptance push after settlement; its result is recorded in the PR body to avoid another validation-only commit.
- Docs acceptance at `4e5795d75` correctly classified Docs and fetched only head/main metadata, but deployed because `previewResultFromChecks` stripped only one workflow-name prefix. Actual Depot check names contain `Preview / Preview / deploy + e2e /`; the parser could not find the completed finalizer. Added a failing regression using the observed nested names, then normalized the leaf job name while retaining all provenance, completeness and settlement checks. The separate unit CI failure was the unchanged Markdown multiplayer test exceeding its 10-second budget.
