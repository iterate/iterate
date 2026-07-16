# Stream Performance Handoff

Snapshot captured on 2026-07-15 and updated on 2026-07-16 after semantically
integrating `origin/main` through `7495c6802` into draft PR
[#1902](https://github.com/iterate/iterate/pull/1902). The integrated history
includes the #2002 processor runner/registry redesign, #2038 explicit processor
births, #2040 native trace roots for Stream retry alarms, and #2046's
runtime-neutral inspector UI. Exact merged candidate `b2712ad09` has now been
benchmarked against exact current main `7495c6802`. Production has not been
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

The resolved tree passes root typecheck, lint, formatting, and the recursive
workspace test matrix. The focused Stream matrix passes 478 tests; the affected
cross-domain matrix passes 208. The complete OS unit suite passes 1,969 tests
with one intentional skip across 188 files. Generated OS and package ITX
APIs/examples were regenerated from source. Later bootstrap/idempotency fixes
pass 544 Stream-domain tests, and the exact post-merge cumulative checkpoint is
recorded below.

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
deployment. A new full preview is still required after committing that test
correction, but the Stream runtime fixes themselves have deployed proof.

### Exact current-main checkpoint

Two immutable local Worker stacks compared exact merged candidate
`b2712ad0934de105bdc8d112fc1d042226a5d5a6` with freshly fetched exact main
`7495c680220d3c8cf0c7ffeb7ffec28a6c2c18f8`. Five alternating fresh processes
per revision ran each of the complete suite, enlarged append/reactivation,
live delivery, enlarged cross-post, and storage/reactivation lanes. All 50
processes and 35,750 host-timed observations passed identity, cardinality,
finiteness, and semantic validation.

| Equal-workload aggregate  | p50 improvement | p95 improvement | Mean improvement |
| ------------------------- | --------------: | --------------: | ---------------: |
| Unmodified full suite     |     **28.889%** |     **18.188%** |      **29.914%** |
| Conservative substitution |     **30.568%** |     **27.018%** |      **31.619%** |

The conservative row replaces low-count full-suite singleton append,
100-event append, concurrent append, and one/25-subscriber rows with their
larger focused controls. It is an equal-workload geometric summary, not a
production-traffic weighting. A separate immediately preceding 50-process
matrix against `c2582c200` reported 34.582%/36.349%/33.763% for the unmodified
suite and 33.422%/36.498%/33.430% conservatively. The intervening main commit
changed only inspector UI, so the spread quantifies local-run variance rather
than a Stream-runtime attribution.

The larger controls retain the useful wins: p50 improved 69.16% for
acknowledgement-only 1 KiB append, 32.35% for 100 tiny events, 30.40% for 100 x
1 KiB, 36.27% for 1,000 tiny, 33.18% for 32 concurrent singleton calls, 49.27%
for one live subscriber, 9.01% for 25 live subscribers, and 46.08% for one
inline 768 KiB event. Corresponding p50 throughput improved 47.82%, 43.68%,
56.92%, 49.65%, and 9.90% in the batch/concurrent/fanout lanes.

The primary unresolved regression is activation tail latency. Across five
100-sample processes, forced-reactivation head p50 was neutral at 0.62% slower,
but p95 was 66.69% slower (2.735 ms to 4.559 ms). Dense post-reactivation read
improved 15.73% p50 while regressing 9.98% p95. Sparse post-reactivation read
improved 22.24% p50 and remained neutral at 2.58% slower p95. The 1.1 MiB
chunked append is now neutral at 2.22% faster p50 and 1.36% faster mean. These
tails make activation diagnosis, not another broad delivery mechanism, the
next performance gate.

Both matrices, server logs, metadata, validator, and analyses are archived at
`~/stream-performance-evidence-2026-07-16.tar.gz` (9.1 MiB compressed),
SHA-256
`09caee4e742ab454ea2e8e2047c8146c24bbe965963a4790ee2e2ab9c2ba9552`.

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

This document is the short, decision-oriented companion to the chronological
[Stream performance ledger](./stream-performance-ledger.md). The ledger is the
source of truth for experiment setup, immutable revisions, raw sample paths,
and rejected hypotheses. The destructive consolidation sequence and its
acceptance gates are in the
[Stream refactor roadmap](./stream-refactor-roadmap.md).

## Executive Summary

The measured merged implementation is a large, real performance win. Its
latest exact-current-main checkpoint used 50 valid fresh Node/Vitest processes
and reported an equal-workload geometric improvement of 30.568% p50, 27.018%
p95, and 31.619% mean under the conservative substitution rule. The unmodified
full suite improved 28.889% p50, 18.188% p95, and 29.914% mean. These are
equal-workload summaries, not production-traffic weighting or a sum of
isolated wins.

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

The latest cumulative comparison used merged candidate `b2712ad09` against
exact current main `7495c6802`. Every timer was on the Node host around
awaited network/RPC work or host-observed delivery; no claim relies on a
Worker-local clock advancing while Cloudflare has no network I/O in flight.

| Workload                            |  Main p50 | Candidate p50 |        Change |
| ----------------------------------- | --------: | ------------: | ------------: |
| Append one 1 KiB event, no result   |  2.535 ms |      0.782 ms | 69.16% faster |
| Append 100 tiny events              |  4.358 ms |      2.948 ms | 32.35% faster |
| Append 100 x 1 KiB events           |  8.043 ms |      5.598 ms | 30.40% faster |
| Append 1,000 tiny events            | 25.911 ms |     16.513 ms | 36.27% faster |
| 32 concurrent singleton appends     | 10.915 ms |      7.294 ms | 33.18% faster |
| Append to one live subscriber       |  1.810 ms |      0.918 ms | 49.27% faster |
| Append to 25 live subscribers       |  3.526 ms |      3.208 ms |  9.01% faster |
| Read hot head                       |  0.707 ms |      0.507 ms | 28.19% faster |
| Read 500 dense 4 KiB events         | 15.108 ms |     13.164 ms | 12.87% faster |
| Read 20 selected events from 2,000  |  0.800 ms |      0.848 ms |  6.04% slower |
| Read latest selected event          |  0.776 ms |      0.564 ms | 27.37% faster |
| Append one inline 768 KiB event     | 42.974 ms |     23.171 ms | 46.08% faster |
| Append one chunked 1.1 MiB event    | 36.314 ms |     35.509 ms |  2.22% faster |
| Dense durable cross-post            |  4.713 ms |      4.582 ms |  2.80% faster |
| Sparse durable cross-post, 1 of 100 |  6.205 ms |      5.671 ms |  8.62% faster |

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
the cleaner public callback does not sacrifice the PCM workload, while one RPC
per event was decisively rejected.

## Known Tails And Limits

The enlarged forced-reactivation `head()` lane was 19.12% slower p50 and
66.04% slower p95 in checkpoint 15. The full-suite lane was slightly faster,
and two larger isolated controls previously improved reactivation p50/p95.
The only cleanly attributed cold cost is the required canonical-name KV read:
about +0.261 ms p50, +0.825 ms p95, and +0.280 ms mean. Treat the latest large
tail as unresolved platform/activation variance, not as a proven regression
caused by one current mechanism.

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

Against integrated main `c2582c200`, the working tree differs by 136 files and
`+22,165/-3,170` lines before this final documentation update. That number is
dominated by this evidence ledger, tests, generated API output, and call-site
migration. The Stream domain has 25 changed non-test production files at
`+4,446/-1,239`, net +3,207 lines.

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

| Direction                                | Result                                                                       | Disposition                            |
| ---------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------- |
| True legacy Durable Object KV journal    | 0.9%-35.9% slower p50 across tested lanes; more segmentation/recovery code   | Reject                                 |
| Explicit legacy-KV `storage.sync()`      | Slower; waits for ActorCache flush rather than shaping it                    | Reject                                 |
| Segmented/normalized/JSON-table journals | Narrow wins, broad append/read regressions, added formats and recovery paths | Reject                                 |
| Per-event RPC transport                  | Up to 13x slower durable push and severe deployed PCM tails                  | Keep per-event API, private batch wire |
| Actor or Worker append coalescers        | Burst wins, 8.8%-16.3% singleton tax and changed transaction semantics       | Reject as default                      |
| Larger hosted-processor frames           | Throughput/tail trade did not clear the gate                                 | Reject                                 |
| One hosted-delivery capability/session   | 8%-17% slower handshake paths plus more ownership code                       | Reject                                 |
| `kv.list()` activation snapshot          | Fewer statements but neutral/slower real workerd                             | Reject                                 |
| Direct cross-post dial cache             | Mixed/no durable gain after full path                                        | Reverted                               |
| Exact-type wake preselection             | Did not improve the real consumer lane                                       | Reject                                 |
| Unconditional retained tail              | Fast but +58.6% post-GC heap                                                 | Replaced by demand-bound tail          |
| JSON/column envelope rewrites            | Local promise failed deployed Worker-consumer gate or deep-input correctness | Reject                                 |

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

The only delivery experiment with a credible deployed-scale mechanism is the
preserved direct Project Worker lane from `9fd1cbbb3`. It bypasses the
`ctx.exports.ItxEntrypoint(...).get()` loopback and transient `ProjectRpcTarget`
only for the canonical private `processEventBatch` expression. The initial
deployed 1,000 x 640 B result was 9.5% faster p50 and 10.6% higher p50
capacity, but 13.8% worse p95. A later alternating result reversed while its
preview suffered unrelated stalls and a storage reset. Neither result is
shipping evidence. A clean rerun should use generic and direct source DOs in
one deployment, randomized ABBA pairs, fresh projects, Node-host end-to-end
timing, and singleton, PCM, fan-in, reactivation, recovery, agent-status, and
search-index lanes. Require at least 5% paired p50/capacity improvement, no
more than 2% p95/p99 regression, exact recovery, and no source DO duration or
hibernation regression. Reject it if indexing requires another coordination
system.

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
3. If shipping current, treat the exact-current-main checkpoint as complete.
   Keep the PR draft until the corrected full preview and wipe/rollback runbook
   are in the PR body, then stop broad benchmarking.
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

High-value live paths:

| Evidence                      | Path                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| Checkpoint 15 raw pool        | `/tmp/cumulative-15-{full,tail,live,crosspost,storage}-{main,candidate}-r{1..5}.log` |
| Checkpoint 15 validation      | `/tmp/cumulative-15-analysis.txt`                                                    |
| Checkpoint 16 archive         | `~/stream-performance-evidence-2026-07-16.tar.gz`                                    |
| Checkpoint 16 live analysis   | `~/stream-performance-evidence-2026-07-16-current-main/analysis.{txt,json}`          |
| Shipping replay profile       | `/private/tmp/replay-workerd-profile-shipping-release-focused.cpuprofile`            |
| Shipping replay summary       | `/private/tmp/replay-workerd-profile-shipping-release-focused-summary.json`          |
| Deployed final callback proof | `/tmp/payload-release-deployed-{durable,ephemeral}-886b5ecf1-r*.log`                 |
| Fair processEvent proof       | `/tmp/process-event-preview5-b65-*.log`                                              |
| Legacy KV comparison          | `/tmp/stream-json-array-ab-r{1..3}.log` and branch paths in the ledger               |
| Previous Claude review        | `/Users/jonastemplestein/.claude/plans/act-as-an-independent-eager-pretzel.md`       |

There are 40 `/private/tmp/iterate-stream-*` experiment worktrees. The most
important source locations are:

| Experiment                      | Location                                                                                         | Preservation state                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Coherent kernel                 | `/Users/jonastemplestein/.superset/worktrees/iterate/graceful-snowplow-stream-kernel`            | Seven untracked experiment files; volatile until committed |
| Pull/demand kernel              | `/private/tmp/iterate-stream-pull-track-b`                                                       | Committed core plus uncommitted demand-session files       |
| Storage explorer                | `/private/tmp/iterate-stream-storage-explorer-a`                                                 | Modified storage source/tests/ledger; uncommitted          |
| Current-main checkpoint control | `/private/tmp/iterate-stream-current-main-20260716`                                              | Detached exact `7495c6802` baseline                        |
| Current candidate control       | `/private/tmp/iterate-stream-current-candidate-20260716`                                         | Detached exact `b2712ad09` candidate                       |
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
4. `~/stream-performance-evidence-2026-07-16-current-main/analysis.txt` and the
   shipping replay summary JSON.

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
