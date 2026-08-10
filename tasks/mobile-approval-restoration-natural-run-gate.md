---
status: in-progress
size: medium
---

# Monitor the restored mobile approval flows for 25 natural previews

Status: 7/25 qualifying natural canonical preview occurrences are queryable. The restored approval and notification specs passed first attempt in all seven; 18 natural occurrences remain. One later natural run is excluded because an unrelated stream-idle assertion failed twice; exact-version traces classified it as a test observation race and the stacked fix is awaiting canonical proof.

- [x] Define the post-merge gate from durable telemetry. *A qualifying occurrence is a normally triggered canonical preview workflow with both restored specs passed, `retry_count = 0`, `passed_after_retry = false`, and one complete non-failed telemetry finalizer.*
- [x] Preserve the accepted baseline evidence. *Workflows `497719938401885`, `105920886681524`, and `114044928448857` are queryable qualifying occurrences.*
- [x] Count the first natural occurrence after the telemetry delivery diagnosis. *Workflow `294834303475777` was triggered by the normal #2470 push, passed both restored specs first attempt, and has a complete 10-artifact / 7,832-runner-event finalizer.*
- [x] Count the first natural occurrence after propagating #2467's completed trace proof. *Workflow `454307980408418` was triggered by the normal #2470 push, passed both restored specs first attempt, and has a complete 10-artifact / 7,664-runner-event finalizer.*
- [x] Count the parallel natural #2467 occurrence. *Workflow `160813051357004` passed both restored specs first attempt, had no failed or retried test, and has a complete 10-artifact / 7,814-runner-event finalizer.*
- [x] Count the natural #2467 occurrence after the merge-forward. *Workflow `81253986898872` passed both restored specs first attempt with `retry_count = 0` and `passed_after_retry = false`; retained telemetry replay produced a queryable complete 10-artifact / 7,942-runner-event finalizer.*
- [x] Classify the excluded #2470 stream-idle failure. *Workflow `278234786942377` passed both restored specs first attempt but failed an unrelated stream quiet-window assertion twice. Exact-version traces show the test's final `getEvents` observation cold-booted the Stream and wrote the reported `woken` fact; no invocation touched that object during the preceding quiet window. Commit `2231c91dc` adds a durable boot barrier and bounded cross-clock observation margin.*
- [ ] Observe 18 more qualifying natural canonical preview occurrences.
- [ ] Investigate any target retry, failure, incomplete finalizer, or missing-transition diagnostic before allowing the streak to continue.
- [ ] Record the final 25-workflow evidence set and close the restoration goal.

## Gate rules

- Manual `workflow_dispatch` validation proves a candidate but does not increase the counter.
- Retained telemetry from a naturally triggered run may be replayed idempotently when the runner predated the default-delivery fix; the trigger remains natural.
- A target retry or failure does not count and must be classified. Do not hide it with a timeout increase, a skip, or another retry layer.
- An incomplete or absent finalizer is a telemetry defect, not a clean occurrence.

## Evidence log

| count | workflow | head | PR | evidence |
| ---: | --- | --- | ---: | --- |
| 1 | `497719938401885` | `65cf9dec` | #2467 | both targets clean; complete finalizer |
| 2 | `105920886681524` | `dc0ce4fe` | #2467 | both targets clean; complete finalizer |
| 3 | `114044928448857` | `dea98701` | #2470 | both targets clean; complete finalizer |
| 4 | `294834303475777` | `b9c2364b` | #2470 | both targets clean; complete 10-artifact finalizer |
| 5 | `454307980408418` | `70701a66` | #2470 | both targets clean; complete 10-artifact finalizer |
| 6 | `160813051357004` | `24586385` | #2467 | both targets clean; complete 10-artifact finalizer |
| 7 | `81253986898872` | `73063073` | #2467 | both targets clean; complete 10-artifact / 7,942-runner-event finalizer |

Manual workflow `350306797014989` on `081ff01f` proved default PostHog delivery and is intentionally excluded from the counter.

Natural workflow `278234786942377` on `965beafd` is intentionally excluded: both restored targets were clean, but the complete finalizer correctly reported an unrelated Vitest failure and retry.
