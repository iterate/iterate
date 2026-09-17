# CI trace outcomes and layout

Status: implementation complete. Local tests, typecheck, lint, historical replays and independent review pass. Trace collection runs inside `finish`, after validated green and before cleanup; cleanup is excluded. Fresh live evidence is recorded in PR #2718. Earlier sections below record the previous design.

- [x] Show **Time to red** for failed workflows, measured from workflow execution start to the first failed job completion. Do not count a retried test attempt as a red workflow. Keep any earlier green milestone in the trace evidence. *Implemented as OTLP attributes and a red event in `tracing.ts`.*
- [x] Put the planning job first, while retaining stable grouping of parallel test jobs and cleanup last. *The viewer ranks the plan job first; the collector names it Plan.*
- [x] Give span labels enough vertical space for descenders without losing horizontal ellipsis. *A 1.5 line-height leaves 19.5px for 13px text.*
- [x] Verify with the reported failed workflow `hjrrdf5flj`, focused assembly tests and browser checks; also check a successful report. *The real failed run shows 2m55s to red vs 6m59s total; desktop/390px checks and a green report pass.*

Assumptions: Depot's failed job completion timestamp is the available failure signal; if no failed job timestamp exists, use failed workflow completion and say so. Cancellation alone is not failure. Original scope is report generation and presentation; the follow-up below moves collection into the preview workflow without changing test policy.

## Implementation log

- User report: failed trace says “Not recorded / Time to green”; plan appears below tests; the descender in “plan” is clipped. Screenshot artifact: `01a0afad-84c7-7cc0-aeff-14e60fe36f85`.

- Validation: 31 tracing tests and all 406 scripts tests pass. Full typecheck, lint, Knip and format checks pass. The initial parallel repository test command hit two 5s scripts timing limits; both pass when the scripts suite runs alone. CI will verify the full suite on its runner.

## Inline trace collection follow-up

Status: verified end to end. The collector runs after cleanup, uploads the report and gets an automatic CI trace status. Dispatch and scheduled repair are removed.

- [x] Add a trace job in `preview-run.yml` after preparation, tests and cleanup, with `if: always()`. *Uses the ordinary Depot dependency graph.*
- [x] Remove the separate collector workflow, dispatch/reconcile CLI code and obsolete path triggers. *Removed `ci-trace.yml` and its callbacks.*
- [x] Measure completed preview jobs through cleanup, excluding report generation itself. Refuse an incomplete producer set; preserve failed/cancelled results. *Assembly regressions cover active/failed collectors and pending producers.*
- [x] Upload `public-ci-trace-<workflow>-<execution>`; update the config project’s report-link allowlist. *The name preserves the measured execution on collector-only retries; all 20 route/publication tests pass. Config commits `b3f4e84` and `1474197` are deployed from main.*
- [x] Verify success/failure timing, both workflow entry points and the live uploaded report. *PR workflow `m9d6dlgz3c` and main replay `6hjqmht0vr` pass; the first inline run also collected successfully after cleanup failed. Cancelled runs may miss a report if Depot cancels the collector too; no scheduled repair is retained.*

- Inline follow-up local validation: 418 scripts tests (43 tracing tests), scripts typecheck, focused lint and formatting pass. Config report handler passes strict scoped typecheck and all 20 tests. Independent review found a collector-only retry timing bug; a regression now proves it retains the original measured execution, and follow-up review found no blockers.

- First inline run caught the early-green guard treating the queued report job as unfinished test work. `setPendingCheckGreen` now excludes the downstream trace job while requiring every other producer to succeed. The failed run remains useful evidence that collection runs after a failed cleanup job.

## Workflow queue visibility follow-up

- [x] Show the selected execution's creation-to-start interval as a striped queue span before Plan, preserving elapsed time. *Uses Depot execution timestamps; both regular reruns and collector-only retries retain the selected execution.*
- [x] Show cancellation before start honestly and avoid labelling runner setup/checkout as queue time. *No execution start is invented; missing metadata with started runners creates no queue span.*
- [x] Replay main workflow `6hjqmht0vr` and verify its known 40s wait in the browser. *The striped top-level queue is exactly 40s; 9m9s total and 7m36s to green remain unchanged. Evidence from startup investigation task `01a0adf1-7f20-7cd0-a45b-72757db41c43`.*

- Queue review added regular and inline cancelled-rerun regressions. Execution selection uses producer completion evidence; old completed runners no longer hide a rerun cancelled before startup. All 418 scripts tests pass.

- Final live proof on `ed8395f82`: all CI checks passed. Workflow `m9d6dlgz3c` cleanup finished at 15:14:03 UTC; its trace job ran 15:14:09–15:14:17 (8s). The automatic **CI trace** status appeared at 15:14:24. Artifact `01a0afee-cb06-7605-98ae-b6ba5cc714ca` opens its viewer at the origin root (HTTP 200), showing 6m30s to green and 8m6s through cleanup. This completion commit only updates the task record.

## Tests-only trace follow-up

- [x] Collect and upload within `finish`, after validated green and before cleanup; remove the separate trace job. *Reuses the finalizer runner; collection has a five-minute step timeout and cleanup still uses `always()`.*
- [x] Exclude the whole finalizer from the trace and remove the wall-time statistic. *Uses only its test verdict; producer/validation failures still yield Time to red, while later cleanup failures cannot change an observed green milestone.*
- [x] Keep green immediately after result validation. *`tests_passed` is already that patch step. `ci-finish` checks merged test count and all shard receipts, so moving it before validation would weaken the result.*
- [x] Retain the check summary with a neutral title. *GitHub requires `output.title` with `summary`; “Preview test summary” remains accurate after a cleanup failure.*
- [x] Verify assembler, workflow wiring and historical success/failure replays. *All 425 scripts tests (50 tracing tests), scripts typecheck and scoped lint pass. Replayed cleanup-failure `j13rpz137h` (3m20s green), test-failure `hjrrdf5flj` (2m55s red), and main queue `6hjqmht0vr`. Desktop/mobile inspection and independent review found no blockers. PR #2718 carries fresh CI evidence.*

- Live run `qtj330b5z8` passed all tests and cleanup, but exposed delayed log visibility: the immediately collected trace lacked the just-acknowledged green marker. The status CLI and shell hook now pass measured verdict records through step outputs, bound to the current finish attempt; no polling or new job is needed. Tests cover a local validation failure with no published start record and exact shell-exit output on success/failure. Fresh corrected-run evidence is recorded in PR #2718.
