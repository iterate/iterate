# Lease cycling experiment — 2026-09-18

**Measurements in progress. No production wait or lease policy changed.**

Source: merged main `97ffd6fd65` (#2712). Real preview account, real Semaphore,
real six-app fleet, local deployment scripts and unretried agent smoke. All
requests originated from this machine, mostly through LHR. Each deployment
creates new Worker versions; these are repeated deployments of the same product
revision, not different product commits. No PR or GitHub CI run was created.

## Measurements

| Trial                       | Preparation and postdeploy gate                                                                                                | Outcome                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Control, preview-15         | Normal entry erase; 90s after OS deployment command completed                                                                  | Agent smoke passed in 29.344s; a separate later measurement passed in 22.730s.                                                                 |
| Full deletion 1, preview-10 | Park, 150s, remove container apps/classes and eight Workers, 150s, verify/release/reclaim; additional 150s absence observation | Fleet recreation failed before smoke: first OS container application creation returned HTTP 500. No zero-wait result.                          |
| Aged parked, preview-17     | Normal erase, at least 150s parked, retain container apps/assets; 0s deliberate gate                                           | First agent smoke passed in 30.055s. Test process started at OS deployment age 1.454s. Separate sandbox create/exec/destroy passed in 22.797s. |
| Full deletion 2, preview-10 | Longer rest after deletion; 0s deliberate gate                                                                                 | Pending.                                                                                                                                       |

Durations above are whole smoke subprocesses. “0s” means no deliberate sleep:
health checks, process startup and the test's authentication still take time.
The version header pins the six app versions as normal CI does; the public
health watcher does not pin versions. Neither proves worldwide propagation.

The control's six serial deployment subprocesses took 333.160s, plus entry erase
and the 90s gate. This is a local comparison, not a forecast of parallel CI time.
Full deletion lost asset caches: Docs uploaded 463 files (38.91s) and OS uploaded
669 (63.46s). Its six deployment subprocesses took 429.587s before failure.
Saving a 90s gate does not necessarily save total time when recreating the fleet.

The parked comparison retained all six container applications. Its initial inspection showed seven zone routes, 15 OS namespaces, six container applications and zero error-level events in the postdeploy query. The container probe began at OS age 54.393s; it is functional evidence, not another immediate-use trial.

## Observed failures

Full deletion 1 removed the Workers at 19:31:26.828 UTC. Container application
creation failed at 19:46:54 UTC: about 15.5 minutes later, including the absence
checks and fleet deployment. It was not a request only 150 seconds after deletion.
The actual API response was HTTP 500, “can't create application at this time”,
for `os-preview-10-sandboxlitedurableobject-preview_10`. The upload and creation
of container DO namespaces had succeeded. Cause remains unknown; the evidence
does not establish a quota, name collision, or a DO code-update reset.

A separate sandbox probe against the unchanged control failed in **Project.create**,
before it reached sandbox creation: a 90s wait for offset 8. Agent smoke passed
before and after that probe. See
[the captured follow-up](../../tasks/project-create-offset-eight-timeout.md).
This failure is retained separately from container-recreation results.

The first harness cleanup receipt was also rejected conservatively: Semaphore
renewals update `lastAcquiredAt`. Receipt validation now compares `lastReleasedAt`
both before and after acquisition, and has regression tests. For that first
claim, the harness verified absence again and observed another 150s under the
new lease. The subsequent release/reclaim accepted the corrected receipt.

## Lifecycle and integration limits

A failed candidate did not replace or park the published preview. During the
first failed recreation, preview-15 retained its version, returned HTTP 200,
and its existing agent stream still contained the completed pong response when
read without version pins. The manual registry records retirement intent with
publication and starts cleanup in an independent process. It is not a durable,
distributed CI scheduler and does not survive machine loss without recovery.

#2712 still requires docs-only inheritance and tests-only reuse without rotation.
The new preview also needs its own post-test erase/restore and exact settled
version provenance: retiring the old slot does not clean test agents from the
replacement. This experiment has not exercised that restoration transition,
GitHub reporting, Depot cancellation, browser tests, or hours-long lease renewal.

The production design therefore still needs a separately published preview,
a candidate lease, durable retirement jobs, ordering, and a pool-capacity policy.
The parked-slot success published preview-17 at 20:01:15 UTC, then queued retirement of preview-15; the replacement command returned while retirement continued. The watcher observed the handoff without a parked response from the old preview.

Slots remain occupied throughout both cooling periods. Three slots were held at
the peak of these comparisons; ordinary replacement plus one retirement needs
two, but rapid commits can accumulate additional retiring slots.

Raw evidence is deliberately ignored: `evidence.ignoreme/sept18/events.jsonl`,
per-command logs, version/route/namespace/container inspections and trace queries.
No generated output or lease tokens are committed.
