# Stream Performance Handoff

Snapshot captured on 2026-07-15 and updated on 2026-07-16 after semantically
integrating `origin/main` through `8a10191f4` into draft PR
[#1902](https://github.com/iterate/iterate/pull/1902). The integrated history
includes the #2002 processor runner/registry redesign, #2038 explicit processor
births, #2040 native trace roots for Stream retry alarms, and #2046's
runtime-neutral inspector UI. The latest exact checkpoint compares branch head
`0e1e94469` with exact current main `8a10191f4`; earlier candidate `b2712ad09`
versus main `7495c6802` isolated the activation checkpoint regression. Commit
`c263535fe` fixes that regression, merge `6d77a8fe5` accepts main's task-document
cleanup, and `d0e92dc38` makes the deployed benchmark wait for repository
readiness. Commit `0e1e94469` removes the recursive project-birth wait and makes
the root capability-host subscription retry-idempotent. Production has not been
deployed, erased, or otherwise changed.

## 2026-07-16 Integration Update

The semantic merge is now implemented. It keeps main's runtime-neutral
`StreamProcessorRunner`, registry, two-cursor progress model, and deletion of
`StreamProcessorHost`; explicit births and target-offset readiness barriers now
operate on runner-owned progress. The compact processor frame contains selected
events plus `scannedAfterOffset`, `scannedThroughOffset`, and
`streamMaxOffset`. Successful frames durably advance through scanned selector
gaps, and an event-less at-head pass preserves reconciliation when no consumed
event can carry the final `caughtUp` signal. The runner still self-pulls for
explicit read-your-writes waits and cold catch-up; it no longer needs a second
pull just to rediscover offsets already scanned by a delivered frame.

The public API remains one `append` method. It defaults to acknowledgement-only
and accepts an optional leading `{ return: "events" | "offsets" }` projection.
Internal processor appends request offsets because birth and readiness barriers
need them. Cap'n Web's remote proxy projection collapses TypeScript overloads
to the final signature and cannot preserve a conditional generic selected by
that option, so the RPC contract intentionally exposes one union result and
callers narrow an explicitly requested projection with shared helpers. No
public `appendAck` compatibility verb was reintroduced.

The exact detached candidate passes root typecheck, lint, formatting, and the
recursive workspace test matrix. The complete OS unit suite passes 1,979 tests
with one intentional skip across 190 files. Generated OS and package ITX
APIs/examples were regenerated from source. The project-bootstrap correction's
focused suite passes all six tests, including injected partial failure and
retry, and the exact post-merge cumulative checkpoint is recorded below.

### Preview-9 correctness findings

The first deployed run of merged head `0128ebe73` was not a shipping pass. It
exposed two independent correctness defects that local fresh-process tests had
not exercised:

- Fresh schema creation used several synchronous DDL statements without an
  explicit transaction. An interrupted first activation could therefore leave
  an unversioned partial `events` table. Every later activation retried
  `create table events`, failed with
  `SQLITE_ERROR: table events already exists`, and permanently wedged that
  Stream. Preview telemetry recorded 124
  such errors and one 60-second append invocation. Schema creation now runs in
  `transactionSync`; an absent schema marker identifies a fresh/interrupted
  bootstrap whose partial Stream-owned tables are replaced, while any SQL
  failure after a marker exists is rethrown as corruption rather than hidden.
- The compact acknowledgement/offset append optimization had retained only an
  idempotency hit's offset and accidentally removed the logical-event identity
  comparison. A conflicting payload with the same key was silently accepted as
  a retry. Compact appends still make the cheap indexed offset probe on the
  common miss, but an actual hit now hydrates the envelope and compares type,
  payload, metadata, and ephemerality before deduplicating. Same-batch hits keep
  the already-constructed envelope in memory. Provenance remains intentionally
  excluded, preserving processor retries across deployment stamps.

Raw deployed Cap'n Web frames showed that acknowledgement-only append resolves
normally as its explicit undefined wire value. The test's misleading
`'' is not a function` arose only after the server wrongly resolved a call the
test expected to reject; it is not evidence for a separate void-return
transport bug. The expanded deployed test covers same-batch and persisted
retries in acknowledgement, offset, and event projection modes.

The fixes pass OS and playground TypeScript, focused lint, and all 544 current
Stream-domain tests locally. Preview-9 deployed exact fix commit `04479c168` as
Streams Worker version `aafec577-96fc-42d3-b2f8-5e6028463989`. The deployed
Streams suite passed 20 tests with one intentional expected failure; its browser
lane passed 30 with one intentional skip. The all-projection/idempotency proof
passed in 1.657 seconds. The only retry was the explicit 32 MiB WebSocket frame
ceiling, which then passed.

Cloudflare telemetry for the deployed window contained no recurrence of
`table events already exists`. The remaining Stream error rows were all
induced by explicit negative tests: two representations of each oversized
frame attempt plus deliberate `kill`, `reset`, invalid-subscription, and
idempotency-conflict RPC exceptions. The OS preview job's final failure was a
separate test-contract defect: a dynamically mounted append capability
destructured the new acknowledgement-only default. It now requests
`{ return: "events" }`; the deployed targeted rerun passes 3/3. The earlier
Project Worker cross-post retry also passed cleanly when rerun against the same
deployment.

The corrected branch then passed its complete preview workflow, including 40
OS E2E files and 151 passing tests. Exact OS Worker version
`76b793ca-efa8-4673-8d50-17fe6b09d0b5` again had no schema-bootstrap
collision. The broader audit did expose a separate release blocker: 3,248
error-level `ItxEntrypoint.get` RPC invocations during the preview window,
3,225 while E2E was active. A later exact deployed A/B proved that removing
`async` from `get()` does not help: the synchronous version produced 51
exceptions among 58 calls and the restored asynchronous control produced 68
among 82, while both five-test capability suites passed. Workerd source at
commit `f71dab4d2` explains the result: both return shapes pass through
`js.toPromise()`, and serializing the `RpcTarget` extends a forwarded JS-RPC
session. Last-local-capability release can cancel the remote session through
the forwarding membrane and surface as `EXCEPTION`. The relevant boundary is
the returned capability, not promise adoption. Do not call the deployment
telemetry-clean until a bounded operation returning plain data, a non-JS-RPC
path, or an upstream protocol fix removes this false terminal error without
weakening explicit disposal. Two additional browser `GET /api` rows were
explicitly reported by Cloudflare as `outcome: canceled` with `Network
connection lost`; they coincide with WebSocket E2E activity and remain
separately classified from Stream RPC.

### Latest preview bootstrap result

The next draft-PR preview attempt timed out its OS test job after 240.2 seconds.
The sequential onboarding smoke was stuck inside project creation. Trace
`80e4f1c6272412416c38d76f1ccba27a` showed `ProjectCollection.create` still open
after 238.5 seconds following a code-update reset during email-router birth.
The merged explicit-birth path had created a recursive RPC lineage:
`ProjectProcessor` waited for four sibling processors whose delivery and search
indexing could re-enter the same Project Durable Object.

The correction preserves the durable sibling appends but removes sibling
processor completion from project birth. Each public processor facade performs
read-through catch-up at point of use. A new partial-failure test also exposed
and fixed a missing idempotency key on the root capability-host subscription;
replay now leaves all four sibling batches duplicate-free. The focused six-test
processor suite passes. The deployed admin fixture requests
`waitUntilReady: false` and immediately snapshots all four read-through facades;
the onboarding smoke logs before the create call so this class of wedge is
visible.

The runtime from exact source commit `0e1e944699ecfec83a3ed9f73e36389a7934bfea`
was then deployed directly to leased `preview_9` as Worker version
`2d8df9ad-3da3-4318-941d-62d3d2e257e9`; production remained untouched. The
focused deployed onboarding boundary passed once in 14.10 seconds with no
retry. A seven-file deployed Stream matrix then passed 37 tests with one
intentional skip and no retries in 336.38 seconds. It exercised replay, live,
state-only and ephemeral subscriptions, unsubscribe, cross-posting, teardown,
wakeup, recovery, malformed subscribers, ancestor repair, and Cap'n Web
callback replacement. The live callback benchmark used the Node host around
completed network work, not a Worker-local clock, and measured p50 238.2 ms and
p95 498.4 ms across 20 samples. This is an acceptance observation, not a
current-main comparison.

The bootstrap timeout is therefore closed functionally: exact-version telemetry
for both deployed windows contained zero `timeout`, `timed out`, `deadlock`, or
`recursive` matches and every application `itx.*` span in the focused flow had
`itx.outcome=ok`. The preview is not telemetry-clean. The focused flow still
produced 11 native `ItxEntrypoint.get` exceptions, five cancellations, and 14 R2
missing-key HEAD error spans. Across the full Stream matrix there were 357 of
the known capability-returning `ItxEntrypoint.get` exceptions, 341 R2 HEAD miss
error spans, and 49 canceled native spans. Deliberate negative tests explain the
remaining Stream exceptions, but search-sync warnings, unknown `slackBotToken`
configuration warnings, and `max_instances_reached` warnings also remain.
Shipping stays blocked until successful capability returns and expected R2
probes stop surfacing as errors and the cancellations and warnings are either
removed or explicitly modelled outside error telemetry.

### Exact current-main checkpoint

Two immutable local Worker stacks compared exact branch head
`0e1e944699ecfec83a3ed9f73e36389a7934bfea` with freshly fetched exact main
`8a10191f4d50055f263d61b6acd5c81d4da7013d`. Five alternating fresh processes
per revision ran each of the complete suite, enlarged append/reactivation,
live delivery, enlarged cross-post, and storage/reactivation lanes. All 50
processes and 35,750 host-timed observations passed identity, cardinality,
finiteness, and semantic validation without a measurement retry.

| Equal-workload aggregate  | p50 improvement | p95 improvement | Mean improvement |
| ------------------------- | --------------: | --------------: | ---------------: |
| Unmodified full suite     |     **30.871%** |     **19.578%** |      **28.221%** |
| Conservative substitution |     **30.718%** |     **29.691%** |      **30.566%** |

The conservative row replaces low-count full-suite singleton append,
100-event append, concurrent append, and one/25-subscriber rows with their
larger focused controls. It is an equal-workload geometric summary, not a
production-traffic weighting. Checkpoints 16 and 17 reported conservative
p50/p95/mean improvements of 30.568%/27.018%/31.619% and
29.651%/27.002%/30.356%. All three establish the same roughly 30% central
result; their lane spread is the more useful warning about local-run tail
variance.

The larger controls retain the useful wins: p50 improved 65.56% for
acknowledgement-only 1 KiB append, 30.01% for 100 tiny events, 34.47% for 100 x
1 KiB, 42.26% for 1,000 tiny, 37.51% for 32 concurrent singleton calls, 50.98%
for one live subscriber, 7.11% for 25 live subscribers, 50.05% for one inline
768 KiB event, and 56.27% for sparse read after reactivation. Throughput
improved 42.88%, 52.60%, 73.20%, 60.02%, and 7.66% in the corresponding
batch/concurrent/fanout lanes.

The result is not uniform. Low-sample full-suite 100-event append and
25-subscriber p95 regressed 101.90% and 110.65%, while their 200/300-sample
focused lanes improved p95 17.55% and 9.44%. The enlarged reactivation lane
improved p50 5.47% but regressed p95 50.72% and mean 1.18%. Replay p95 regressed
9.45% in the full lane and 28.79% in the cross-post lane while p50, mean, and
throughput remained positive. These tails remain visible in the archive rather
than being inferred away from the aggregate.

The checkpoint exposed one activation regression: across five 100-sample
processes, forced-reactivation head p50 was neutral at 0.62% slower but p95 was
66.69% slower (2.735 ms to 4.559 ms). The mechanism was checkpoint lag carried
across abrupt incarnations. Every incarnation appended a `woken` fact, so later
incarnations replayed a growing suffix until the 64-event write threshold.

A clean focused A/B rotated Wrangler state before every process and compared
the exact candidate with flushing caught-up state once per activation. All ten
processes and 3,000 Node-host-timed head assertions passed. Across 1,500
samples per arm, p50 improved 7.45% (1.973 ms to 1.826 ms), p95 improved 5.82%
(2.912 ms to 2.742 ms), and mean improved 4.56% (2.177 ms to 2.078 ms). The
variant won p50 in all five paired rounds. One noisy variant process makes p99
inconclusive, so this supports the bounded lifecycle correction rather than a
deterministic tail claim. The policy is encoded in `CoreCheckpointSchedule`:
constructor catch-up flushes once, while the new incarnation's `woken` fact
starts a fresh warm 64-event/one-second debounce window.

In checkpoint 17, dense post-reactivation read improved 15.16% p50 and 5.55%
p95; sparse read improved 31.91% p50 and 15.31% p95. The 1.1 MiB chunked append
improved 13.50% p50, 16.02% p95, and 10.70% mean.

Checkpoint 18's logs, metadata, validator, and analyses are archived at
`~/stream-performance-evidence-2026-07-16-checkpoint-18.tar.gz` (4.5 MiB),
SHA-256
`788ab90ed9112529096ef33da67a919d2c54e306a53f907f76183909e0a7d251`.
Checkpoint 17 remains archived at
`~/stream-performance-evidence-2026-07-16-checkpoint-17.tar.gz` (4.6 MiB),
SHA-256
`2e4c17b1d1283e9d2daeafb4c178f9abf26009388d1994af546620f6cb1a7eab`.
Its copied analyzer had stale default revisions and a stale log prefix; repairing
those defaults reproduced byte-identical `analysis.json` and `analysis.txt`
before this replacement archive was created.
The earlier checkpoint-16 matrices remain at
`~/stream-performance-evidence-2026-07-16.tar.gz`, SHA-256
`09caee4e742ab454ea2e8e2047c8146c24bbe965963a4790ee2e2ab9c2ba9552`.
The isolated activation A/B is archived at
`~/stream-activation-checkpoint-evidence-2026-07-16-clean.tar.gz` (1.0 MiB),
SHA-256
`9650aca809c12e09152ba5f5dcefb048c4e20106f7d136fd08eabe38fd98fe9b`.

### Parallel redesign findings

Three isolated executable kernels were built from merged baseline `0128ebe73`.
They intentionally omit compatibility and production integration; their local
SQLite/process timings are architectural probes, not deployed performance
claims.

| Kernel               | Implementation | State shape                              |                         Strongest local result |                                                                   Blocking result |
| -------------------- | -------------: | ---------------------------------------- | ---------------------------------------------: | --------------------------------------------------------------------------------: |
| Source-owned minimal |    1,927 lines | 3 state machines, 4 tables               |                   100 tiny append 21.3% faster |                                  singleton 10.8% slower; sparse frame 9.0% slower |
| Receiver credit/pull |    2,425 lines | state split across source + receiver DOs | receiver projection can commit with its cursor | local model 16.9%-23.4% slower; singleton becomes 3 calls/7 writes instead of 1/3 |
| Transactional outbox |    2,427 lines | 2 durable machines, 4 tables             |               sparse scan + claim 55.0% faster |                                   singleton 23.7% slower; sparse read 3.1% slower |

No complete replacement clears the gate. Receiver-owned pull is rejected as
the general delivery protocol because it moves rather than removes durable
coordination and is worst for singleton/trickle traffic. It remains credible
only for a processor that is already a Durable Object and can transactionally
commit projection state with its cursor.

The source-owned and outbox spikes converge on two bounded follow-ups: emit a
typed post-commit delta so control events are parsed once, and combine sparse
frame selection with durable claim construction so the chosen events are not
materialized twice. Both must be implemented as independently revertible
changes in the current kernel and proved in workerd plus deployed
Worker-to-Worker lanes. The existing demand-bound tail, explicit scan
coordinates, singular callback over private frames, and exact output-gated
claim are already the right substrate rather than novel redesign results.

The 60 focused redesign tests pass, and the experiments pass strict TypeScript
and scoped lint. Their 9,923 source/test/doc lines remain untracked so they do
not inflate this shipping PR. A durable archive is at
`~/stream-kernel-redesign-experiments-2026-07-16.tar.gz` (80 KiB), SHA-256
`7ced9e22f851344f471619b8db41496d7ed1485ccdf515de8e982fa63373cf05`.

### Final transport and dispatch experiments

Four final deployed experiments narrow the landing decisions:

- The public singular `processEvent(event)` adapter is neutral against an
  explicit receiver batch loop when both use the same private batched RPC.
  Durable delivery must await a returned callback promise before acknowledging
  the frame; a deliberate discard-promise variant lost durable progress after
  iteration 25 and is rejected. Ephemeral delivery may avoid a promise when
  the callback is synchronous because it has no durable cursor to acknowledge.
- Flattening a generic itx expression into one scoped entrypoint produced
  positive singleton point estimates, but 20 process-cluster samples were not
  decisive. Singleton p50's median improvement was 12.31% with a 95% interval
  from -11.89% to 41.85%; 100-event batch mean regressed 25.41% after a 4.678
  second sample. The implementation adds 148 lines and did not classify the
  `ItxEntrypoint.get` error rows, so it is held outside the shipping branch.
- Actual singular Worker RPC transport is decisively worse. An exact deployed
  six-process-per-arm matrix delivered 25 x 3,840-byte PCM frames in 69.015 ms
  p50 with one batched RPC and 488.241 ms with 25 singular RPCs: singular is
  7.07x slower at p50 and 8.25x at p95. The process-cluster 95% interval for
  batching's p50 gain is 72.04%-88.51%. Singular transport also produced 3,186
  native `jsrpc` spans versus 1,579 and 1,564 dynamic-worker calls versus 408.
- Making `ItxEntrypoint.get()` synchronous is a decisive operational negative.
  It left exception outcomes dominant at 87.9%, versus 82.9% in the restored
  asynchronous control, with both exact deployed capability suites green.
  Workerd normalizes both return shapes through a promise and then serializes
  the same session-owned capability. The experiment was reverted.

The singular-wire experiment also established two correctness boundaries. A
cross-posted acknowledgement deadlocked a reentrant Stream cycle. A cursor
stored in the project Worker entrypoint parked at offset 7 because a stateless
Worker entrypoint is instantiated once per separate RPC request. The final
stateless callback variant was correct but retained the 7.07x PCM cost. The
decision is therefore firm: singular public callback, bounded private batch
wire, ordered durable acknowledgement.

All 12 matrix processes and 1,740 measured events passed, but the exact window
still contained 119 error-level `default.get` rows matching the ITX
entrypoint-session fingerprint. The error count did not scale with singular
event calls, and the follow-up synchronous A/B plus workerd source inspection
attributes the fingerprint to capability-returning forwarded JS-RPC teardown,
not the callback transport or JavaScript promise syntax. It remains
release-blocking because successful disposal is still represented as an error.
Preview 6 was restored to the asynchronous control and its manual lease was
released after collection.

This document is the short, decision-oriented companion to the chronological
[Stream performance ledger](./stream-performance-ledger.md). The ledger is the
source of truth for experiment setup, immutable revisions, raw sample paths,
and rejected hypotheses. The destructive consolidation sequence and its
acceptance gates are in the
[Stream refactor roadmap](./stream-refactor-roadmap.md).

## Executive Summary

The measured merged implementation is a large, real performance win. Its
latest exact-current-main checkpoint used 50 valid fresh Node/Vitest processes
and reported an equal-workload geometric improvement of 30.718% p50, 29.691%
p95, and 30.566% mean under the conservative substitution rule. The
unmodified suite improved 30.871%/19.578%/28.221%; its lower p95 headline is
driven by two low-sample tails whose enlarged controls were positive.
Checkpoints 16 and 17 independently reported roughly the same 30% central
result. These are equal-workload summaries, not production-traffic weighting
or a sum of isolated wins.

The strongest mechanisms are straightforward:

- Keep synchronous SQLite as the journal and do less work around it.
- Do not serialize append results that the caller does not need.
- Reuse committed parsed events for live/replay delivery, but release them
  when no delivery can consume them.
- Select sparse durable frames before materializing payloads or crossing RPC.
- Batch privately across RPC while exposing one public per-event callback.
- Persist exact durable claims/cursors before outbound delivery and recover
  through alarms after eviction or receiver failure.

The result still collapses operationally to one Stream Durable Object, one
SQLite database, and ordinary Workers RPC. It adds no service, queue, or new
distributed consistency boundary. Source complexity has grown materially,
especially in delivery framing and cursor recovery. A big-bang replacement is
viable because compatibility and existing production data are explicitly out
of scope, but it must use this implementation and its tests as the behavioral
and performance oracle.

## Measured Result

The latest cumulative comparison used branch head `0e1e94469` against exact
current main `8a10191f4`. Every timer was on the Node host around
awaited network/RPC work or host-observed delivery; no claim relies on a
Worker-local clock advancing while Cloudflare has no network I/O in flight.

| Workload                            |  Main p50 | Candidate p50 |        Change |
| ----------------------------------- | --------: | ------------: | ------------: |
| Append one 1 KiB event, no result   |  2.322 ms |      0.800 ms | 65.56% faster |
| Append 100 tiny events              |  4.007 ms |      2.805 ms | 30.01% faster |
| Append 100 x 1 KiB events           |  7.201 ms |      4.719 ms | 34.47% faster |
| Append 1,000 tiny events            | 24.486 ms |     14.138 ms | 42.26% faster |
| 32 concurrent singleton appends     | 10.094 ms |      6.308 ms | 37.51% faster |
| Append to one live subscriber       |  1.677 ms |      0.822 ms | 50.98% faster |
| Append to 25 live subscribers       |  3.172 ms |      2.947 ms |  7.11% faster |
| Read hot head                       |  0.594 ms |      0.501 ms | 15.70% faster |
| Read 500 dense 4 KiB events         | 14.927 ms |     12.216 ms | 18.16% faster |
| Read 20 selected events from 2,000  |  0.819 ms |      0.743 ms |  9.23% faster |
| Read latest selected event          |  0.743 ms |      0.534 ms | 28.11% faster |
| Append one inline 768 KiB event     | 40.773 ms |     20.367 ms | 50.05% faster |
| Append one chunked 1.1 MiB event    | 34.710 ms |     30.235 ms | 12.89% faster |
| Dense durable cross-post            |  4.476 ms |      4.270 ms |  4.61% faster |
| Sparse durable cross-post, 1 of 100 |  5.579 ms |      4.434 ms | 20.52% faster |

Focused demand-bound replay used 1,000 Streams with 500 events each. Compared
with exact main, the shipping implementation improved p50/p95/p99/mean by
31.80%/47.76%/42.73%/34.82% and used 10.76% less post-GC heap. Compared with
the preceding retained-tail candidate, it used 43.75% less post-GC heap while
also improving p50/p95/p99. The shipping profile recorded 945.9 ms total GC
and a 43.3 ms longest GC run.

The public `processEvent(event)` callback is implemented over private bounded
batch transport. A deployed Node -> source Stream DO -> Project Worker ->
output Stream DO -> Node comparison found paired-median changes of 1.95%
faster for durable singleton delivery, 0.70% slower for durable 1,000 x 640 B,
0.30% faster for ephemeral singleton delivery, and 0.97% faster for ephemeral
1,000 x 640 B. Those are neutral parity results, which is the desired outcome:
the cleaner public callback does not sacrifice the PCM workload. A later exact
same-build comparison of transport shape found one 25-event private batch RPC
85.86% faster at p50 than 25 singular Worker RPCs (69.015 ms versus 488.241
ms), so public callback granularity and wire granularity must remain separate.

## Known Tails And Limits

The enlarged forced-reactivation `head()` lane was 19.12% slower p50 and
66.04% slower p95 in checkpoint 15; checkpoint 16 was neutral at p50 and
66.69% slower at p95. This was not left as unexplained variance. The branch
carried replayed checkpoint lag across abrupt incarnations, then appended one
new `woken` fact per incarnation until the 64-event threshold flushed it. A
clean isolated correction improved p50/p95/mean 7.45%/5.82%/4.56% across
1,500 observations per arm and won all five paired p50 rounds. One noisy
process leaves p99 inconclusive. The only other cleanly attributed cold cost
is the required canonical-name KV read: about +0.261 ms p50, +0.825 ms p95,
and +0.280 ms mean.

The low-count full-suite replay row improved p50 but regressed p95. It is
superseded for acceptance purposes by the dedicated 1,000-observation replay
and heap profile, which improved through p99. Do not hide the low-count result,
but do not let it override the higher-powered profile.

Twenty-five-subscriber p95 is neutral, not improved. Dense cross-post has been
process-placement-sensitive in smaller suites. The final cumulative control
is the correct summary.

No benchmark estimates production traffic weighting. No benchmark proves
global multi-writer scaling across isolates or regions; one Durable Object
still serializes its own commit order.

## Accepted Design

### Public Surface

The conceptual API is:

- `append`
- `subscribe`
- `read`
- `waitForEvent`

`append` defaults to durable acknowledgement with no returned payload. The
same operation can request input-aligned offsets or events. Specialized raw-DO
methods remain internal result modes so the no-result path does not parse an
options envelope or serialize committed events. There is no public
`appendAck` compatibility operation.

Consumers implement `processEvent(event)`. `processEventBatch` remains a
private transport/amortization detail. A synchronous receiver batch allocates
no Promise continuation; the receiver creates one ordered continuation only
when the first handler actually returns a promise.

### Journal And Append

`stream-storage.ts` owns schema-v8 synchronous SQLite storage. Event metadata
and bytes are inserted directly, large events use bounded chunk rows, small
events stay inline up to 1 MiB, and keyless homogeneous batches use the
derived insert path. Idempotency lookup remains indexed and bounded caches are
only accelerators; SQLite is canonical.

`stream-durable-object.ts` owns the synchronous commit turn: parse, resolve
idempotency, validate, reduce, insert, checkpoint scheduling, and post-commit
fanout. Do not add an `await` inside the commit path. Synchronous writes in one
Durable Object turn already share the runtime transaction and output gate.

### Delivery And Durability

`stream-delivery-frame-reader.ts` builds bounded frames and owns the fresh-tail
and storage-read projections. `stream-subscribers.ts` supplies the demand
signal. Parsed payloads remain only while a connection has unsent work, a push
drain is active, or a poke is in flight. Caught-up connections do not retain
payloads.

`subscription-cursor-store.ts` persists cursor epochs, exact push claims,
pending progress, retry deadlines, and parked state in SQLite. Claims enter
the output gate before outbound RPC. Quiet-tail acknowledgements can be
staged and folded into the next claim without losing monotonic progress.

Selectors stay before the wire. Exact-type sparse reads use the match-sized
SQL frame path; general conditions are applied before transport. Poison
bisection stays with durable claim construction because it changes the claimed
frame. Retry/backoff uses Durable Object alarms, not correctness-critical
local timers.

`subscriber-sinks.ts` quarantines Workers RPC, itx expression evaluation,
webhooks, capability retention, and disposal. A returned or passed stub is an
owned resource, not an ordinary JavaScript callback.

### Correctness Invariants

- Offsets are contiguous and assigned once inside one synchronous commit turn.
- A malformed or state-invalid variadic append cannot leave a committed prefix.
- Idempotency returns the original offset/event and preserves input alignment.
- A durable push claim is persisted before RPC; crash after receiver commit but
  before acknowledgement causes exact-frame redelivery.
- Cursor epochs fence stale sessions and reconfiguration races.
- Selectors skip offsets rather than deferring them.
- One poison event cannot silently skip healthy events behind a paused target.
- Constructor and alarm paths recover durable deliveries after eviction.
- `waitForEvent` recovers from a Stream DO reset.
- Timeouts and latency evidence that need elapsed wall time use real network I/O
  or a Node-host clock; frozen isolate time is never a correctness assumption.

## Current Architecture And Cost

```text
StreamDurableObject
  |-- StreamEventLog                    synchronous SQLite journal
  |-- core reducer + checkpoint         append validation and folded config
  |-- StreamDeliveryFrameReader         bounded fresh/storage frame planner
  |-- StreamSubscribers                 session pumps, push drains, retry policy
  |-- SqliteSubscriptionCursorStore     durable claims, cursors, epochs
  `-- subscriber-sinks                  RPC/webhook transport and ownership
```

Against current main `8a10191f4`, exact candidate `0e1e94469` differs by 140
files and `+23,534/-3,264` lines. That number is dominated by this evidence
ledger, tests, generated API output, and call-site migration. The Stream domain
has 24 changed non-test production files at `+4,511/-1,227`, net +3,284 lines.

After the current-main integration, the eight largest runtime
coordination/storage/runner files total 8,437 lines. The old pre-runner estimate
of 6,343 lines is no longer a valid complexity baseline. An independent Claude
CLI review of the preceding tree counted about 5,085 delivery-side coordination
lines, roughly 88 private members, and about 13 semi-independent state
machines; the new runner and registry add explicit ownership but also source.
The realistic replacement budget remains 3,300-3,600 coordination lines,
about 45 private members, and about eight state machines. Recount those measures
with one agreed file set before claiming the replacement gate. These are design
budgets, not measured performance claims.

The main structural debts are:

- Wake delivery is split between a live session pump and a durable
  poke/watermark/reconcile machine.
- One cursor row exposes several verbs whose `ackedOffset` has different wake,
  push, and skip meanings.
- The frame reader is also a query planner with several projection caches and
  invalidation rules.
- Delivery-produced facts re-enter the public synchronous append path, which
  creates wake-generation and deferred-reconcile fences.
- Some subscription control events are schema-parsed once by the reducer and
  again by post-commit processing.

The persistent format is intentionally destructive. Schema v8 has no legacy
migration. Existing Stream state must be erased before rollout. Rolling back
to a pre-v8 binary after new state exists also requires another erase. This is
acceptable only because the project explicitly permits wiping production.

## Rejected Directions

| Direction                                | Result                                                                        | Disposition                            |
| ---------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------- |
| True legacy Durable Object KV journal    | 0.9%-35.9% slower p50 across tested lanes; more segmentation/recovery code    | Reject                                 |
| Explicit legacy-KV `storage.sync()`      | Slower; waits for ActorCache flush rather than shaping it                     | Reject                                 |
| Segmented/normalized/JSON-table journals | Narrow wins, broad append/read regressions, added formats and recovery paths  | Reject                                 |
| Per-event RPC transport                  | Exact PCM matrix: 7.07x p50 and 8.25x p95 slowdown; earlier lanes up to 13x   | Keep per-event API, private batch wire |
| Actor or Worker append coalescers        | Burst wins, 8.8%-16.3% singleton tax and changed transaction semantics        | Reject as default                      |
| Larger hosted-processor frames           | Throughput/tail trade did not clear the gate                                  | Reject                                 |
| One hosted-delivery capability/session   | 8%-17% slower handshake paths plus more ownership code                        | Reject                                 |
| `kv.list()` activation snapshot          | Fewer statements but neutral/slower real workerd                              | Reject                                 |
| Direct cross-post dial cache             | Mixed/no durable gain after full path                                         | Reverted                               |
| Exact-type wake preselection             | Did not improve the real consumer lane                                        | Reject                                 |
| Unconditional retained tail              | Fast but +58.6% post-GC heap                                                  | Replaced by demand-bound tail          |
| JSON/column envelope rewrites            | Local promise failed deployed Worker-consumer gate or deep-input correctness  | Reject                                 |
| Flattened generic expression dispatch    | Positive point estimates, zero-crossing intervals, worse batch mean, +148 LOC | Hold outside shipping branch           |

The detailed reasons, revisions, samples, and collapse paths are in the ledger.
Do not restart these experiments without a materially different mechanism.

## Replacement Options

### Coherent Big-Bang Kernel

The executable prototype is in
`/Users/jonastemplestein/.superset/worktrees/iterate/graceful-snowplow-stream-kernel`
on `experiment/stream-kernel-coherent`. Its experimental source is currently
untracked, so the worktree itself must not be cleaned. The prototype reduces
the implemented coordination core to 1,053 lines and 26 private members around
one journal, one fresh cache, one ephemeral machine, and one durable
claim/checkpoint machine.

The prototype proves that a large source collapse is possible, but its 79.3%
line reduction is not feature parity. It still needs byte-bounded frames,
never-split-one-event handling, demand-bound retention, the internal no-result
append mode, general selectors before the wire, poison bisection, metrics,
capability disposal, lifecycle cleanup, reset-safe waits, and deployed RPC
proof. A realistic feature-complete reduction is likely 40%-55%, not 79%.

A big-bang replacement should keep this ownership graph:

```text
StreamDurableObject shell
  |-- StreamJournal -> StreamEventLog
  |-- FreshTailCache (demand-bound only)
  |-- DeliveryFrameReader (byte bounds and selection)
  |-- EphemeralDelivery (incarnation-local sessions)
  `-- DurableDelivery -> SubscriptionCursorStore
                        -> poison/retry/alarm policy
                        -> narrow transports
```

Do not merge ephemeral fire-and-forget delivery and authoritative push claims
into one mode-branching loop. They share frame reading, but push requires a
storage claim and acknowledgement while ephemeral delivery must not gain a
storage round trip or Promise per frame.

### Receiver-Owned Pull Cursor

The committed kernel is `3416ea6b0` on
`experiment/stream-pull-kernel-track-b`; the current worktree is
`/private/tmp/iterate-stream-pull-track-b`. It demonstrated one source head
notifier plus one serial receiver-owned page drain, reaching roughly 85-89
million in-memory events/s at useful page sizes and coalescing 100,000 head
updates to two notifications.

It remains research. It needs a durable target-head/cursor protocol,
cross-object retention fencing, selectors, transport adapters, crash
recovery, and deployed storage/RPC proof. The worktree also contains a newer
uncommitted demand-session experiment. Inspect it before cleaning `/tmp`.

### Incremental Consolidation

The fresh Claude review of exact merged head proposed a lower-risk path that
is also a useful module blueprint for a replacement:

- Extract the journal without changing SQL or append bytes.
- Expose mode-typed wake-watermark and push-cursor views over the same store.
- Make the fresh tail the sole owner of speculative parsed memory.
- Keep the current synchronous `notify` pump shape; a class refactor must not
  allocate a Promise per connection per append.
- Unify wake delivery ownership under the session pump while leaving the
  watermark as a progress sink.
- Keep retry, poison, and alarm policy with durable claims, not transports.

It also identified one narrow possible free win: reuse the reducer's parsed
subscription control envelope instead of parsing it again post-commit. This is
unmeasured and should not delay the landing decision.

## Most Promising Remaining Experiments

The exact-current-main broad measurement is complete and establishes that the
merged runner retained a roughly 30% central equal-workload gain. If runner
attribution affects the landing decision, the remaining focused lane must
cover a warm already-acknowledged barrier, a cold sparse catch-up, an empty
selected frame that scans to head, continuous writers, process eviction, and a
failed receiver retry. Time append/birth through observed readiness on the
Node host. This lane is required to isolate the compact frame's contribution,
not to support the cumulative headline.

Generic flattened expression dispatch has now been measured and does not clear
its shipping gate. Its singleton point estimate was positive, but the
process-cluster p50 interval crossed zero; one 4.678-second batch made batch
mean 25.41% worse, and the extra scoped entrypoint did not classify the
`ItxEntrypoint.get` errors. Hold the 148-line prototype. Repeat it only if the
error fingerprint can be attributed by dispatch mode and a tighter paired
matrix can be run without adding a second protocol.

The ten accepted flattened-process windows were subsequently audited by exact
UTC boundary and Worker version. `otel` returned 2,438
`evaluateExpression` rows: 2,313 `ok`, 117 `exception`, and 8 `canceled`; every
process had 4-20 exceptions. Native invocation logs independently contained
exactly 117 error-level rows with fingerprint
`65899ee645d52f3d0c0661284fe7a02e`. Because the generic method serves both
plain-returning pushes and capability-returning wakes, this does not isolate
the return shape. It does prove that generic flattening is not itself a clean
operational boundary.

The source-backed operational experiment is narrower than reviving that
prototype: compare one minimal capability-returning probe with one flat
operation that performs identical work and returns plain structured data,
through both direct and forwarded bindings. Correlate explicit disposal with
the terminal outcome and use fixed call counts so the two return shapes cannot
mix. If plain-data forwarded calls are clean, replace retained ITX authority
roots with bounded operation-specific calls; if they are not, use a non-JS-RPC
fetch boundary or pursue the workerd forwarding fix. Renaming the method,
removing `async`, or omitting disposal are closed.

The highest-value bounded clarity change is now the typed post-commit delta:
carry the reducer's parsed subscription-control fact across the synchronous
commit boundary instead of schema-parsing it again. It should remove work and
code without changing persistence, transport, or recovery. The highest-upside
isolated performance experiment is the transactional-outbox spike's integrated
sparse scan-and-claim query. It may remove duplicate materialization, but must
remain in an experiment worktree until deployed sparse, dense, singleton,
poison, and recovery gates pass.

The best cold-start experiment is one physical activation KV record containing
canonical name plus optional core checkpoint. It removes one point read without
the iterator allocation that defeated `kv.list()`. The measured ceiling is
about 0.26-0.28 ms, roughly 11%-12% of a 2.2-2.5 ms activation. It is a
destructive format change with no binary rollback, which is acceptable here.

A second, lower-confidence cold experiment is one discriminated SQL bootstrap
result containing event bounds plus cursor rows. It must be tested at 0, 1,
32, and 100 subscriptions; a wider result can cost more than the saved SQL
dispatch. Reject it immediately if it misses the 5% p50/mean gate or regresses
p95.

Two narrow append/storage ideas remain unproved. A derived keyed insert for
fully keyed homogeneous durable batches reduces 100 events from five
statements/500 bindings to three/206, and 1,000 events from 50/5,000 to
21/2,042. A host-SQLite prefilter suggested about 17.5% lower tiny-event and
14% lower 1 KiB write-stage p50, but it has no end-to-end workerd or deployed
proof. Separately, bulk-populating the acknowledgement cache for batches of at
least 128 keys could avoid FIFO churn. Both preserve the schema and recovery
model, but neither should delay the landing decision; the cache experiment
also needs exact equivalence and eviction tests.

For a replacement, the highest-value experiment is not another micro-kernel.
It is a feature-complete vertical slice: append with internal no-result mode,
one live `processEvent` subscriber, one durable claimed Project Worker
subscriber, byte-bounded frames, kill/retry recovery, and Node-host timing in
an actual deployed preview. Once that slice matches current correctness and
latency, the remaining modes can move behind the same kernel.

## Landing Recommendation

Stop adding speculative runtime mechanisms to PR #1902. The branch has enough
evidence to decide.

1. Give this snapshot, the ledger, and the current/prototype code to one fresh
   reviewer. Ask for a ship-current versus replace-now verdict and missing
   invariants, not another list of micro-optimizations.
2. Choose one landing path. Either ship the measured current implementation
   after the destructive rollout procedure is approved, or replace it in one
   branch using the current implementation as an oracle. Do not maintain both
   kernels or add compatibility dispatch.
3. If shipping current, treat the exact-current-main checkpoint and activation
   diagnosis as complete. The flattened-dispatch and actual singular-RPC
   experiments, plus the synchronous-`get` rejection, are complete and do not
   belong in the shipping diff. Keep the PR draft until the
   `ItxEntrypoint.get` errors are eliminated or represented outside error
   telemetry, the complete preview is green, and the wipe/rollback runbook is
   in the PR body. Then stop broad benchmarking.
4. If replacing now, freeze the public API and benchmark corpus. The
   replacement must pass the current Stream suite, crash matrix, post-GC replay
   profile, and deployed Worker-consumer lanes before the current code is
   deleted.

## Evidence Index

Durable repository evidence:

| Evidence                          | Location                                                                                           |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| Full experiment chronology        | [`stream-performance-ledger.md`](./stream-performance-ledger.md)                                   |
| Cumulative/deployed harness       | [`stream-cumulative-benchmark.e2e.test.ts`](../e2e/vitest/stream-cumulative-benchmark.e2e.test.ts) |
| Current commit/coordination shell | [`stream-durable-object.ts`](../src/domains/streams/stream-durable-object.ts)                      |
| Journal                           | [`stream-storage.ts`](../src/domains/streams/stream-storage.ts)                                    |
| Delivery state machines           | [`stream-subscribers.ts`](../src/domains/streams/stream-subscribers.ts)                            |
| Frame planner and fresh tail      | [`stream-delivery-frame-reader.ts`](../src/domains/streams/stream-delivery-frame-reader.ts)        |
| Durable cursor rows               | [`subscription-cursor-store.ts`](../src/domains/streams/subscription-cursor-store.ts)              |
| Transport ownership               | [`subscriber-sinks.ts`](../src/domains/streams/subscriber-sinks.ts)                                |

Raw measurement inventory as of this snapshot:

- 1,130 referenced raw/profile files still exist, totaling 24,280,568 bytes.
- 1,114 are logs, 11 are DevTools CPU profiles, and five are JSON/text
  analyses.
- The files span `2026-07-13T20:58:08Z` through
  `2026-07-15T11:28:43Z`.
- The local `/tmp/payload-release-live-*` logs are no longer present. Their
  deployed callback logs, focused DevTools profile, summary JSON, and ledger
  results remain.
- Checkpoint 14 and 15 each retain all 50 raw process logs plus their validated
  analysis file. Their line-wrapped ledger paths can look missing to a literal
  glob, but the files are present.

The raw files are now archived outside `/tmp`:

```text
/Users/jonastemplestein/stream-performance-evidence-2026-07-15.tar.gz
files: 1130
size: 6.1 MB compressed
sha256: da898b32fd4dcdd169da08bf16c64b75aca7ef4337d9bca9f9d06f45918da903
```

The two 2026-07-16 post-merge cumulative matrices are separately archived at:

```text
/Users/jonastemplestein/stream-performance-evidence-2026-07-16.tar.gz
files: 190
size: 9.1 MB compressed
sha256: 09caee4e742ab454ea2e8e2047c8146c24bbe965963a4790ee2e2ab9c2ba9552
```

The clean forced-reactivation checkpoint A/B is archived at:

```text
/Users/jonastemplestein/stream-activation-checkpoint-evidence-2026-07-16-clean.tar.gz
samples: 3000 across 10 passing processes
size: 1.0 MB compressed
sha256: 9650aca809c12e09152ba5f5dcefb048c4e20106f7d136fd08eabe38fd98fe9b
```

The final dispatch and callback experiments are archived at:

```text
/Users/jonastemplestein/stream-flattened-dispatch-evidence-2026-07-16.tar.gz
sha256: 736bb5abd16f03a2dcca19b973fdb9dd1153930929a1d2e665082259beba1afe

/Users/jonastemplestein/stream-performance-evidence-2026-07-16-checkpoint-17.tar.gz
sha256: 2e4c17b1d1283e9d2daeafb4c178f9abf26009388d1994af546620f6cb1a7eab

/Users/jonastemplestein/stream-performance-evidence-2026-07-16-checkpoint-18.tar.gz
sha256: 788ab90ed9112529096ef33da67a919d2c54e306a53f907f76183909e0a7d251

/Users/jonastemplestein/stream-process-event-adapter-evidence-2026-07-16.tar.gz
sha256: 16e18816359f3bc080de3e167029901dc1aab70b5ce4822df1bdca9af31ebf90

/Users/jonastemplestein/stream-singular-worker-rpc-evidence-2026-07-16.tar.gz
sha256: 21a797eeb6e8fa63f639f037cbc8f3f52b6dad82066ec4e7b5a61c73bc4e7606

/Users/jonastemplestein/stream-sync-itx-get-evidence-2026-07-16.tar.gz
sha256: e089091d8650503b069f8629b67fe549a4bcc75f66246256eee65969cb383401
```

High-value live paths:

| Evidence                      | Path                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------- |
| Checkpoint 15 raw pool        | `/tmp/cumulative-15-{full,tail,live,crosspost,storage}-{main,candidate}-r{1..5}.log`                |
| Checkpoint 15 validation      | `/tmp/cumulative-15-analysis.txt`                                                                   |
| Checkpoint 16 archive         | `~/stream-performance-evidence-2026-07-16.tar.gz`                                                   |
| Checkpoint 16 live analysis   | `~/stream-performance-evidence-2026-07-16-current-main/analysis.{txt,json}`                         |
| Checkpoint 17 archive         | `~/stream-performance-evidence-2026-07-16-checkpoint-17.tar.gz`                                     |
| Checkpoint 17 live analysis   | `~/stream-performance-evidence-2026-07-16-checkpoint-17/analysis.{txt,json}`                        |
| Checkpoint 18 archive         | `~/stream-performance-evidence-2026-07-16-checkpoint-18.tar.gz`                                     |
| Checkpoint 18 live analysis   | `~/stream-performance-evidence-2026-07-16-checkpoint-18/analysis.{txt,json}`                        |
| Activation checkpoint A/B     | `~/stream-activation-checkpoint-evidence-2026-07-16-clean/{RESULTS.md,activation-*}`                |
| Flattened dispatch A/B        | `~/stream-flattened-dispatch-evidence-2026-07-16/{README.md,aggregate.json,telemetry-summary.json}` |
| Singular callback adapter     | `~/stream-process-event-adapter-evidence-2026-07-16/{README.md,*aggregate.json}`                    |
| Singular Worker RPC matrix    | `~/stream-singular-worker-rpc-evidence-2026-07-16/{README.md,aggregate.json}`                       |
| Synchronous ITX get rejection | `~/stream-sync-itx-get-evidence-2026-07-16/{README.md,telemetry-summary.json}`                      |
| Shipping replay profile       | `/private/tmp/replay-workerd-profile-shipping-release-focused.cpuprofile`                           |
| Shipping replay summary       | `/private/tmp/replay-workerd-profile-shipping-release-focused-summary.json`                         |
| Deployed final callback proof | `/tmp/payload-release-deployed-{durable,ephemeral}-886b5ecf1-r*.log`                                |
| Fair processEvent proof       | `/tmp/process-event-preview5-b65-*.log`                                                             |
| Legacy KV comparison          | `/tmp/stream-json-array-ab-r{1..3}.log` and branch paths in the ledger                              |
| Previous Claude review        | `/Users/jonastemplestein/.claude/plans/act-as-an-independent-eager-pretzel.md`                      |

There are 40 `/private/tmp/iterate-stream-*` experiment worktrees. The most
important source locations are:

| Experiment                      | Location                                                                                         | Preservation state                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Coherent kernel                 | `/Users/jonastemplestein/.superset/worktrees/iterate/graceful-snowplow-stream-kernel`            | Seven untracked experiment files; volatile until committed |
| Pull/demand kernel              | `/private/tmp/iterate-stream-pull-track-b`                                                       | Committed core plus uncommitted demand-session files       |
| Storage explorer                | `/private/tmp/iterate-stream-storage-explorer-a`                                                 | Modified storage source/tests/ledger; uncommitted          |
| Current-main checkpoint control | `/private/tmp/iterate-stream-current-main-20260716-checkpoint18`                                 | Detached exact `8a10191f4` baseline                        |
| Current candidate control       | `/private/tmp/iterate-stream-current-candidate-20260716-checkpoint18`                            | Detached exact `0e1e94469` candidate                       |
| Legacy KV implementations       | `/private/tmp/iterate-stream-kv-yolo`, `/private/tmp/iterate-stream-legacy-kv-yolo`              | Clean experiment branches                                  |
| Radical journal/pump            | `/private/tmp/iterate-stream-radical-journal`, `/private/tmp/iterate-stream-radical-credit-pump` | Clean experiment branches                                  |

Upstream source audits are available at
`/Users/jonastemplestein/src/github.com/cloudflare/workerd` and
`/Users/jonastemplestein/src/github.com/cloudflare/capnweb`. The ledger's audit
used pinned workerd `a51ee4b9`, capnweb `ee7ca6f5`, and Cloudflare docs
`2b08a67a`; the local clones have since advanced. Relevant workerd entry points
include `src/workerd/api/sync-kv.c++` and `src/workerd/util/sqlite-kv.h`.

## Second-Opinion Brief

Give another agent this document and ask it to read, in order:

1. The latest seven ledger sections, then the rejected-direction headings.
2. `stream-durable-object.ts`, `stream-storage.ts`,
   `stream-delivery-frame-reader.ts`, `stream-subscribers.ts`, and
   `subscription-cursor-store.ts`.
3. The coherent-kernel experimental source and tests in the separate worktree.
4. `~/stream-performance-evidence-2026-07-16-checkpoint-18/analysis.txt` and the
   shipping replay summary JSON.
5. The `README.md` and aggregate JSON in the flattened-dispatch,
   process-event-adapter, and singular-worker-RPC evidence directories.

Ask it to answer these concrete questions:

- Would it ship the measured current implementation or replace it before
  production, given that data can be erased and compatibility is irrelevant?
- Which current state machines are irreducible correctness and which are
  accidental duplication?
- Does the replacement preserve every invariant listed above, especially
  output-gated claims, selector cursor advancement, poison isolation, reset
  recovery, and capability disposal?
- What is the smallest feature-complete kernel that can beat current head in
  local workerd and deployed Worker-consumer tests?
- Which measurements are strong enough to support a decision, and which need
  one final run?

Do not accept Worker-local elapsed-time evidence, Node-only microbenchmarks as
shipping proof, or a line-count reduction that omits byte bounds, retries,
selectors, lifecycle, and durable cursor semantics.
