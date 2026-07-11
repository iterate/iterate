---
state: todo
priority: medium
size: medium
tags: [ci, depot, preview, e2e]
---

# Preview/CI reliability follow-ups from the #1793/#1795 sessions

Found 2026-07-09 while landing PR #1793 (script-result spill) and #1795
(preview pipeline self-heal). Each item is independently actionable; the
first is the important one.

## 1. Report the Depot "zero workflows on PR open" race upstream

PR #1795 opened and Depot's `pull_request` run (`l9j0mj7mt2`) finished in
3 seconds with NO jobs and a blank merge sha (`depot ci run get` showed
`Sha` empty, `head_sha` populated, ref `refs/pull/1795/merge`). The event
reached Depot before GitHub had computed the test-merge ref, so trigger
evaluation resolved no diff and matched zero workflows — including
`lint-typecheck.yml` and `test.yml`, which have NO path filter
(`pull_request: {}`). Result: a PR with no CI at all, reading
MERGEABLE/CLEAN off Cursor Bugbot alone.

This is likely the same root cause as merged PRs falsely showing "preview
skipped" (observed on #1789 the same day). Detection signature: only Bugbot
in `gh pr checks` minutes after open, plus a seconds-long finished Depot run
for the PR. Workaround: re-fire with an empty commit
(`git commit-tree <branch>^{tree} -p <branch>` + push).

Draft report for Depot support (support@depot.dev or the shared channel):

> Repo iterate/iterate, org 0p91s0lz49. On 2026-07-09T13:21:55Z, run
> l9j0mj7mt2 (trigger pull_request, ref refs/pull/1795/merge, head_sha
> 7efc57fe5ffe...) finished in 3s with zero workflows despite the repo
> having workflows with unfiltered `pull_request: {}` triggers registered
> from the default branch. The run record has an empty merge sha —
> presumably the pull_request webhook arrived before GitHub computed the
> test-merge ref, and trigger evaluation treated "no merge ref" as "no
> changed files / no workflows" instead of retrying or falling back to the
> head sha. A synchronize event (empty commit) minutes later ran everything
> normally. Expected: retry merge-ref resolution, fall back to head-sha
> diffing, or fail visibly — not an empty successful run.

Mitigation landed meanwhile: the "Required CI" repo ruleset (id 18718115,
added 2026-07-09) requires `Lint and Typecheck / lint-typecheck` and
`Test / test` on main, so an affected PR is now blocked-with-missing-checks
instead of silently mergeable. (Only always-run checks are required; the
preview check is path-filtered and would deadlock PRs that don't touch its
paths.)

## 2. Per-distinct-head compare bases in preview deploy selection

`resolvePreviewCompareBaseSha` (scripts/preview/preview.ts) picks the FIRST
recorded app entry's headSha as the single diff base. Under diff-based
selection, recorded heads legitimately diverge across apps (an app not
selected for a push keeps its older head), making selection
order-dependent. Correct shape: compare per distinct recorded head and
union the results. Flagged in #1795's "Found, not fixed" — needs a design
pass, not a quick patch.

## 3. Auth readiness endpoint is not data-aware

After `erase-data` on a slot, the auth worker still answers
`/api/auth/ok` 200 while its D1 is empty (no seeded OAuth clients), so
#1795's liveness probe cannot detect an erased auth directly — it is only
healed via the os dependency edge (an erase always parks os, and os drags
auth into the redeploy). Defense-in-depth: a readiness endpoint that
verifies seeded data exists (e.g. at least one OAuth client row), probed by
`selectRecordedGreenAppsNotServing`. Mind the deploy ordering: the deploy
smoke must keep using the shallow liveness check, since client seeding runs
after the worker deploys.

## 4. Spill fallback is one-shot (nicety)

From #1793: when an oversized script result fails to spill into the agent
workspace (e.g. repo not yet seeded), the fallback inline-truncated input is
journaled under an idempotency key and never re-rendered — the full result
remains only in the journal event. A repair lane (re-spill from the journal
on demand, or a fallback message that names the journal offset) would close
the gap. Rare in practice; the e2e guards the common cause by waiting for
the repo seed.
