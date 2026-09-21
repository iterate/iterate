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

Plan uses an ordinary depth-one checkout to get its scripts. The history reader
reads the actual commit's parent header (Git's revision walker hides parents at
shallow boundaries), then fetches three additional generations only if that
parent is missing. Fetches use `--filter=blob:none` and no tags; filename diffs
disable rename detection, so historical file contents are not downloaded.
A product head can decide deployment immediately, without fetching main. A
test head can also reuse its own verified deployment without inspecting main.

In shallow CI checkouts, only a search for older evidence fetches main, once,
at depth four. Complete local clones use their existing history without
fetching or becoming shallow. The reader
then deepens head and that pinned main SHA as needed to prove the merge-base:
3, 9, 27, then up to three batches of 81 generations. Finding a merge-base is
not enough if another shallow path could hide a newer or second one; every
path above the candidate bases must be complete. Budget exhaustion deploys
head with an explicit reason. Each fetch is logged and has a 15-second timeout;
transport and authentication failures fail planning. No checkout, index, or
working-tree files change during these metadata fetches.

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
currently recorded fleet, with an unexpired lease still owned by the PR in the
semaphore. Every app's
recorded SHA, URL and Worker name must match; Cloudflare must still route 100%
of traffic to its recorded version. Public readiness must succeed, including
version headers where supported. Missing/unhealthy/replaced deployments are
unusable; inventory or authentication errors fail visibly. No lease is renewed
or borrowed during planning. Prepare renews only the selected slot for three
hours using the existing same-holder adoption, without erasing it. It then
rechecks ownership, serving versions and readiness. A short remaining lease
therefore does not require deployment; a missing/unusable candidate still falls
back to deploying head.

PR #2695 retires old DO classes and then restores usable Workers. The planner
checks the restored version IDs, never the earlier versions from before cleanup.
Main can supply a completed result, but there is no borrowable main deployment
registry yet.

## Workflow and rollout

```text
plan:    checkout head → install → decide (fetch metadata as needed) → signal preview-plan
prepare: checkout → install → wait for preview-plan → deploy/reuse → ready
                                           │                          │
             inherit: skip remaining steps │                          │
             tests needed:                 ├─ apps setup → wait ──────┤→ tests
                                           └─ six shards setup → wait┘→ tests
prepare done → finish setup → wait for all consumers → validate results → trace → erase + restore
```

The caller holds the existing lifecycle lock around this entire workflow.
`plan` and `prepare` start together. `prepare` pays for checkout and installation
even when inheriting a result, but deployment never waits for those tasks to
start after planning. App tests and shards keep their job-level planning gate.
Consumers still use an immutable deployment plan tied to the current head,
workflow run and attempt; only the deployed revision may be older. Cleanup still
waits for all consumers to settle.

Shards start Metro during setup, before waiting for the backend. The finalizer
collects preparation and test traces before cleanup, including individual Vitest
tests. `preview-settled` still waits for successful cleanup and restoration.

The plan publishes `action`, `commit`, `tests` and `deploy`, plus `conclusion`
for inheritance or `slot` for reuse. For example:

```text
action=inherit; conclusion=success; commit=<ancestor SHA>; tests=false; deploy=false
action=reuse; commit=<deployment SHA>; slot=preview-16; tests=true; deploy=false
action=deploy; commit=<head SHA>; tests=true; deploy=true
```

The planner writes these values as one JSON step output; the workflow publishes
that payload, excluding the shell tracer's unrelated `ci-trace-end` output.
`status.ts wait-for` writes those values to step outputs, so `prepare` reads `steps.plan.outputs.tests` and the
reuse identity. Milestone descriptions accept small, single-line values (140
characters total); reasons and artifacts stay in their existing logs/storage.
Names and values are validated before publication; values cannot contain
semicolons or newlines. The waiter converts semicolon separators into output
lines directly. `options.values || { milestone }` supplies a `milestone` output
only when no values are provided.

The context is `<milestone> <attemptId>`, for example `preview-plan hlb267st2d`.
Depot's unique attempt ID identifies the producer; job, workflow and
execution IDs add no disambiguation. Both sides still validate membership in
the current workflow, checkout and repository, and reject retried workflows.
Its `success` means **decision available**, including an inherited red decision:
the plan job still fails, while `prepare` receives `tests=false` and stops after
its wait. If planning fails before deciding, its termination fails the waiter.
Every subsequent prepare step, including failure-path artifact uploads, requires
`tests=true`. The finalizer also uses that decision, even if the plan job fails
after publishing it: prepare might already have begun deploying and still needs
cleanup. Test jobs retain their successful-plan dependency.

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

Prepare-overlap acceptance at `a511549af` ([run](https://depot.dev/orgs/0p91s0lz49/workflows/hg2flkdj90))
confirmed that prepare's dependency install finished at 15:06:19 UTC, before
planning published its signal at 15:06:53. The wait returned all four values;
deployment, app tests, six browser shards and restoration succeeded, followed
by `preview-settled`. The independent unit job hit the existing dependency-test
case `changed pnpm-lock.yaml runs a frozen install`'s five-second limit; that
test is unchanged by this work.

The finalizer follow-up at `8f4df71e3`
([run](https://depot.dev/orgs/0p91s0lz49/workflows/czk85wphzh)) passed all workflows,
including all 441 scripts tests without changing the timed-out test. Deployment,
both deployed suites and restoration passed; settlement recorded `tests=success`
at 15:24:46 UTC.

Docs-only `2e5011617`
([run](https://depot.dev/orgs/0p91s0lz49/workflows/wj7jlq6mb5)) inherited that success.
The prepare log contains only checkout, installation, and the milestone wait,
which returned `tests=false` and `deploy=false`. Every later prepare step skipped;
the other eight jobs had zero runner attempts. The planning log includes the
ancestor-to-head GitHub compare link.

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

## Lazy history acceptance

[PR #2744](https://github.com/iterate/iterate/pull/2744) measured these two Plan
jobs on the same baked CI image. These are individual observations, not an
averaged benchmark; the baseline docs commit reached an untested product
ancestor, while the implementation commit required deployment at head.

| Measurement                           | Full-history checkout (`ba8ff38c5`) | Lazy metadata (`44107d152`)                              |
| ------------------------------------- | ----------------------------------- | -------------------------------------------------------- |
| Plan job                              | 55s                                 | 31s                                                      |
| Checkout fetch phase                  | 27.185s                             | 0.432s                                                   |
| Metadata fetches inside planning      | None                                | One `--deepen=3 --filter=blob:none` fetch; no main fetch |
| Metadata fetch start through decision | Not separately measured             | 1.170s                                                   |

The [baseline Plan](https://depot.dev/orgs/0p91s0lz49/workflows/x103v367zm?job=8lspj90c2k&attempt=115srn7fzs)
and [lazy Plan](https://depot.dev/orgs/0p91s0lz49/workflows/tt77gkjqqt?job=4915hvtkq2&attempt=cxn3gs0zq8)
logs identify both checkout fetch boundaries and the planning decision. The
lazy job published `tests=true; deploy=true` for the exact implementation SHA.
Its local regression test also verifies that the former product blob remains
absent after the filtered fetch and that the checkout stays clean.

Local validation passed all 31 focused planner/workflow tests, repository
typecheck, lint, unused-code checks and formatting. The complete repository
suite passed with `pnpm -r --workspace-concurrency=1 test`. Parallel local runs
hit five-second timeouts: the new history fixture was shortened, and an
unchanged telemetry subprocess test passed when workspaces ran serially. No
timeouts were increased.

The implementation run also passed deployment, app tests and all six browser
shards, then restored the preview. Its [settlement](https://depot.dev/orgs/0p91s0lz49/workflows/tt77gkjqqt?job=fx5b2kkt74&attempt=rl1ltfjsrr)
recorded `tests=success; deployment=restored; check=106277241289`. The following
evidence-only commit tests docs inheritance; its result is recorded in the PR
body so the acceptance record does not itself require another push.

The first docs-only push exposed an existing evidence-reader mismatch: Depot
reported `Preview / Preview / deploy + e2e / App tests`, while the reader
removed only one prefix and rejected the settled run. A regression now covers
those actual nested names, and the reader matches the leaf job name while
retaining every provenance and completeness check. Replaying the real
`44107d152` checks/statuses then recognized its settled success.
