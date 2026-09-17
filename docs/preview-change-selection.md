# Choose preview work from the head commit

`pnpm preview ci-plan` answers three questions: run tests, deploy first, or
inherit an existing result? Start with
[`planPreview`](../scripts/preview/change-plan.ts). The decision loop is at the
top; Git and remote evidence live elsewhere.

This no-PR branch is stacked on the park/restore experiment, PR #2695. Its diff
contains only ancestry selection; the closed storage-wipe experiment is excluded.

| Head changes                  | Work                                                                   |
| ----------------------------- | ---------------------------------------------------------------------- |
| Docs only, or an empty commit | Find a conclusive ancestor result; inherit its green **or red**.       |
| Tests, optionally with docs   | Run head's tests against a usable ancestor deployment, or deploy head. |
| Anything else                 | Deploy the full preview fleet and run tests.                           |

[`change-types.ts`](../scripts/preview/change-types.ts) assigns each changed
path one type: **last match wins**. Changes mean head versus its first parent,
including both paths of a rename. Docs is an explicit allowlist, so markdown
inside a prompt or config template still needs deployment. Mixed commits take
the union of required work. Main and manual dispatch always request full work.

## Reading history

Inspect head, then its first parent, and so on through the merge-base with
main, inclusive. A merge's changed paths include everything it brought into
the feature branch. If main is its second parent, inspect that merge and newer
first-parent commits, then stop; substituting main would omit feature code.
Multiple merge-bases fall back to deployment. Git/API errors remain errors.

For docs, look for a conclusive result **before** classifying each ancestor.
Stop at an untested behavior change instead of walking past it to an older
green. A product change needs deployment; a test change needs tests and starts
the deployment search. For tests, look for a usable deployment **before**
asking whether that commit changed product code. A deployment on that product
commit is precisely the one we want. An undeployed product commit stops the
search. Reaching the boundary without evidence also means deploy head.

Examples, oldest to newest:

```text
product (red)   → docs → docs   inherits red
product (green) → docs         inherits green
product (untested) → docs      deploys and tests head
product (live) → test change   tests head against product's preview
product (parked) → test change deploys and tests head
product (green) → new untested product → docs
                              deploys; cannot skip the new product change
```

## What counts as evidence

A **result** is the newest complete Depot preview workflow on that exact SHA:
prepare, app tests, six browser shards and final collection. GitHub check IDs
keep workflow histories apart; a newer incomplete workflow blocks an older
green. Missing, running, cancelled, skipped and partially rerun checks do not
certify a revision. A completed failure remains failure. Lightweight inherited
planning results are not treated as full runs; later docs walk through them to
the original evidence.

A **deployment** must be this PR's currently recorded fleet, still owned by
the PR in the semaphore, with at least an hour left on its lease. Every app's
recorded SHA, URL and Worker name must match; Cloudflare must still route 100%
of traffic to its recorded version. Public readiness must succeed, including
version headers where supported. Missing/unhealthy/replaced deployments are
unusable; inventory or authentication errors fail visibly. No lease is renewed
or borrowed during this lookup. Prepare checks again before reuse and falls
back to deploying head if the candidate became unusable.

PR #2695 retires old DO classes and then restores usable Workers. The planner
checks the restored version IDs, never the earlier versions from before cleanup.
Main can supply a completed result, but there is no borrowable main deployment
registry yet.

## Workflow and rollout

```text
plan (small machine: checkout full history, pnpm install, ci-plan)
  ├─ inherit: exit green or red; no preview jobs
  └─ tests needed:
       prepare ───────────────┐
       apps setup → wait → tests
       six shards setup → wait → tests
                              └─ finish setup → wait for all → collect + erase + restore
```

The caller holds the existing lifecycle lock around this entire workflow.
The planning job adds one install before expensive jobs start, preserving
overlapped preparation afterwards. Consumers still use an immutable plan tied
to the current head, workflow run and attempt; only the deployed revision may
be older. Cleanup still waits for all consumers to settle.

**Before rollout, require `Preview / Plan preview work` as a merge check.**
Inherited red fails that job; skipped downstream jobs alone cannot enforce it.
Keep the existing full-run test/finalizer checks required too, so a successful
plan cannot hide failed tests. This branch does not change repository settings.
Depot registers trigger changes from main, so removing the old cumulative PR
path filter also needs the eventual merge.

Local validation covers real temporary Git histories, check-run parsing,
deployment version parsing and workflow wiring. Read-only live checks recognized
successful and failed PR runs, a successful main run, and the current Cloudflare
deployment response. The actual CLI inherited PR #2693's successful result.
**A live gated workflow and successful tests-only reuse still need acceptance
runs.** This is a no-PR review branch; no preview was claimed or deployed for it.

## Follow-up integration before rollout

This restack preserves #2695's behavior rather than changing its lifecycle:

- Restoration currently requires each app's recorded deployment SHA to equal
  the tested head. A reused ancestor intentionally differs, so that guard must
  learn about the prepared test/deployment identities before tests-only reuse
  can complete restoration. Until then, it refuses restoration after retirement.
- #2695 can complete the GitHub finish check before Depot actually finishes.
  Result inheritance currently reads GitHub checks; establish final Depot
  completion too before treating an early green as conclusive ancestor evidence.

These are rollout blockers, not claims of verified reuse. The work in #2695
does not depend on resolving them.
