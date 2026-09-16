---
status: complete
size: medium
base: codex/playwright-full-parallel
---

# Select preview work from the head commit

Status: complete for stacked code review. The algorithm, ordered rules, real Git history, live-preview lookup and workflow gating are implemented and locally validated. Live Depot/deployment acceptance remains for the eventual PR; no PR was opened. No PR: publish a compare link against `codex/playwright-full-parallel`.

## Request

Classify each changed path in the head commit using an ordered, checked-in glob map; the last matching change type wins. Docs need no preview work, tests need tests, every other type needs deployment and tests. Combine requirements across paths.

For a tests-only commit, walk backward to the merge-base with main, inclusive. At each commit, look for a usable preview deployment first. If found, use it. Otherwise classify that commit: a deploy-requiring commit ends the search and forces deployment; a docs/tests-only commit allows the search to continue. No usable deployment by the merge-base means deploy the head. A deployment at a deploy-requiring commit is acceptable because lookup precedes the barrier check.

The code expressing these decisions should be easier to follow than this prose. Keep Git, YAML, workflow output, and deployment validation details out of that reading path. Preserve the parent branch's overlapped setup and cleanup guarantees.

## Decisions / assumptions

- Compare each commit with its first parent, including merge commits. Search the head and then its first-parent ancestors, ending at the merge-base. If the merge-base is not on that chain, conservatively deploy rather than crossing an ambiguous history boundary.
- Deleted paths count. Renames contribute both old and new paths. An empty commit needs no work. Unknown paths require deployment and tests.
- Use the supplied globs and precedence as the initial policy, including broad Docs and Generated rules; do not grow this into dependency analysis or test filtering.
- Candidate tests always run from the head checkout, even when their backend was deployed at an ancestor.
- A deployment record alone is not proof: its slot must still be leased to this PR and its recorded worker versions must still be serving. Existing post-test erasure normally makes old records unusable. Do not weaken cleanup or borrow another PR's live slot. Main deployment lookup can currently return no match, as permitted by the request.
- Keep the full deployment path and immutable per-run identity checks. The lightweight planning job may install dependencies. Docs-only work should avoid starting the expensive preview jobs.
- Reuse does not mean silently accepting failures: lookup errors propagate; only a verified unavailable deployment counts as missing. If reuse becomes unsafe before preparation, deploy safely or fail before tests.
- No PR, merge, history rewrite, or changes to the parent branch. Each implementation commit carries a proposed PR body; compare base is the existing experimentation branch.

## Work

- [x] Commit this specification alone. *First commit records the interpretation before implementation.*
- [x] Implement ordered change classification and the readable ancestry decision. *`change-plan.ts` opens with the algorithm; `change-types.yml` preserves the requested rule order.*
- [x] Connect real Git history and live preview lookup, keeping integration details below the algorithm. *`commit-history.ts` handles Git; `preview.ts` validates this PR's recorded fleet and lease.*
- [x] Wire planning outputs into prepare, tests, and cleanup; preserve overlap after the decision. *One `plan` job gates all expensive jobs; existing readiness/all-settled barriers remain.*
- [x] Cover precedence, mixed changes, ancestry barriers, merge-base inclusion, usable deployment selection, and fallback with focused tests. *12 planner tests use real temporary Git repos; workflow integration assertions cover planning gates and cleanup.*
- [x] Self-review in separate passes for algorithm fidelity, deployment safety, and readability; record revisions. *See the implementation log below.*
- [x] Run relevant checks and exercise the actual CLI and workflow where possible. *333 script tests, script typecheck, scoped lint/format and real trpc-cli planning/help checks passed. No live deployment from this no-PR branch.*
- [x] Complete the task, push the branch, and supply the stacked compare link and main limitations. *Branch `codex/preview-change-types`; compare against `codex/playwright-full-parallel`.*

## Implementation log

- Base: `6073fa182c63bd6cf36a94b8347b1b4bce2857cb`, PR #2659. The parent already runs six shards and uses `preview.yml` / `preview-run.yml`.

- Self-review 1 — algorithm fidelity: verified lookup-before-barrier, inclusive boundary, head-only classification, default/mixed actions, and rename/deletion handling with real Git repositories. Side-branch merge-bases conservatively deploy.
- Self-review 2 — integration safety: rejected borrowing another PR's lease; require a full recorded fleet, an hour of lease time and live readiness; recheck during prepare. Preserve cleanup, head/run identity and worker version pinning. Main lookup remains unavailable.
- Runtime review: actual `trpc-cli` import exposed Node strip-only rejection of constructor parameter properties; changed to explicit fields. Read-only CLI classified the spec commit as Docs and returned skip; `ci-prepare --help` exposes reuse inputs.

- Self-review 3 — readability and runtime: kept the policy decision at the top of `change-plan.ts`, with Git mechanics in `commit-history.ts` and deployment validation below the CLI commands in `preview.ts`. Removed the obsolete manual-dispatch bypass and unused `ci-prepare --all-apps` input so the visible decision is authoritative. Updated deployment docs and workflow invariants.
- Validation limit: without a PR for this branch, CI cannot deploy its checkout under another PR's identity (`ci-prepare` correctly requires the actual PR head). No identity guard was bypassed to manufacture a preview run. The parent branch and PR were left unchanged.
