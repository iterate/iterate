---
status: ready-for-review
size: medium
---

# Fetch preview planning history only when needed

Status: the async API rewrite is implemented and pushed with current main. Full local checks, real GitHub inheritance, and the merged-head preview all pass. The final request-deadline correction passes focused tests; current-head CI is tracked in PR #2744. The draft awaits review and monitoring is active.

The Plan job should use the ordinary actions/checkout defaults to get the checked-in scripts. Planning must fetch additional Git metadata only as needed, rather than making checkout fetch the entire repository history before any decision is possible.

## Intended behavior

- [x] Use ordinary checkout defaults to get the checked-in scripts. *Plan has no `fetch-depth` override.*
- [x] Read commit metadata lazily through the GitHub API, with no synchronous subprocess or constructor I/O. *`CommitHistory.throughMergeBase` is an async generator; both planner searches use `for await`.*
- [x] Keep head decisions cheap and cache metadata across replayed searches. *Head decisions use one commit request and one cached comparison for main's os-next exemption, without reading ancestors.*
- [x] Preserve green/red docs inheritance, test-only deployment reuse, rename paths and the merge-base boundary for supported histories. *HTTP integration tests drive the real Octokit client and planner.*
- [x] Prefer full deployment over reconstructing unsupported history. *Merge commits, pagination/full 100-file pages and exhaustion of 20 commits carry explicit stop reasons.*
- [x] Keep API failures visible and preserve checkout identity validation. *15-second request timeouts; checkout SHA is read with the existing async command runner.*
- [x] Run full checks and exercise a full preview, then docs-only inheritance. *All local checks passed. Merge `749781d78` passed a full settled preview; a read-only API run of docs SHA `28e52ebfe` inherited the real settled result from `e36843a25`.*
- [x] Update the PR body and handle submitted review feedback. *PR #2744 describes the final API design and preserves automated preview state. No submitted review threads; monitoring renewed through 2026-09-23 13:17 UTC.*

## Decisions and assumptions

- On 2026-09-22 the user approved the async API approach, including `for await` and conservative deployment for unsupported merge histories or response limits.
- GitHub access is required for metadata even when local history is complete. Octokit is already used by the planner's evidence readers.
- Reading a full page of 100 files falls back to deployment rather than adding pagination. This may do extra work for a large docs-only commit, but never treats a partial diff as docs-only.
- Keep result/deployment provenance validation and workflow coordination unchanged. No history rewrites or root-worktree changes.

## Implementation log

- 2026-09-21: Read the current planner, merge-boundary tests, CI workflow, repository rules, and PR workflow. Created this independent worktree from `origin/main` (`97ffd6fd65`).
- First red/green case: a depth-one product checkout originally failed on missing `origin/main`; it now deploys using one filtered fetch, retaining a clean checkout and no main ref. The docs case originally failed at the same boundary; it now expands metadata until the merge-base is proven and inherits the failed base result.
- Deliberate limit: older candidates require proving the merge boundary first. We do not inherit from a nearby ancestor before that proof, because another shallow path may conceal a newer or second merge-base. The dominant product-head path needs none of that work.

- Live product acceptance: [workflow `tt77gkjqqt`](https://depot.dev/orgs/0p91s0lz49/workflows/tt77gkjqqt) passed deployment, app tests, all six browser shards and restoration. Settlement recorded `tests=success; deployment=restored; check=106277241289`. Plan took 31s versus 55s in the spec-only baseline; checkout fetch took 0.432s versus 27.185s.
- This evidence-only commit also provides the docs inheritance acceptance push after settlement; its result is recorded in the PR body to avoid another validation-only commit.
- Docs acceptance at `4e5795d75` correctly classified Docs and fetched only head/main metadata, but deployed because `previewResultFromChecks` stripped only one workflow-name prefix. Actual Depot check names contain `Preview / Preview / deploy + e2e /`; the parser could not find the completed finalizer. Added a failing regression using the observed nested names, then normalized the leaf job name while retaining all provenance, completeness and settlement checks. The separate unit CI failure was the unchanged Markdown multiplayer test exceeding its 10-second budget.
- A real depth-one metadata fetch of `4e5795d75` from GitHub plus the captured settlement now inherits success from `44107d152` in the fixed planner. All 479 scripts tests passed after the parser fix.
- Local-use review added a regression for complete clones: planning must neither require an online remote nor turn existing full history shallow. Main refresh now applies only to shallow repositories; complete clones retain the former local-only behavior.
- Final code at `e36843a25` passed unit/lint CI. Its first preview attempt hit a transient npm 404 for the newly published `@tanstack/query-core@5.103.2` tarball; cleanup succeeded. Once the tarball returned 200, a fresh [full preview run](https://depot.dev/orgs/0p91s0lz49/workflows/th655r5qwt) passed readiness, app tests, all six browser shards and restoration, publishing `tests=success; deployment=restored; check=106287271519`. No dependency versions or timeouts changed. This subsequent docs-only commit exercises real inheritance after settlement.

- 2026-09-22: Replaced Git history reconstruction with cached asynchronous commit reads and a lazy merge-base request. Red/green tests covered one-request product decisions, inherited failures, conservative merge/size/history limits and rename paths. Migrated the remaining selection coverage to HTTP tests; the initial 47 focused tests and scripts typecheck pass.

- Merged current main to pick up its expired mobile-spec skip correction and preserve the newly merged os-next branch exemption. The exemption needs a comparison even for head decisions; the same cached response supplies the merge-base for later traversal. Tests cover reverted apps/os changes, mixed branches, a capped comparison and both rename paths.

- Full validation after merging main passed: all local workspace tests, typecheck, lint, knip and formatting; 58 focused planner/evidence/workflow tests. Live API probes selected product deployment in 1.181s (two history requests) and inherited docs success in 2.329s (three history requests plus settlement evidence). The merged-head preview settled successfully. Dependency-source inspection found Octokit v10 ignores `request.timeout`; both reads now pass an actual abort signal, retaining the 15-second deadline.
