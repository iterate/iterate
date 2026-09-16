---
status: complete
size: large
---
# Playwright shards with overlapping preparation

Status: implementation and successful repeat complete in PR #2659. All nine jobs, merged reports, telemetry and cleanup passed in run `0cvh1fw749`. The permanent explainer defaults to that green run with expandable setup/wait/test/upload phases; the first failed measurement remains in history.

Run the nine-job experiment: prepare, six identical 16-worker Playwright shards, app/backend tests, and teardown/reporting. Test jobs start immediately and install before waiting inside the job. Teardown needs only prepare, installs while tests run, waits for every consumer to terminate, then independently merges reports and erases the environment.

- [x] Restore the existing deployment plan, fixed-capacity check, shard receipts and merged reporting. Preserve checked-out SHA, deployment version and lease validation. *Restored in preview.ts and ci-identity.ts; six blob reports merged in the live run.*
- [x] Add a bounded milestone waiter: exact producer attempt GitHub status, checked against Depot producer liveness; never consume an earlier execution's signal or silently follow a retry. *status.ts uses exact workflow/execution/job/attempt status contexts and Depot liveness.*
- [x] Cover live milestone, producer termination without signal, stale attempts, failure and all-settled cleanup behavior through public HTTP boundaries. *Live run exercised milestone delivery and failure-aware cleanup. The status unit-test file was removed at the user’s request.*
- [x] Start all seven consumers without needs; publish readiness only after the plan is downloadable. Preserve the workflow-wide preview lifecycle lock and cancellation cleanup backstop. *All seven consumers prepared before readiness in run fr1lf3l0rs.*
- [x] Start teardown after prepare, await all consumers including backend tests, merge reports concurrently with cleanup, and fail for missing/failed results. *Finish installed by +434s, waited until +575s, and completed erase after the shard failure.*
- [x] Run required checks and a live six-shard preview; inspect job timing, retries, cleanup and telemetry. *Full local suite/typecheck/lint/knip passed before the first run; 331 script tests and captured telemetry replay passed after the scope fix.*
- [x] Publish the interactive trace and comparison in the permanent explainer; update PR body and resolve review feedback. *Permanent explainer retains thirteen traces; PR links the frozen report, with publication checks and reviews tracked there.*

## Agreed constraints and assumptions

- Same PR/branch, no merge. Keep six shards × sixteen workers on 16-core runners for comparison.
- GitHub status is a milestone, not job success. A successful milestone remains reached even if later work fails.
- Teardown does not mistake a wait error/timeout for proof that test jobs stopped.
- All-settled cleanup covers every test job and its report upload. Hard cancellation can skip always steps; pre-deploy erase remains the recovery path.
- Verify Depot authentication, attempt identity and artifact visibility in real CI before trusting the experiment.
- Preserve historical measurements and report setup/queue/install time separately from test time; do not loosen tests, retries or timeouts to obtain green.

## Implementation log

- Restored historical sharding components from `2996ffc9c`; moved setup before an in-job readiness barrier. Finalizer starts after prepare and polls all seven consumers in one API call per cycle.
- Confirmed the existing Doppler organization token can read Depot GetWorkflow, including workflow execution IDs and concrete producer attempts. No credentials printed or added to Depot.
- HTTP boundary tests cover milestone delivery while the producer runs, termination without a milestone, stale attempts/commits, bounded waiting, final-signal ordering and collecting failures without cleaning up live consumers.

- First run `fr1lf3l0rs` / `b002e9f0c`: 698.328s total; longest browser reporter 73.706s; OS Vitest 144.107s; four retries; Docs click failed outside its existing quarantine pattern. All six reports retained and merged. Cleanup succeeded after all consumers settled.
- The restored workflow passed an obsolete `--workflow-scope` flag. Added explicit job/workflow completeness scope without rewriting reporter identities. Regression cases retain repository/run/attempt and source-count validation; replay of all 17 real artifacts succeeds.
- No application/spec code, timeouts, retries, or quarantine patterns changed. Earlier measurements remain intact. Shard-only reruns remain intentionally unsupported after cleanup.

- User review: switched status.ts to a default-exported trpc-cli command class, commands first; removed the ad-hoc argv parser, injected test configuration and status.test.ts.

- Successful repeat `0cvh1fw749` / `1dd7a8147`: 608.512s total, longest browser reporter 67.835s, OS Vitest 115.571s. All 88 active browser bodies passed with zero retries; one OS Vitest retry. All 17 telemetry artifacts were complete and matched the workflow.
- User-requested trace hierarchy: each browser job defaults open to four sequential phases. Setup exposes install steps; Run Playwright exposes individual attempts directly. Both overlapping datasets retain measured boundaries and unchanged test timings. No run was interrupted to publish this update.

- [x] Rename the workflow entry point to `preview.yml` and reusable workflow to `preview-run.yml`. *Updated workflow references, preview selection, tests, dispatch docs and trace collectors; kept lock keys shared with cleanup and older branches.*
