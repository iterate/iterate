# Preview storage cleanup experiment

Status: running. No adoption recommendation yet. PR #2693 keeps the Worker
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
| First storage run `5fj6v8h8hk`, commit `5a6ce661d`               | In progress                                                                                                     | First pre-deploy cleanup bootstraps the parked worker; final cleanup is the experiment                                                                                          |

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
- Query a finished window again after 30–60 minutes. Empty recent data does not
  prove quietness.
- Retiring a namespace removes historical analytics. In this baseline only
  retained sandbox rows arrived before the other namespaces disappeared:
  0.027298755 observed DO-hours / 12.579266304 GB-seconds. That is **not** a
  complete baseline and must not be extrapolated to the whole fleet.

Raw local evidence: `/tmp/preview-do-storage-experiment/`. The final report
will retain concise measured results and CI links rather than depend on those
temporary files for its conclusions.
