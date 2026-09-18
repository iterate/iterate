# Experiment results: unique Workers, stable preview hostname

2026-09-18. **Experiment only; do not remove the 90-second CI gate on this evidence.**

A unique Worker name does not make the slot's existing hostname switch atomically.
One successful response from the new Worker **and its DO** was followed by writes
to the previous Worker. Keeping the previous Worker live let those writes complete
on the wrong build. Parking it instead interrupted some of them with the same
code-update reset this experiment was trying to avoid.

## Measurements

Ten leased cases produced 24 measured rounds and 288 unretried operations.
Each measured round first deploys a
new script/namespace, switches the actual slot OS route where applicable, waits
for one exact-version Worker+DO response, then sends twelve unretried 15-second
operations to distinct new object names. Final state is checked through the new
Worker's own hostname. All 287 received operation rays are from LHR; one request timed out.

| Run        | Policy                                | Extra delay after readiness | Results                                                                                                                                       |
| ---------- | ------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `630048db` | Direct new workers.dev hostname       | 0s                          | First round 12/12 completed; second 5/12 completed, 7 Cloudflare 404s.                                                                        |
| `ba471684` | Stable hostname, keep old Worker live | 0s                          | No measured writes: 30 readiness reads still reached the previous Worker, exhausting the original ~15s polling cap.                           |
| `d3cc6376` | Stable hostname, park old Worker      | 0s                          | 8/12 completed; two old-Worker code-update resets, one edge “Script not found” 500, one new-Worker internal error.                            |
| `4a796596` | Stable hostname, keep old Worker live | 0s                          | Across three rounds: 17/36 completed on the right build, 18 completed on the wrong build, one new-Worker internal error.                      |
| `f9892584` | Stable hostname, park old Worker      | 0s                          | Across three rounds: 29/36 completed; seven failures detailed below.                                                                          |
| `30a71334` | Direct new workers.dev hostname       | 15s                         | 36/36 completed across three rounds; writes began 16.078–31.226s after Wrangler finished.                                                     |
| `b6980e0f` | Stable hostname, keep old Worker live | 15s                         | 35/36 completed. A new DO became inactive during the third round; its record remained started at progress 38.                                 |
| `1d10ee98` | Stable hostname, park old Worker      | 15s                         | 36/36 completed; writes began 16.634–18.966s after route acknowledgment.                                                                      |
| `6e125e68` | Stable hostname, park old Worker      | 30s                         | 35/36 completed; new-DO inactive-instance reset, record still started at progress 59. Writes began 31.360–33.841s after route acknowledgment. |
| `ac7b8f3b` | Stable hostname, keep old Worker live | 90s                         | 35/36 completed; same inactive-instance failure, record still started at progress 34. Writes began 91.084–91.352s after route acknowledgment. |

The seven failures in `f9892584` were: one inactive-instance reset on the new
Worker, two new-Worker internal errors, one namespace-deleted error and one
code-update reset on the previous Worker, one edge script-not-found 500, and one
35-second client timeout. The timed-out operation's final record was completed;
that is an ambiguous response, distinct from the interrupted record below. No
failure is counted as success based on a later read.

The first matrix used hard assertions and stopped a case at its first failed
round. Later runs use soft operation assertions to collect all requested rounds.
After `ba471684`, the read-observation budget was increased to 90 seconds to
measure convergence beyond the initial sampling cap. It returns immediately on a
match; this is not a 90-second settling delay. Writes still never retry.

## A concrete failing handoff

Run `d3cc6376`, preview-7, first handoff:

1. Cloudflare acknowledged the route change to `os-preview-7-exp-d3cc6376-after-1`.
2. **1.679s later**, a read returned both the new Worker and DO version
   `201bd16b-4622-4f12-ac3c-738e24173542`.
3. Writes started **1–2ms after that successful read**. Two reached the previous
   Worker version `d3d911f6-026a-4048-9cd7-36f6dfc4cc4f`.
4. Those two returned `Durable Object reset because its code was updated.` while
   the previous Worker was being parked. Their records in the **new** namespace
   were null: a later good response did not rescue or conceal the failed calls.

Worker Logs independently identify the previous script/version for both resets:

- Ray `a3d1eb95ac0bcc1d`, trace `07015f51c9d6ccea95b4de71d702f43b`.
- Ray `a3d1eb959e7e385a`, trace `0545e46b1a3d9641def663a8e33aeffa`.

The internal error on the new Worker has ray `a3d1eb95ae317791`, trace
`21bc49634fde3791f23bfb9d9bc56f92`, reference `lk3f2sellvi86cdtf1u9la45`.
It is an additional unexplained platform failure, **not** evidence of a code-update
reset in the new namespace. The HTML script-not-found response and direct-host
404s are also separate from DO reset errors. Expected cleanup 503s are recorded
but are not counted as failed measured operations.

## A reset inside a fresh namespace

Run `f9892584`, round 1, also exposes a failure that stale routing does not explain.
The failing write identifies the new `after-1` Worker version
`13183af4-ec1d-4a6f-8094-e49bb067cdef`. That Worker had received one live `wrangler deploy`;
only the separate `before` Worker was being parked at this point.

Its response was `Connection closed: this Durable Object instance is no longer
active. Reconnect or retry the request.`, with `durableObjectReset: true`.
After eight timed-out state reads, a read returned the same version but a new
object boot ID. The persisted record was still **started, progress 6**, with the
previous boot ID. This is interrupted work, not merely an unsuccessful response
to work that nevertheless completed. Ray: `a3d1f2ffabea29c7`; Worker Logs trace:
`291bc57becfcbc30ae366333b9b68d25`.

The same failure recurred in `b6980e0f` round 3 **without any concurrent retirement**.
Work began 19.027 seconds after route acknowledgment (including 15 seconds after
readiness); about 10.5 seconds later it returned the inactive-instance error.
The new Worker version was unchanged, its DO boot ID changed, and the record
remained started at progress 38. Ray: `a3d1ff1ce8eced01`; trace:
`6e14f095a7974b522849280f359d009f`.

A third occurrence followed the 30-second delay in `6e125e68` round 3. The
operation began 33.452 seconds after route acknowledgment and ran for about
15.4 seconds before failing. Its record remained started at progress 59, with an
old boot ID under the unchanged new version. Ray: `a3d20a1dfc1cbb05`; trace:
`ee67c7dbffa83925aebd2000ffa1763b`.

The 90-second control `ac7b8f3b` also failed in round 3. Work started **91.165s
after route acknowledgment**, then failed about 9.2s into the operation. No old
Worker was being retired. The new version was unchanged and the record remained
started at progress 34 under the previous boot ID. Ray: `a3d2156d2d585e45`; trace:
`7b7c9bc731f41d5504fdad64600d0e9e`. A long deployment-age delay did not prevent it.

The 15-, 30- and 90-second occurrences were all in the third round; the 0-second
occurrence was in the first. Round order/workload and platform causes have not
been isolated, so the counts alone cannot establish a deployment-age effect.

The platform's internal reason for replacing those instances is unknown. The evidence
does not justify calling it a code-update reset, but it does rule out “fresh name
plus one readiness read means the operation cannot reset.” Cloudflare documents
that object replacement can also follow platform updates or network partitions;
that is context, not a diagnosis of this occurrence. See
[known issues](https://developers.cloudflare.com/durable-objects/platform/known-issues/).

## Why this is not yet an OS deployment result

The current name is `os-preview-N` in [envs.ts](../../envs.ts). Simply suffixing
that name changes more than a script identifier:

| Existing code                                                                    | Consequence of a per-run name                                                                                                                                                       |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [generate-wrangler-config.ts](../../apps/os/scripts/generate-wrangler-config.ts) | Changes self identity, Artifacts namespace, R2 bucket names, typechecker/bundler services and container application identities. Public routes are derived separately from the slot. |
| [deploy.ts](../../apps/os/scripts/deploy.ts)                                     | Ensures the new files bucket and bootstraps container classes before the application upload. A bootstrap forces a full container rollout.                                           |
| [ensureContainerClasses](../../scripts/lib/do-reset.ts)                          | Initially uploads a parked Worker with stub container classes, then the application deployment replaces it. A new OS name therefore still has an old→new code transition.           |
| [preview.ts](../../scripts/preview/preview.ts)                                   | Owns the existing 90,000ms minimum deployment age; this experiment does not change it.                                                                                              |

This branch exercises real Cloudflare routes, namespaces, durable state and logs,
but uses an embedded workload, not representative OS commits or agent-smoke CI.
The workload deliberately has no recovery after a reset, making interrupted work
visible in storage. OS may have different recovery and access patterns; these
operation failure counts are not an estimate of agent-smoke's failure rate.
The immediate stable-host failure is already present in this smaller case. Full
OS adoption needs to address that handoff plus bootstrap, sidecars, storage,
container capacity and retirement; the routing results cannot prove those safe.
Under the repository's no-Worker-deletion policy, a truly unique name per commit
also means an ever-growing set of parked Workers, rather than a fixed slot pool.

## Evidence and cleanup

Raw deploy output, timestamps, requests, final state and telemetry are local under
`evidence.ignoreme/<run-id>/evidence.json`; nothing generated is in Git. The
read-only `evidence.ignoreme/cleanup-audit.json` records an additional check of
original route owners, parked responses and absence of experimental namespaces.

All ten cases restored their original routes (or never changed them), parked
all **35 experimental Workers**, retired their namespaces and released their
leases. The final independent audit confirmed all 35 parked responses, zero
remaining experimental namespaces and all ten original route owners. A separate
Semaphore read confirmed none of this experiment's holders still owns a lease
(`evidence.ignoreme/lease-audit.json`). Workers are retained parked, never deleted.

A live namespace snapshot during the 90-second control also confirmed four
distinct namespace IDs for its four Worker names. Worker Logs queries succeeded
for every experimental Worker; the request/trace examples above match the client
responses and stored records.

Targeted TypeScript, oxlint and formatting checks pass. Without the explicit opt-in,
Vitest discovers three skipped cases and touches no cloud resources. The ten live
cases finished with two passes and eight failures, including the one readiness
budget exhaustion. These are measurement results, not green adoption tests.

## Recommendation and limits

Reject the proposed **immediate** unique-Worker handoff as a replacement for the
90-second gate. Fresh names remove namespace reuse, but do not make either
hostname propagation or first-use work reliably succeed after one readiness read.
All sampled operations used the intended build after the 15-, 30- and 90-second
windows, but each timing group still contained an inactive-instance failure.
Those failures also occurred in the 90-second control, so they cannot justify
claiming a longer wait fixes them—or that the existing OS gate is unnecessary.
No reliable sweet spot has been established.

This is a small sequential study from one client/edge region. Operations within a
round share a deployment; their outcomes are not independent reliability trials.
A passing timing group would be a candidate for further work, not proof of a safe
minimum. Platform reasons for the inactive-instance and opaque internal errors
remain unresolved. No representative OS rollout, main-CI timing comparison or
production adoption is claimed.

The lease-tags/rested-slot idea remains a separate experiment. Test the actual
long-parked-slot lifecycle before using a tag to skip a wait: a cleanup timestamp
alone does not establish readiness of the next application upload.
