# Choose preview work from the head commit

`pnpm preview ci-plan` answers three questions: run tests, deploy first, or
inherit an existing result? Start with
[`planPreview`](../scripts/preview/change-plan.ts). The decision loop is at the
top; Git and remote evidence live elsewhere.

This change builds on PR #2695's park/restore lifecycle. It adds ancestry
selection and an explicit settlement signal.

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

A **result** requires an explicit `preview-settled` commit status from the newest
complete preview run. Early-green GitHub checks alone are insufficient. The
signal is published once, after complete test collection and successful cleanup
and restoration, as the final workflow step:

```yaml
context: preview-settled
state: success
description: "tests=failure; deployment=restored; check=105095187178"
target_url: <exact Depot workflow/job/attempt URL>
```

`success` means settlement succeeded; the description records the inheritable
**test** outcome. Failed tests remain red in their original checks. No pending
status is created, so settlement does not hold up early green. Do not require
this marker as a merge check.

The check ID and URL bind the signal to its producer. The reader rejects newer
unfinished runs, replaced finalizers, and test attempts completed after the
signal. Cancellation, incomplete reports, missing/foreign receipts and command
timeouts cannot certify a revision. Failed restoration publishes nothing, even
if tests finished conclusively; a later docs change falls back to CI. Historical
runs without the signal also fall back. Inherited planning results never publish
it; later docs walk to the original full-run evidence.

A **deployment** also requires that settled evidence, then must be this PR's
currently recorded fleet, still owned by
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
plan:    checkout full history → install → decide → signal preview-plan
prepare: checkout → install → wait for preview-plan → deploy/reuse → ready
                                           │                          │
             inherit: skip remaining steps │                          │
             tests needed:                 ├─ apps setup → wait ──────┤→ tests
                                           └─ six shards setup → wait┘→ tests
prepare done → finish setup → wait for all consumers → collect + erase + restore
```

The caller holds the existing lifecycle lock around this entire workflow.
`plan` and `prepare` start together. `prepare` pays for checkout and installation
even when inheriting a result, but deployment never waits for those tasks to
start after planning. App tests and shards keep their job-level planning gate.
Consumers still use an immutable deployment plan tied to the current head,
workflow run and attempt; only the deployed revision may be older. Cleanup still
waits for all consumers to settle.

The plan publishes `tests`, `deploy`, `commit`, and `slot` as string values in the
`preview-plan` milestone's JSON description. `status.ts wait-for` writes those
values to step outputs, so `prepare` reads `steps.plan.outputs.tests` and the
reuse identity. Milestone descriptions accept small, single-line values (140
characters total); reasons and artifacts stay in their existing logs/storage.
Existing milestones carry an empty object and need no extra arguments.

The signal identifies the exact Depot workflow execution, job and attempt.
Its `success` means **decision available**, including an inherited red decision:
the plan job still fails, while `prepare` receives `tests=false` and stops after
its wait. If planning fails before deciding, its termination fails the waiter.
Every subsequent prepare step, including failure-path artifact uploads, requires
`tests=true`.

**Before rollout, require `Preview / Plan preview work` as a merge check.**
Inherited red fails that job; skipped downstream jobs alone cannot enforce it.
Keep the existing full-run test/finalizer checks required too, so a successful
plan cannot hide failed tests. This branch does not change repository settings.
Depot registers trigger changes from main, so removing the old cumulative PR
path filter also needs the eventual merge.

Local validation covers real temporary Git histories, check-run parsing,
deployment version parsing and workflow wiring. Read-only live checks recognized
successful and failed PR runs, a successful main run, and the current Cloudflare
deployment response. The earlier CLI inherited PR #2693's successful result; that historical run now
lacks the required settlement marker and is intentionally inconclusive.

## Live acceptance

[PR #2712](https://github.com/iterate/iterate/pull/2712) exercises separate pushes,
waiting for each entire run, including cleanup/restoration, before the next:

| Change                    | Observed preview behavior                                                                                                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full run at `e1a5838dc`   | Deployed all six apps, passed deployed tests, restored the preview and published `tests=success`. [Run](https://depot.dev/orgs/0p91s0lz49/workflows/hwk5nxq2x4).                                      |
| Tests only at `0dcb04c42` | Selected `reuse` of `75951cc06`, skipped preparation deployment, passed deployed tests and restored all six apps. [Run](https://depot.dev/orgs/0p91s0lz49/workflows/bzhzzvxxwn).                      |
| Docs only at `a41561887`  | Inherited success from `0dcb04c42`. The planning job took 32 seconds; all nine downstream jobs were skipped with zero runner attempts. [Run](https://depot.dev/orgs/0p91s0lz49/workflows/kf201tf7t8). |

The downloaded preparation artifact proves that the tests-only run used the
parent's six exact restored Worker versions while running tests from the new
head. The preparation log contains no provision/deploy operation. Restoration
after tests still deploys; reuse removes the deployment before tests.

The intervening `75951cc06` run also reused the baseline, but an extra health
probe added for acceptance hit Playwright's one-second request budget. That
probe was removed; the deployment artifacts already provide stronger evidence.
Its cleanup succeeded and published `tests=failure`, which let `0dcb04c42` prove
that test changes can reuse a clean deployment even after a failed test run.
An earlier native Node import failure and an overly broad CLI regression test
were fixed; the focused native-module test and subsequent unit CI passed.

The docs-only plan returned `action: inherit`, `tests: false`, and `deploy: false`.
Its PR deployment record retained all six restored versions; the live OS health
endpoint still returned the recorded version. Other workflows, such as unit
tests and lint, remain independent of preview selection and still run.

## Restoration after deployment reuse

CI restoration verifies the immutable preparation artifact's run, attempt, head,
slot and exact recorded app deployments. The deployment SHA may be an ancestor;
the test checkout remains the current head. A changed Worker version, source SHA,
Worker name or URL refuses restoration. Retirement still happens first so missing
provenance cannot leave test projects spending.

After tests use an ancestor, restoration deploys the full fleet from the tested
head. That leaves one recorded source revision for subsequent reuse, rather than
a mix of head and ancestor apps. This is post-test work; preparation still skips
its deploy. Ordinary full runs retain the existing three-app restoration.

`preview-restoration.json` records tested and restored SHAs and Worker versions.
`preview-settled` is published only after the restore succeeds. Main/manual runs
continue to request full deployment and tests.
