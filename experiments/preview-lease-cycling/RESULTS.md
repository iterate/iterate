# Lease cycling experiment — 2026-09-18

**The live handoff worked. Full deletion was costly and failed once; it is not the default I would choose yet. No production wait or lease policy changed.**

Both the aged parked slot and the longer-rest fully deleted slot passed their first zero-gate agent runs and subsequent container execution. This is feasibility evidence, not a measured safe minimum: there is one immediate-use success per preparation method, and the first full-recreation attempt failed before reaching smoke. I would next test rotation with normal erasure plus parked rest, retaining the container apps and asset cache.

Source: merged main `97ffd6fd65` (#2712). Real preview account, real Semaphore,
real six-app fleet, local deployment scripts and unretried agent smoke. All
requests originated from this machine, mostly through LHR. Each deployment
creates new Worker versions; these are repeated deployments of the same product
revision, not different product commits. No PR or GitHub CI run was created.

## Measurements

| Trial                       | Preparation and postdeploy gate                                                                                                | Outcome                                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control, preview-15         | Normal entry erase; 90s after OS deployment command completed                                                                  | Agent smoke passed in 29.344s; a separate later measurement passed in 22.730s.                                                                                          |
| Full deletion 1, preview-10 | Park, 150s, remove container apps/classes and eight Workers, 150s, verify/release/reclaim; additional 150s absence observation | Fleet recreation failed before smoke: first OS container application creation returned HTTP 500. No zero-wait result.                                                   |
| Aged parked, preview-17     | Normal erase, at least 150s parked, retain container apps/assets; 0s deliberate gate                                           | First agent smoke passed in 30.055s. Test process started at OS deployment age 1.454s. Separate sandbox create/exec/destroy passed in 22.797s.                          |
| Full deletion 2, preview-10 | 15m09s absent before deployment began; 0s deliberate gate                                                                      | Fleet recreated successfully. First agent smoke passed in 29.812s; process started at OS deployment age 2.720s. Separate sandbox create/exec/destroy passed in 19.620s. |

Durations above are whole smoke subprocesses. “0s” means no deliberate sleep:
health checks, process startup and the test's authentication still take time.
The deployment scripts themselves also perform readiness polling before returning. The full-recreation success saw two public-dashboard HTTP 522 responses before that polling passed. This measurement does not bypass those checks.

The version header pins the six app versions as normal CI does; the public
health watcher does not pin versions. Neither proves worldwide propagation.

The control's six serial deployment subprocesses took 333.160s, plus entry erase
and the 90s gate. This is a local comparison, not a forecast of parallel CI time.
Full deletion lost asset caches: Docs uploaded 463 files (38.91s) and OS uploaded
669 (63.46s). Its six deployment subprocesses took 429.587s before failure.
The parked comparison took 344.538s across the six deployment subprocesses. Full deletion 2 took 485.277s. Including just these subprocesses, the deliberate gate and agent smoke gives:

| Measurement                |  Control | Aged parked | Full deletion 2 |
| -------------------------- | -------: | ----------: | --------------: |
| Six serial deploy commands | 333.160s |    344.538s |        485.277s |
| Deliberate postdeploy gate |      90s |          0s |              0s |
| First agent smoke command  |  29.344s |     30.055s |         29.812s |
| Sum                        | 452.504s |    374.593s |        515.089s |

These sums exclude lease acquisition, earlier erase/cooling, small orchestration gaps and the extra container probes. The control also did 45.353s of entry erasure; the other two used prepared slots. Even excluding preparation from the new deployment's critical path, full deletion did not beat this control. Local network/upload variance and serial deployment prevent treating these as expected CI savings.

The parked comparison retained all six container applications. Its initial inspection showed seven zone routes, 15 OS namespaces, six container applications and zero error-level events in the postdeploy query. The container probe began at OS age 54.393s; it is functional evidence, not another immediate-use trial. A later error-level query remained empty; a separate all-level query for the code-update-reset message returned zero matches through 20:08:24 UTC. These are observed log queries, not proof that every request worldwide was reset-free.

## Observed failures

Full deletion 1 removed the Workers at 19:31:26.828 UTC. Container application
creation failed at 19:46:54 UTC: about 15.5 minutes later, including the absence
checks and fleet deployment. It was not a request only 150 seconds after deletion.
The next attempt began 15m09s after its own deletion and successfully recreated all six container applications. It does not establish whether cooling or a transient service failure explains the difference.

The first attempt's actual API response was HTTP 500, “can't create application at this time”,
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

Full deletion 2 restored seven zone routes, 15 OS namespaces and six container applications. Its initial postdeploy error-level and reset-message queries returned zero events. The later container probe started at OS age 45.734s and passed; it was not an immediate container-start test.

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

Preview-15 retirement released its lease at 20:07:43.508 UTC, 388.200s after the cleanup launch. The previous preview had 252 sampled health responses, all HTTP 200, before handoff. Preview-17 retained its completed agent stream without version pins while slot 15 retired.

The next handoff, from preview-17 to the fully recreated preview-10, also completed before old-slot cleanup. All 146 preview-17 health samples before that handoff returned HTTP 200.

Slots remain occupied throughout both cooling periods. Three slots were held at
the peak of these comparisons; ordinary replacement plus one retirement needs
two, but rapid commits can accumulate additional retiring slots.

Raw evidence is deliberately ignored: `evidence.ignoreme/sept18/events.jsonl`,
per-command logs, version/route/namespace/container inspections and trace queries.
No generated output or lease tokens are committed.

## What I would carry forward

- Keep the old published preview until the replacement is usable; look it up by PR/deployment identity, not the Git parent. Preserve it when the pool is full or a candidate fails.
- Keep the old lease continuously during cleanup. The measured retirement took minutes but did not delay the replacement result.
- The service already sorts available resources by last release. A trustworthy cleanup receipt is the missing distinction between an old slot and a known-clean old slot; this branch uses local receipts, not a service rollout.
- Prefer testing parked-and-aged slots next. Full deletion added uploads, route recreation and container application creation without a demonstrated smoke benefit over parking.
- Keep the production 90s gate for now. There was no useful basis to estimate a 15s threshold from these samples, so that optional arm was not run. Repeated immediate-use trials and the post-test restore transition remain necessary before adoption.

## Final disposition

At 20:22:02 UTC, an independent Cloudflare/Semaphore audit found preview-10, preview-15 and preview-17 available with null holders, zero matching Workers, zero associated DO namespaces and zero container applications. The registry had no current preview and no pending cleanup. DNS, D1 schemas and KV/R2 infrastructure remain, as intended. No leases or live experiment fleets were left behind.

Validation: 14 lifecycle/receipt tests, 39 existing planner/settlement/CI tests, focused TypeScript and lint passed. Root worktree unchanged; all work is on `codex/experiment-preview-lease-cycling`, with no PR.
