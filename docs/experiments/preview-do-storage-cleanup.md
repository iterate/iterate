# Preview storage cleanup experiment

Status: running. The first live sweep missed new objects, so the current
REST-inventory approach is not safe to adopt. PR #2693 keeps the Worker
code deployed and replaces the slot's class-retirement cleanup with per-object
`deleteAll()`, `sync()` and abort. Only this PR enables it.

The question is whether old test compute stops cheaply **and** new tests can use
the same deployment. Completely deleting inert data is a separate question.

## What is being tested

- Inventory the OS and streams-example namespaces through Cloudflare REST.
- Stop disposable containers, then wipe scheduler/stateful/domain objects and
  finally streams. Delete known hosted facets before their parent is wiped.
- Fail on an incomplete sweep. Save each object result and the deployment IDs.
- Inspect the inventory again without calling the objects. Observe native
  invocations and billed duration through GraphQL after ingestion settles.
- Create fresh work against the same deployment, then clean that up too.
- Push during prepare, tests and cleanup to exercise the existing cancellation
  and next-run recovery behavior.

## Evidence so far

| Case                                                             | Result                                                                                                          | What it establishes                                                                                                                                                             |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original cleanup, run `v11zj80d0s`, task-only commit `1367f9dad` | Full erase 69.0s; command wrapper 71.2s                                                                         | Baseline cleanup latency; nine OS classes and the streams class retired                                                                                                         |
| Baseline tests                                                   | Six browser shards green; app suite red on the existing abandoned-project expected-failure test's setup timeout | The baseline is not a clean whole-suite comparison                                                                                                                              |
| Baseline post-erase inventory                                    | Six sandbox namespaces remain; 242 SandboxLite and 161 SandboxBasic objects still report stored data            | Full erase already retains some inert container-host storage                                                                                                                    |
| Real workerd/Miniflare probes                                    | Six pass                                                                                                        | SQL/KV/alarm/memory wipe, cold inventory-ID lookup, version mismatch rejection, in-flight request abort, known facet storage deletion, running-alarm reset and later recreation |
| Whole repository checks                                          | Typecheck, tests, lint, knip, formatting pass                                                                   | No detected local regression before the first live run                                                                                                                          |
| First storage run `5fj6v8h8hk`, commit `5a6ce661d`               | OS deploy blocked: SHA-pinned packages were unpublished while the PR conflicted with main                       | Not evidence about storage cleanup; fixed by merging main                                                                                                                       |
| Normal run `t1vb9scrlp`, commit `98f89966e`                      | All test consumers passed; 403/403 attempted resets passed in 61.6s (65.1s wrapper)                             | Same deployment survived the sweep, but discovery omitted new objects                                                                                                           |

## First live finding: discovery misses active objects

The normal run deployed OS version `2c6c84e7-f30a-4c69-955a-11233c932ef9`.
The native Worker tail observed a successful Stream append at 22:40:11 UTC.
The REST object inventory still omitted it at 22:42:29. Re-reading namespace
IDs confirmed we were querying the current namespaces.

Across the tests, the tail observed at least 1,045 distinct non-container DOs:
872 Streams, 85 Projects, 28 Repos, 24 Secrets, seven Schedulers, 24 build
coordinators, one Device, three Workspaces and one StatefulWorker. None were
in the cleanup inventory. Tail sampling means this is a lower bound.

The sweep ran from 22:42:47.958 to 22:43:49.532 UTC and reset only the 403
historic sandbox objects. The next REST inventory, around 22:44:06, finally
listed 224 non-container objects with stored data. Cloudflare's discovery
index is delayed enough to miss objects created and used within an entire
short test run. A successful per-object reset cannot compensate for an
incomplete inventory.

The same delayed index also still marked wiped sandbox objects as having
stored data. That flag alone therefore cannot prove either failed deletion
or current activity. Native invocations and delayed GraphQL activity are the
separate checks below.

## Reuse probe

At 22:47:24 UTC, a new project created after cleanup successfully executed a
five-second recurring schedule and appended a heartbeat event. The Worker
version remained `2c6c84e7-f30a-4c69-955a-11233c932ef9`, unchanged since the
normal test deployment. This is stronger than a health check: fresh product
work can run without redeployment.

`scripts/preview/cleanup-probe.ts seed-heartbeat` creates this controlled work.
It intentionally releases client handles without cancelling the schedule, so
cleanup has actual recurring work to stop. The active scheduler was then
reset directly by its known ID at 22:48:40, and its source stream at 22:49:46.
Before reset, the native trace recorded 14 successful scheduler alarms and
41 source-stream alarms. After the scheduler reset, it recorded one cancelled
scheduler alarm and one remaining stream alarm. After both resets there were
no observed invocations on either ID for 124 seconds, while unrelated trace
traffic continued. Delayed GraphQL checks are still pending.

This supports wiping a known dependency set. It does not establish complete
project cleanup or make an incomplete inventory safe.

## Discovery and cancellation timeline

| Time (UTC) | Observation                                                                                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 22:42:29   | REST still lists only the 403 old sandbox objects, while the new test objects are actively used.                                                                       |
| 22:43:49   | Normal cleanup succeeds after resetting those 403 objects.                                                                                                             |
| 22:44:25   | REST now lists 224 non-container objects missed by the sweep.                                                                                                          |
| 22:46:51   | REST lists 2,400 objects, including 1,997 non-container objects.                                                                                                       |
| 22:52:43   | The next prepare job inventories 6,329 objects in the same namespaces.                                                                                                 |
| 22:53:06   | Push `e474dafb8` interrupts that active pre-deploy wipe (run `340pfs6rxw`, workflow `ddx7qrf5pn`). All old jobs cancel; no complete per-object result file is written. |
| 22:54:27   | Replacement run `7zzc4tr2fv`, workflow `8jp447qqgm`, inventories 6,339 objects and begins recovery.                                                                    |

No complete existing registry can replace REST discovery cheaply. The
project directory is a capped KV listing and omits some impersonated test
projects. Stream lists are asynchronous projections. Stateful-worker keys,
build hashes and global stream paths have no exhaustive list. Building an
accurate run-owned registry would be a separate architecture change.

During the untouched 22:43:50–22:46:50 observation window, the native trace
recorded 80 invocations on six IDs, including 37 alarms. Stream alarms
continued through 22:46:44. These are active leftovers, not just retained bytes.

## Limits to investigate

**A successful reset is not permanent retirement.** A late named request can
recreate an object. More subtly, waking a cold Stream for cleanup can append
child announcements to ancestors that were already wiped. Ten concurrent
resets and one initial inventory do not establish that no state remains.

**Deleting a name has consequences.** Cloudflare's inventory supplies opaque
IDs, not the names used by our constructors. The experiment persists the name
so a cold ID-addressed object can initialize. Wiping removes it again. An
ID-only retry or delayed native alarm may then fail during construction before
its handler gets to see that pending work is absent. The local alarm probe
reads by name afterward, so it does not prove a truly untouched orphan stays
quiet; native telemetry must address that.

**Facet coverage is partial.** We delete facets from current stream
subscriptions and the stateful worker's `target`. Removed or relocated
subscriptions may leave old facet storage that the current catalog cannot
list. Retained inert storage alone would not invalidate the cost result, but
we must not describe it as a complete storage wipe.

**Container callbacks can arrive later.** Stopping a container can append
lifecycle events to streams. The sweep orders containers first, but delayed
callbacks require observation after the sweep, too.

**Auth and artifact data remain.** This experiment retains Auth D1/KV, artifact
repositories and the application configuration. It therefore needs eventual
garbage collection and a separate slot-handover policy before general use.

## Reading the metrics

`cleanup-metrics.ts snapshot` saves namespace identity. `inventory` lists
objects over REST without waking them. `capture` records raw per-object native
invocations and periodic activity for an explicit UTC window.

- `activeTime` is microseconds; DO-hours = sum / 3,600,000,000.
- `duration` is already GB-seconds. Do not multiply by memory again.
- Returned sums already account for sampling. Do not multiply by sampleInterval.
- Invocation wall times can overlap; summing them is not billed duration.
- Periodic groups can contain multiple records for one object ID and minute.
  For example, one Stream group contains six records totalling 360 active
  seconds. Facets inherit the parent ID and may explain this aggregation, but
  the public docs do not establish invoice-level interpretation. Report raw
  returned GB-seconds and active-time equivalents; do not infer physical
  concurrency or a dollar saving from these rows.
- Reporting periods can cross experiment boundaries. A narrow query's totals
  are not necessarily all incremental activity after cleanup.
- Query a finished window again after 30–60 minutes. Empty recent data does not
  prove quietness.
- Retiring a namespace removes historical analytics. In this baseline only
  retained sandbox rows arrived before the other namespaces disappeared:
  0.027298755 observed DO-hours / 12.579266304 GB-seconds. That is **not** a
  complete baseline and must not be extrapolated to the whole fleet.

Raw local evidence: `/tmp/preview-do-storage-experiment/`. The final report
will retain concise measured results and CI links rather than depend on those
temporary files for its conclusions.

The branch subsequently merged `a9f5eddef6` from main. This includes #2680,
which defers artifact deletion during normal preview runs. The original 69s
baseline therefore includes work current main no longer does; it is not a
controlled comparison for the final branch.

Primary references: [storage deletion](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#deleteall),
[alarm behavior](https://developers.cloudflare.com/durable-objects/api/alarms/),
[object inventory](https://developers.cloudflare.com/api/resources/durable_objects/subresources/namespaces/subresources/objects/),
[facet identity](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/),
and [metrics and ingestion](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/).
