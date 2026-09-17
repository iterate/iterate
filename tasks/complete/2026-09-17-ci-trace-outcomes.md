# CI trace outcomes and layout

Status: display changes passed CI and review. Inline collection after cleanup is implemented and independently reviewed; live artifact/status verification is pending.

- [x] Show **Time to red** for failed workflows, measured from workflow execution start to the first failed job completion. Do not count a retried test attempt as a red workflow. Keep any earlier green milestone in the trace evidence. *Implemented as OTLP attributes and a red event in `tracing.ts`.*
- [x] Put the planning job first, while retaining stable grouping of parallel test jobs and cleanup last. *The viewer ranks the plan job first; the collector names it Plan.*
- [x] Give span labels enough vertical space for descenders without losing horizontal ellipsis. *A 1.5 line-height leaves 19.5px for 13px text.*
- [x] Verify with the reported failed workflow `hjrrdf5flj`, focused assembly tests and browser checks; also check a successful report. *The real failed run shows 2m55s to red vs 6m59s total; desktop/390px checks and a green report pass.*

Assumptions: Depot's failed job completion timestamp is the available failure signal; if no failed job timestamp exists, use failed workflow completion and say so. Cancellation alone is not failure. Original scope is report generation and presentation; the follow-up below moves collection into the preview workflow without changing test policy.

## Implementation log

- User report: failed trace says “Not recorded / Time to green”; plan appears below tests; the descender in “plan” is clipped. Screenshot artifact: `01a0afad-84c7-7cc0-aeff-14e60fe36f85`.

- Validation: 31 tracing tests and all 406 scripts tests pass. Full typecheck, lint, Knip and format checks pass. The initial parallel repository test command hit two 5s scripts timing limits; both pass when the scripts suite runs alone. CI will verify the full suite on its runner.

## Inline trace collection follow-up

Status: implemented locally. The collector is now a dependent preview job; dispatch and scheduled repair are removed. Live artifact/status verification is pending.

- [x] Add a trace job in `preview-run.yml` after preparation, tests and cleanup, with `if: always()`. *Uses the ordinary Depot dependency graph.*
- [x] Remove the separate collector workflow, dispatch/reconcile CLI code and obsolete path triggers. *Removed `ci-trace.yml` and its callbacks.*
- [x] Measure completed preview jobs through cleanup, excluding report generation itself. Refuse an incomplete producer set; preserve failed/cancelled results. *Assembly regressions cover active/failed collectors and pending producers.*
- [x] Upload `public-ci-trace-<workflow>-<execution>`; update the config project’s report-link allowlist. *The name preserves the measured execution on collector-only retries; all 19 route/publication tests pass. Config commit `b3f4e84` is deployed from main.*
- [ ] Verify success/failure timing, both workflow entry points and the live uploaded report. Cancelled runs may miss a report if Depot cancels the collector too; no scheduled repair is retained.

- Inline follow-up local validation: 416 scripts tests (41 tracing tests), scripts typecheck, focused lint and formatting pass. Config report handler passes strict scoped typecheck and all 19 tests. Independent review found a collector-only retry timing bug; a regression now proves it retains the original measured execution, and follow-up review found no blockers.

- First inline run caught the early-green guard treating the queued report job as unfinished test work. `setPendingCheckGreen` now excludes the downstream trace job while requiring every other producer to succeed. The failed run remains useful evidence that collection runs after a failed cleanup job.

## Workflow queue visibility follow-up

- [x] Show the selected execution's creation-to-start interval as a striped queue span before Plan, preserving elapsed time. *Uses Depot execution timestamps; both regular reruns and collector-only retries retain the selected execution.*
- [x] Show cancellation before start honestly and avoid labelling runner setup/checkout as queue time. *No execution start is invented; missing metadata with started runners creates no queue span.*
- [x] Replay main workflow `6hjqmht0vr` and verify its known 40s wait in the browser. *The striped top-level queue is exactly 40s; 9m9s total and 7m36s to green remain unchanged. Evidence from startup investigation task `01a0adf1-7f20-7cd0-a45b-72757db41c43`.*
