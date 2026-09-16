---
status: in-progress
size: large
---
# Playwright shards with overlapping preparation

Status: agreed design; implementation starting in PR #2659. Existing measurements stay published. The new run, failure-path checks, and updated trace remain to do.

Run the nine-job experiment: prepare, six identical 16-worker Playwright shards, app/backend tests, and teardown/reporting. Test jobs start immediately and install before waiting inside the job. Teardown needs only prepare, installs while tests run, waits for every consumer to terminate, then independently merges reports and erases the environment.

- [ ] Restore the existing deployment plan, fixed-capacity check, shard receipts and merged reporting. Preserve checked-out SHA, deployment version and lease validation.
- [ ] Add a bounded milestone waiter: exact producer attempt GitHub status, checked against Depot producer liveness; never consume an earlier execution's signal or silently follow a retry.
- [ ] Cover live milestone, producer termination without signal, stale attempts, failure and all-settled cleanup behavior through public HTTP boundaries.
- [ ] Start all seven consumers without needs; publish readiness only after the plan is downloadable. Preserve the workflow-wide preview lifecycle lock and cancellation cleanup backstop.
- [ ] Start teardown after prepare, await all consumers including backend tests, merge reports concurrently with cleanup, and fail for missing/failed results.
- [ ] Run required checks and a live six-shard preview; inspect job timing, retries, cleanup and telemetry.
- [ ] Publish the interactive trace and comparison in the permanent explainer; update PR body and resolve review feedback.

## Agreed constraints and assumptions

- Same PR/branch, no merge. Keep six shards × sixteen workers on 16-core runners for comparison.
- GitHub status is a milestone, not job success. A successful milestone remains reached even if later work fails.
- Teardown does not mistake a wait error/timeout for proof that test jobs stopped.
- All-settled cleanup covers every test job and its report upload. Hard cancellation can skip always steps; pre-deploy erase remains the recovery path.
- Verify Depot authentication, attempt identity and artifact visibility in real CI before trusting the experiment.
- Preserve historical measurements and report setup/queue/install time separately from test time; do not loosen tests, retries or timeouts to obtain green.

## Implementation log

