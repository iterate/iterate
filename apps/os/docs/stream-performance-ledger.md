# Stream Performance Ledger

This is the durable record for cumulative Stream Durable Object performance
work. It exists so later consolidation can distinguish measured behavior from
incidental implementation. During an active optimization run, repeat the
branch-versus-current-main suite at least once every four hours and append a
dated entry here.

## Benchmark Rules

- Measure from a Node host around an awaited RPC or a host-observed delivery.
  Do not time code inside a Worker isolate: Cloudflare can freeze its clock
  while no network I/O is in flight.
- Fetch `origin/main` immediately before the run. Compare immutable SHAs.
- Run candidate and baseline from separate worktrees and separate local
  Durable Object state. Keep only one Workers stack active at a time.
- Use the same host-side client harness for both servers. Alternate server
  order across groups of rounds to expose machine drift.
- Warm each hot path before collecting samples. Use fresh projects and stream
  paths for each round, and assert the semantic result of every workload.
- Report each workload separately. An equal-weight aggregate is useful as a
  suite summary, but it is not a production-traffic-weighted latency claim.
- A positive percentage means the candidate used less wall time. Treat changes
  below 5% as neutral unless a larger focused sample reproduces them.

The opt-in harness is
[`stream-cumulative-benchmark.e2e.test.ts`](../e2e/vitest/stream-cumulative-benchmark.e2e.test.ts).
It prints the complete sample arrays in one
`STREAM_CUMULATIVE_BENCHMARK` JSON record. Normal test runs skip it.

Point the branch-hosted harness at whichever server is active:

```bash
doppler run --config dev -- env \
  APP_CONFIG_BASE_URL=http://localhost:<port> \
  STREAM_CUMULATIVE_BENCHMARK=1 \
  STREAM_BENCH_IMPLEMENTATION=<candidate-or-main> \
  STREAM_BENCH_REVISION=<sha> \
  pnpm --dir apps/os e2e --run \
  e2e/vitest/stream-cumulative-benchmark.e2e.test.ts --project node
```

## 2026-07-13: First Cumulative Main Comparison

### Revisions And Runtime

- Candidate: `cbe04fcf1529353f81ae1bacd426e2a4f097911f`
- Baseline: `5f3e3f40b912208ee3d3d9c6e1399b68c069590d`
  (`origin/main`, fetched immediately before the run)
- Host: Apple M4 Max, 128 GiB RAM, macOS/Darwin 24.6.0, arm64
- Node `24.4.0`, pnpm `10.24.0`, Vite `8.0.9`
- Cloudflare Vite plugin `1.43.0`, Miniflare `4.20260701.0`, workerd
  `1.20260701.1`, Wrangler `4.107.0`, capnweb `0.8.0`
- Nine independent full rounds per revision. The low-tail confirmation used
  four additional rounds per revision with 1,000 samples per selected path.
- Collection ended at `2026-07-13T20:42Z`. If this optimization run remains
  active, the next cumulative comparison is due by `2026-07-14T00:42Z`.

The benchmark compares semantic outcomes, not artificially identical response
bytes. For a durable append whose caller discards the result, main uses
`append()` and candidate uses `appendAck()`. To read the tail, main uses the
full `runtimeState()` surface and candidate uses `head()`. To find the latest
matching event, main reads all matching events forward and candidate requests
one descending row. These are the cheapest correct public operations each
revision offers for the same caller requirement.

### Median P50 Results

Each raw list is the p50 from rounds 1 through 9, in milliseconds. `Change` is
computed from the median of those nine round p50s.

| Workload                                       | Main round p50s (ms)                                                   | Candidate round p50s (ms)                                              |   Main | Candidate |           Change |
| ---------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- | -----: | --------: | ---------------: |
| Append one 1 KiB event, discard result         | 1.164, 1.149, 0.802, 1.108, 1.064, 1.213, 1.277, 1.127, 1.089          | 1.080, 0.905, 0.985, 1.304, 1.151, 1.184, 0.994, 0.738, 0.746          |  1.127 |     0.994 | **11.8% faster** |
| Append 100 tiny events in one call             | 3.712, 3.418, 3.360, 3.484, 3.465, 3.559, 3.895, 3.645, 3.385          | 1.898, 1.912, 1.934, 2.123, 2.235, 2.126, 2.017, 2.113, 2.172          |  3.484 |     2.113 | **39.4% faster** |
| Append 32 concurrent singleton calls           | 6.356, 6.310, 6.436, 6.468, 6.477, 7.192, 6.485, 6.392, 6.587          | 6.357, 5.918, 7.431, 6.606, 6.595, 6.705, 5.983, 5.908, 7.148          |  6.468 |     6.595 |  neutral (-2.0%) |
| Append one 256 KiB event, discard result       | 3.895, 3.805, 3.780, 3.695, 3.990, 4.187, 3.947, 3.947, 3.861          | 2.620, 2.691, 2.606, 2.911, 2.987, 3.130, 2.887, 2.738, 2.689          |  3.895 |     2.738 | **29.7% faster** |
| Retry one acknowledged 256 KiB event           | 3.277, 3.117, 3.140, 3.199, 3.445, 3.118, 3.025, 3.084, 3.206          | 1.971, 1.997, 2.356, 2.345, 2.469, 2.925, 2.474, 2.395, 2.285          |  3.140 |     2.356 | **24.9% faster** |
| Read a hot stream head                         | 0.551, 0.522, 0.513, 0.576, 0.517, 0.631, 0.535, 0.543, 0.535          | 0.523, 0.474, 0.483, 0.567, 0.528, 0.569, 0.455, 0.488, 0.374          |  0.535 |     0.488 |  **8.8% faster** |
| Read 500 dense 4 KiB events                    | 13.936, 13.659, 13.358, 13.466, 13.750, 14.018, 14.813, 14.019, 13.860 | 11.721, 11.543, 12.496, 12.590, 13.853, 13.528, 13.624, 13.295, 13.114 | 13.860 |    13.114 |  **5.4% faster** |
| Read 20 selected events from 2,000             | 0.786, 0.773, 0.743, 0.705, 0.745, 0.802, 0.863, 0.747, 0.741          | 0.718, 0.708, 0.859, 0.770, 0.868, 0.791, 0.748, 0.674, 0.660          |  0.747 |     0.748 |  neutral (-0.1%) |
| Read latest selected event                     | 0.689, 0.710, 0.686, 0.660, 0.810, 0.727, 0.825, 0.685, 0.778          | 0.561, 0.514, 0.520, 0.684, 0.598, 0.587, 0.545, 0.508, 0.492          |  0.710 |     0.545 | **23.2% faster** |
| Replay 500 128-byte events into a subscription | 5.299, 5.044, 4.849, 5.602, 6.427, 5.064, 6.159, 5.276, 5.375          | 4.793, 5.014, 5.482, 4.709, 4.504, 4.447, 4.238, 4.552, 3.960          |  5.299 |     4.552 | **14.1% faster** |
| Append through delivery to one live subscriber | 0.803, 0.822, 0.787, 0.780, 0.804, 0.830, 1.123, 0.807, 0.840          | 0.814, 0.785, 1.021, 0.825, 0.902, 0.939, 0.745, 0.801, 0.754          |  0.807 |     0.814 |  neutral (-0.8%) |
| Append through delivery to 25 live subscribers | 4.538, 4.363, 4.309, 4.643, 4.336, 4.553, 4.998, 4.319, 4.784          | 4.328, 4.105, 4.695, 4.657, 4.330, 4.743, 4.473, 3.909, 3.814          |  4.538 |     4.330 |  neutral (+4.6%) |
| Dense one-event durable cross-post             | 1.939, 1.808, 1.810, 1.871, 1.671, 1.715, 2.212, 1.960, 1.984          | 1.684, 1.709, 2.032, 1.931, 2.032, 2.179, 1.757, 1.713, 1.826          |  1.871 |     1.826 |  neutral (+2.4%) |
| Sparse durable cross-post, 1 of 100 events     | 3.604, 3.437, 3.301, 3.214, 3.119, 3.397, 4.011, 3.229, 3.424          | 2.659, 2.415, 2.999, 2.604, 2.925, 3.206, 2.381, 2.599, 2.273          |  3.397 |     2.604 | **23.3% faster** |
| Head read after forced reactivation            | 1.669, 1.672, 1.600, 1.633, 1.662, 1.788, 1.657, 2.130, 1.795          | 1.852, 1.523, 1.795, 1.765, 1.724, 1.820, 1.565, 1.386, 1.455          |  1.669 |     1.724 |  neutral (-3.3%) |

The equal-workload geometric mean is **13.1% lower p50 latency**. This is a
summary of the suite, not an estimate of production traffic mix. The clearest
throughput translation is the 100-event append: median capacity rises from
about **28.7k to 47.3k events/s (+64.9%)** in this local single-DO workload.
Replay rises from about **94.4k to 109.8k events/s (+16.4%)**. Sparse 1-of-100
cross-post input throughput rises from about **29.4k to 38.4k events/s
(+30.5%)**. Thirty-two independent concurrent RPCs remain transport-bound and
neutral at about 4.9k calls/s.

### Focused Tail Confirmation

The first 9-round pool suggested possible 0.1 ms p95 regressions in sparse
reads and one-subscriber delivery. Four additional rounds per revision, each
with 1,000 samples for these paths and with the final round run in reverse
server order, did not reproduce a regression:

| Workload                                       | Main pooled p50 / p95 | Candidate pooled p50 / p95 |         P50 / p95 change |
| ---------------------------------------------- | --------------------: | -------------------------: | -----------------------: |
| Read 20 selected events from 2,000             |      0.782 / 1.092 ms |           0.645 / 0.971 ms | **17.5% / 11.1% faster** |
| Read latest selected event                     |      0.732 / 0.988 ms |           0.440 / 0.683 ms | **40.0% / 30.9% faster** |
| Append through delivery to one live subscriber |      0.762 / 1.183 ms |           0.690 / 1.096 ms |   **9.5% / 7.4% faster** |

The discrepancy is consistent with machine-phase noise at sub-millisecond
scale, which is why the harness retains raw arrays and supports
`STREAM_BENCH_TAIL_SAMPLES=1000`.

### Cost And Collapse Assessment

At the measured candidate SHA, the committed branch-versus-main diff is 91
files and `+10,840/-2,229` lines:

| Category      | Files | Added | Removed |
| ------------- | ----: | ----: | ------: |
| Production    |    44 | 4,433 |   1,111 |
| Tests and e2e |    40 | 6,182 |   1,039 |
| Documentation |     4 |    75 |      35 |
| Generated API |     3 |   150 |      44 |

The benchmark harness adds another 516 test lines. The implementation is not a
small, elegant switch. Most net production growth is concentrated in two
already stateful modules: `stream-storage.ts` grows from 612 to 1,674 lines and
`stream-subscribers.ts` from 1,395 to 2,287. The stream DO grows from 1,310 to
1,562 lines. Agent checkpoint decomposition adds a focused 363-line module.

Runtime costs are bounded but real:

- Push delivery can hold a frame up to 8,000 events / 4 MiB instead of the
  shared 1,000-event / 1 MiB frame, and sparse fill can retain at most two such
  storage projections. This trades bounded activation memory for fewer reads
  and receiver round trips.
- The acknowledged-idempotency cache retains at most 128 keys of at most 512
  UTF-16 code units per stream activation. A miss always falls back to SQLite.
- More state-machine branches exist for exact retry frames, cursor-write
  coalescing, adaptive sparse scans, and activation recovery. The test growth
  is larger than production growth because these branches have crash/retry and
  poison-event matrices.
- Storage schema v8 deliberately has no legacy migration. Existing stream data
  must be erased before rollout. A binary rollback after v8 state is created is
  also destructive; rollback requires erasing stream state again. Deployment
  is therefore operationally simple only because this effort explicitly
  accepts a production wipe.

The system still collapses operationally into one Stream DO, its SQLite, and
ordinary Workers RPC; it does not add a service, queue, coordinator, or new
distributed consistency boundary. It does **not** collapse elegantly at the
source level yet. A later consolidation should preserve the one public
`append` operation, the specialized internal no-payload/offset/event storage
projections, schema-v8 row shape, frame/cursor correctness tests, and host
benchmark, then unify the duplicated bounded-range/frame planning inside
storage and subscriber delivery. Do not trade those measured contracts for
legacy KV or a second persistence model.

### Shipping Interpretation

The branch is worth advancing as a destructive preview candidate because the
large wins cover batch ingest, large writes, duplicate retries, replay, latest
reads, and sparse durable delivery, with no reproduced regression in live
latency. Forced-cold head is 4.8-10.1% slower because correct canonical-name
recovery adds one activation KV read. It is not ready for an unqualified
production merge solely on this local benchmark: schema-v8 wipe/rollback
procedure and a preview workload run still need explicit sign-off, and the
source-complexity consolidation map should be retained even if consolidation
happens after the performance branch ships.

## 2026-07-13: WebSocket Coalescing Rejected

Source review found one bounded transport experiment not already covered by
the Stream work: combine Cap'n Web messages emitted synchronously into one
newline-delimited WebSocket frame, with a 64 KiB cap and a microtask flush. It
uses no timer, which is important because a timer is both a latency floor and
unreliable evidence under Workers' frozen-clock behavior.

The prototype replaced Cap'n Web's WebSocket transport symmetrically in the
Worker, Node client, and browser client. Unit tests proved ordering, frame
caps, connect-time queuing, and flush-before-abort. Two policies were measured
against the exact pre-experiment branch commit `906724c25`:

| Policy                          | 32 concurrent appends | Single append |     Hot head | Equal-workload p50 |
| ------------------------------- | --------------------: | ------------: | -----------: | -----------------: |
| Delay all messages to microtask |          16.0% faster |  33.3% slower | 12.4% slower |        3.4% faster |
| Send first, coalesce sync tail  |          11.1% slower |  17.5% slower | 13.4% slower |        7.1% slower |

The first policy demonstrates that fewer frames can help a synthetic burst,
but it imposes an unacceptable latency floor on the dominant singleton case.
The leading-edge policy avoids intentionally delaying the first frame, yet
the custom transport's encoding and scheduling overhead erased the burst win
and regressed the suite. One-subscriber live delivery stayed neutral in the
reverse-order comparison (`2.6%` faster), so the rejection is driven by broad
RPC overhead rather than a delivery correctness failure.

Each row uses the median of five full rounds per revision. Collection order
was baseline, all-delayed, leading-edge, then baseline again; the leading-edge
numbers above use the final reverse-order baseline. Host timers enclosed every
awaited RPC or observed delivery, and all workload correctness assertions
passed. Raw JSON remains in `/tmp/stream-coalesce-baseline-{2..11}.log`,
`/tmp/stream-coalesce-candidate-{1..5}.log`, and
`/tmp/stream-coalesce-leading-{1..5}.log` for the life of this workstation.

The prototype was deleted completely. It adds no production protocol, code,
or compatibility burden. Do not resume it unless a future Cap'n Web release
implements coalescing below serialization overhead and a deployed A/B can
show a burst win without a singleton p95 regression.

## Source Audit And Consolidation Map

The follow-up audit pinned workerd at
`a51ee4b96980cec92d3628f39f74a86e451d8ad1`, capnweb at
`ee7ca6f5f15dfc238c8d877e23ad396de67d68ab`, and Cloudflare's documentation at
`2b08a67a41da1a521aecbcf465893abae1e9a6df`. Its implications are:

- Cap'n Web promise pipelining applies through an unresolved returned
  capability. It does not merge 32 sibling calls, and an awaited append cannot
  discard its result before commit/error acknowledgement.
- SQLite writes made synchronously in one Durable Object turn already collect
  in the runtime's implicit transaction and remain behind the output gate.
  Application-level storage batching would add a queueing delay and duplicate
  runtime semantics.
- Legacy KV offers no useful manual flush primitive. Moving the event log to
  it would rebuild ordered scans, indexes, chunking, cursor fencing, garbage
  collection, and large-value handling around its 128 KiB value limit. Do not
  pursue that branch.
- Output gates, cursor epochs, persisted pending frames, failure/backoff state,
  wake generations, and network-bracketed clock reads are irreducible
  correctness mechanisms. They should not be abstracted away or deleted.

The accidental complexity is concentrated in delivery-frame construction:
parallel `ReadBatchProjection`/`ReadBatchResult` shapes, all/durable arrays,
duplicate byte arrays, two fresh-tail projections, and overlapping raw-range,
projection, and selector caches. Consolidation should proceed without changing
the measured data path:

1. Introduce one transport-free `DeliveryFrameReader` with a request object,
   one `DeliveryFrame` containing all/durable views, and one cache-admission
   function.
2. Keep push, wake, ephemeral, and webhook state machines separate, but share
   a small `DeliveryFence { epoch, configuredOffset }` value.
3. Move the cursor interface and SQLite implementation into
   `subscription-cursor-store.ts`; deduplicate in-memory claim/failure reset
   plumbing while preserving named transitions and specialized statements.
4. Leave Stream DO append orchestration and singleton/small-batch/chunked
   insertion specializations in place; these account for measured gains.
5. Reuse the Agent history-item contract schema for checkpoint chunk parsing,
   then make reader/cache and corruption tests table-driven without deleting
   crash, epoch, poison, reentrancy, eviction, or frozen-clock cases.

This structural pass is expected to remove roughly 250-440 production lines
and 500-900 test lines without a performance trade. The exact-type SQL
prefilter and sparse-fill branches could remove more, but they have measured
sparse wins and therefore require isolated deletion benchmarks rather than
being folded into the structural cleanup.

## 2026-07-13: Delivery Frame Reader Boundary

The first consolidation slice introduces a typed request and a transport-free
`StreamDeliveryFrameReader`. It owns the fresh committed tail, adaptive storage
read limits, raw SQLite range caches, and complete frame projections.
`StreamSubscribers` retains lane state, selector evaluation, cursor movement,
and delivery fencing. Selector-result memoization moved from a mutable property
on the reader projection to a subscriber-owned `WeakMap`, so the reader no
longer depends on compiled selectors.

This is an ownership improvement, not yet a line-count reduction:
`stream-subscribers.ts` falls from 2,287 to 1,962 lines, while the new focused
module is 381 lines, for a combined 2,343 (`+56`). The next structural slice
must unify the still-parallel frame/projection views and cache admission before
the consolidation can claim a source-size win.

All 358 Stream-domain tests pass. Five alternating full benchmark rounds per
revision compared the working tree with exact pre-refactor commit `002f266b6`.
Their equal-workload p50 geometric mean was 2.4% slower, but unrelated append
paths varied by up to 27%, making that run too noisy to attribute. Four
additional alternating rounds used 1,000 host-timed samples per reader-sensitive
path (4,000 samples per side):

| Path                        | Median-of-round p50 |   Pooled p95 |
| --------------------------- | ------------------: | -----------: |
| Sparse read, 20 of 2,000    |         0.1% slower |  8.9% faster |
| Latest sparse match         |         2.8% faster | 15.1% faster |
| Live delivery, 1 subscriber |         6.9% faster |  6.5% faster |

The result is neutral-to-positive on the directly affected paths, so the
boundary is retained without claiming a new cumulative speedup. Host timers
enclosed each awaited RPC or observed delivery; all workload result assertions
passed. Raw records are in `/tmp/frame-reader-{candidate,baseline}-{1..5}.log`
and `/tmp/frame-reader-tail-{candidate,baseline}-{1..4}.log` for the life of
this workstation.

The harness now also accepts `STREAM_BENCH_APPEND_SAMPLES` for focused
singleton-append tails. Four 1,000-sample rounds per revision initially put the
extraction on port 5201 and its parent on port 5202; pooled p50 was 1.6% slower
and pooled p95 was 19.2% slower. A required same-revision control then ran
`e6aef40b8` on both ports. Port 5201 was itself 5.0% slower at pooled p50 and
16.2% slower at pooled p95, accounting for the apparent extraction gap. No
append regression is attributed to the reader boundary. Raw controls are in
`/tmp/frame-reader-append-{candidate,baseline}-{1..4}.log` and
`/tmp/frame-reader-calibration-{port5201,port5202}-{1..4}.log`.

A follow-up ownership review invalidated the earlier proposal to collapse
`DeliveryFrameProjection` and `DeliveryFrame`. The projection owns canonical
arrays retained by caches; the returned frame owns an isolated consumer array.
Combining them would expose cached arrays to receiver code or add another
wrapper/copy/property hop on every read. Likewise, helpers for the three
mutually exclusive result branches would reduce text without reducing executed
work. Keep the inline result construction and array slices.

One genuinely redundant field was removed: selected SQL projections stored a
`selectedThroughOffset` equal to their already-checked `throughOffset`, adding
one property and comparison with no extra fence. A positional-argument reader
variant also removed the request object, but four 1,000-sample rounds did not
beat the committed reader consistently: sparse-read pooled p50 improved 3.8%,
while latest-sparse and live-delivery pooled p50 were 6.0% and 9.0% slower on
the slower candidate process. The named request contract was restored. Raw
records are in `/tmp/read-positional-{candidate,baseline}-{1..4}.log`.

The reader boundary is therefore considered complete at a combined `+53`
production lines. Further structural reduction should come from cursor-store
locality and repeated transition plumbing, not from weakening frame ownership.

## 2026-07-13: Subscription Cursor Store Boundary

The cursor contract, sqlfu query client, in-memory row cache, transition
methods, batched progress/set statements, and reconciliation now live in
`subscription-cursor-store.ts`. The append log remains in
`stream-storage.ts`, which still owns the one shared schema bootstrap because
the event and cursor tables intentionally commit under the same Durable Object
output gate. The runtime dependency is one-way: cursor store to shared storage
bootstrap to event schemas.

The cursor implementation and generated SQL statement builders are byte-identical
to parent `329800a53`. The move reduces `stream-storage.ts` from 1,674 to 940
lines; the new cursor module is 739 lines, so the combined boundary is only
`+5` production lines. It improves locality without hiding transitions behind
a generic repository abstraction or adding another persistence model.

All 358 Stream-domain tests pass, along with OS typecheck and focused lint and
format checks. An independent review found no semantic drift, import cycle,
schema-initialization regression, sqlfu regression, or hot-path change. The one
remaining ownership cost is deliberate: cursor schema changes touch both the
central bootstrap DDL and sqlfu's typed schema description, just as they did
when both lived in one file.

Three alternating host-timed full benchmark rounds compared the extraction on
port 5201 with exact parent `e6aef40b8` on port 5202. The equal-workload p50
geometric mean was 2.5% slower, within the previously measured 5.0% p50 /
16.2% p95 disadvantage of port 5201 under a same-revision calibration. The two
cursor-sensitive durable cross-post paths were 9.0% and 9.3% faster at
median-of-round p50 despite that port placement. This move therefore records no
new speedup and no reproduced regression. Raw records are in
`/tmp/cursor-extraction-{candidate,baseline}-{1..3}.log`.

## 2026-07-13: Cursor Reset Helper Not Retained

The cursor extraction exposed five identical in-memory row-reset sequences.
A zero-allocation `resetCursorRow(row, ackedOffset, epoch)` helper removed 25
net production lines while preserving assignment order and all 167 focused
cursor/subscriber tests. A three-round full comparison initially looked
positive but had large unrelated workload swings, so it was not accepted as
evidence.

A focused follow-up added `STREAM_BENCH_CROSSPOST_SAMPLES` to the host harness
and collected four rounds per revision. The direct helper comparison appeared
8.0% slower at pooled sparse p50 and 10.2% slower at pooled dense p50. That was
not sufficient to establish causality because the two revisions occupied
different long-lived local processes and the full comparison had already shown
large unrelated workload swings.

After deleting the helper, a same-revision control ran exact `88b34adb5`
production code on both ports in mirrored order, with 1,000 dense and 1,000
sparse samples per side. Port 5201 was 19.9% slower at pooled dense p50 but 0.5%
faster at pooled sparse p50; its two dense rounds differed by 49.2% at p50.
Those contradictory results are larger than the apparent helper effect and
show that this local comparison was dominated by process and workload drift.
The helper therefore records neither a speedup nor a proved regression. It is
not retained because source cleanup alone is outside this performance branch's
scope; the explicit assignments remain until a lower-noise benchmark shows a
benefit or a wider cursor redesign removes them. The benchmark sample-count
control remains for future cursor experiments.

Raw records are in `/tmp/cursor-reset-helper-{candidate,baseline}-{1..3}.log`,
`/tmp/cursor-reset-crosspost-{candidate,baseline}-{1..4}.log`, and
`/tmp/cursor-reset-calibration-{candidate,baseline}-{1..2}.log`; the interrupted
candidate round was overwritten by a complete rerun and is not included.

## 2026-07-13: Raw SQLite Cursor Store

The cursor store now calls synchronous `SqlStorage.exec()` directly instead of
wrapping the same SQLite statements in sqlfu's generated Durable Object client.
This is not the rejected legacy-KV storage swap: events and cursors remain in
the same SQLite database, synchronous writes remain in the current turn and
output gate, and transition caching and fencing are unchanged.
`initializeStreamStorage()` is now the sole schema authority, the OS package
no longer depends on sqlfu, and the cursor module falls from 739 to 635 lines
(`-104` production lines).

Four mirrored rounds compared exact parent `88b34adb5` on port 5202 with the
candidate on port 5201, using 500 host-timed operations per path per round
(2,000 samples per side). Every timer enclosed an awaited RPC:

| Cursor path               | Baseline p50 / p95 | Candidate p50 / p95 |     Change p50 / p95 |
| ------------------------- | -----------------: | ------------------: | -------------------: |
| Dense durable cross-post  |   4.849 / 7.743 ms |    4.612 / 7.543 ms |   4.9% / 2.6% faster |
| Sparse durable cross-post |   6.132 / 9.891 ms |    5.423 / 8.473 ms | 11.6% / 14.3% faster |

Sparse delivery was faster in every candidate round. Dense delivery was faster
in three of four rounds but remains neutral under the 5% attribution threshold.
Four additional forced-reactivation rounds (800 samples per side) were neutral
at p50 (0.5% slower) and 14.9% slower at pooled p95 because one candidate round
shifted upward; that tail did not reproduce consistently, so this experiment
makes no cold-start claim. Five mirrored full-suite rounds degraded on both
long-lived processes and moved unrelated paths by multiples; their
equal-workload p50 geometric mean was a neutral 1.1% candidate regression and
is not usable for path attribution.

All 358 Stream-domain tests pass, including transaction rollback, cursor epoch,
claim recovery, backoff, and teardown coverage, along with OS typecheck and
focused lint/format checks. The cost is loss of sqlfu's generated named-binding
types inside this one store; positional statement order is instead covered by
the existing transition tests. The change removes an abstraction, duplicate
schema declaration, generated client field, and package dependency without
adding a queue, persistence model, transaction boundary, or distributed
mechanism, so it reduces rather than increases the eventual collapse cost.
Storage failures now expose Cloudflare's native error instead of sqlfu's
decorated query metadata; no OS caller consumes that error shape, but this is
an observability tradeoff when diagnosing an unexpected SQL failure.

Raw records are in `/tmp/raw-cursor-crosspost-{baseline,candidate}-{1..4}.log`,
`/tmp/raw-cursor-cold-{baseline,candidate}-{1..4}.log`, and
`/tmp/raw-cursor-{baseline,candidate}-{1..5}.log` for the life of this
workstation.

## 2026-07-13: Packed Keyless Batch Insert Rejected

A prototype replaced the bounded multi-row inserts for large keyless durable
batches with one bound JSON array. SQLite's `json_each()` derived each event's
offset and type and stored `cast(value as blob)`, reducing a 100-event append
from four insert statements to one and a 500-event append from sixteen to one.
The fast path remained synchronous SQLite in the current turn and output gate;
it did not introduce legacy KV, an application flush queue, or a second
persistence model.

Unit tests proved byte-exact JSON storage for Unicode and control characters,
whole-statement rollback on a conflicting offset, bounded fallback above the
1 MiB packed cap, and one serialization per event. All 360 Stream-domain tests,
OS typecheck, focused lint, and format checks passed before measurement.

Five host-timed rounds per revision compared exact parent `5da765519` with the
prototype. Every sample enclosed the awaited append RPC, and every round read
the final batch back through workerd and asserted all markers. Lower is better:

| Batch width | Samples/side |     Parent p50 / p95 / mean |     Packed p50 / p95 / mean | Packed change p50 / p95 / mean |
| ----------- | -----------: | --------------------------: | --------------------------: | -----------------------------: |
| 100 events  |        1,000 |    5.283 / 8.768 / 5.856 ms |    5.456 / 9.231 / 5.973 ms |      3.3% / 5.3% / 2.0% slower |
| 500 events  |          500 | 15.913 / 24.175 / 17.132 ms | 16.208 / 24.554 / 17.234 ms |      1.9% / 1.6% / 0.6% slower |

Only three of five 100-event rounds and two of five 500-event rounds improved
by mean. The larger case deliberately amplified statement-count savings, yet
SQLite's JSON virtual-table parsing and reconstruction still erased them. The
prototype also required a second insertion representation, byte-cap branch,
packing buffer, and fallback state, so retaining it would increase source
complexity for negative throughput.

The production prototype and its implementation-specific tests were deleted.
The benchmark improvements remain: `STREAM_BENCH_BATCH_SAMPLES` and
`STREAM_BENCH_BATCH_SIZE` can amplify future ingest experiments, while a
bounded replay assertion verifies the measured batch instead of checking only
the stream head. Raw records are in
`/tmp/packed-batch-{baseline,candidate}-{1..5}.log` and
`/tmp/packed-batch500-{baseline,candidate}-{1..5}.log` for the life of this
workstation.

## 2026-07-13: Derived Metadata For Homogeneous Batches

Keyless durable batches above the direct 33-row `VALUES` capacity now use an
`insert ... select` statement over bound event BLOBs. The statement binds the
batch's first offset and shared type once, derives each later contiguous offset
from a literal row index, and keeps every serialized event as an ordinary SQLite
binding. It does not pack or reparse JSON.

The specialization is deliberately narrow. Singletons and batches through 33
rows retain the previous direct statement. Keyed, ephemeral, mixed-type, and
noncontiguous batches retain explicit per-row metadata. The Stream DO assigns
new rows contiguous offsets even when idempotency hits are interleaved, but the
storage boundary verifies contiguity instead of relying on that caller detail.
Multi-statement batches remain inside `transactionSync()`.

The SQL work changes as follows:

| Batch | Parent statements / bindings | Candidate statements / bindings | Transaction change |
| ----: | ---------------------------: | ------------------------------: | ------------------ |
|    34 |                      2 / 102 |                          1 / 36 | removed            |
|   100 |                      4 / 300 |                         2 / 104 | unchanged          |
|   500 |                   16 / 1,500 |                         6 / 512 | unchanged          |

Five alternating host-timed rounds per width compared the working tree on
candidate parent `9a20eb193` with baseline server `5da765519`. The intervening
commit changes only this ledger and the benchmark harness, so the baseline's
production Stream code is identical to the candidate parent. Every timer
enclosed the awaited append RPC, and every round replayed the final bounded
batch through workerd and asserted all markers:

| Batch | Samples/side |   Baseline p50 / p95 / mean |  Candidate p50 / p95 / mean |   Candidate change p50 / p95 / mean |
| ----: | -----------: | --------------------------: | --------------------------: | ----------------------------------: |
|    34 |        2,500 |    3.291 / 5.675 / 3.676 ms |    3.074 / 5.308 / 3.419 ms |           6.6% / 6.5% / 7.0% faster |
|   100 |        2,500 |    5.512 / 8.853 / 6.128 ms |    5.353 / 8.465 / 5.961 ms | 2.9% / 4.4% / 2.7% faster (neutral) |
|   500 |          500 | 17.657 / 28.280 / 19.226 ms | 16.619 / 25.660 / 17.780 ms |           5.9% / 9.3% / 7.5% faster |

The 34- and 500-event throughput translations are 7.1% and 6.2% more events
per second at pooled p50. All five 34-event rounds improved by mean; all five
500-event rounds also improved by mean. The 100-event result remains neutral
under the 5% attribution threshold.

Tests cover the direct 33-row boundary, derived metadata and binding ceilings,
heterogeneous and noncontiguous fallback, byte-bounded sub-batches, chunked
rows, exact replay, and rollback when a conflict in the second statement
follows a successful first statement. All 363 Stream-domain tests pass, along
with OS typecheck and focused lint/format. The
implementation costs net `+39` production lines and `+118` test lines. It adds
one generated statement family and one insertion-mode branch, but no schema,
queue, timer, persistence model, protocol, or compatibility path.

Raw records are in `/tmp/derived-batch34-{baseline,candidate}-{1..5}.log`,
`/tmp/derived-batch100-{baseline,candidate}-{1..5}.log`, and
`/tmp/derived-batch500-{baseline,candidate}-{1..5}.log` for the life of this
workstation.

## 2026-07-13: Deferred Quiet-Tail Push Acknowledgements

Successful push delivery now leaves the final cursor acknowledgement staged in
memory instead of forcing `flushPending("all")` when the drain reaches the
stream tail. The next push frame claim atomically checkpoints that prior ack in
the same SQLite statement required to claim the new frame. Failure transitions,
the recovery alarm, and idle teardown remain durable lifecycle checkpoints.

This makes the cursor store's existing cross-drain batching policy effective
for trickle traffic. Previously the subscriber drain tracked a staged ack only
to force it immediately at each quiet tail, adding a synchronous SQLite write
and output gate after every successful one-batch delivery. The change removes
that bookkeeping and three tail flushes for a net `-11` production lines. It
adds no queue, timer, schema, transaction, protocol, or persistence mechanism.

Five mirrored host-timed rounds compared exact parent `d81f658d8` on port 5202
with the candidate on port 5201. Each side delivered 1,000 sequential one-event
dense cross-posts per round. Every sample started before the awaited source
append RPC and ended only when the destination subscription callback observed
the unique marker, so the measurement does not depend on a Worker isolate clock
advancing without network I/O:

| Samples/side | Baseline p50 / p95 / mean | Candidate p50 / p95 / mean | Candidate change p50 / p95 / mean |
| -----------: | ------------------------: | -------------------------: | --------------------------------: |
|        5,000 |  4.157 / 6.515 / 4.479 ms |   3.827 / 6.203 / 4.116 ms |         7.9% / 4.8% / 8.1% faster |

Candidate p50 was faster in all five rounds and mean was faster in all five;
one round's p95 was 0.5% slower while pooled p95 improved. P50 throughput rose
8.6%. The benchmark harness now has independent
`STREAM_BENCH_DENSE_CROSSPOST_SAMPLES` and
`STREAM_BENCH_SPARSE_CROSSPOST_SAMPLES` controls so a singleton trickle test
does not also amplify 100-event sparse batches.

The correctness tradeoff is bounded and matches the documented at-least-once
contract. If an incarnation dies after the receiver acknowledged the quiet-tail
frame but before the next claim or lifecycle flush, durable storage still holds
that exact claimed frame. Recovery may therefore replay one already-successful
frame per subscription with the same delivery ID. It cannot skip the frame or
invent a different boundary. Real-SQLite tests prove the next claim atomically
checkpoints the previous ack and lifecycle flushes persist a quiet tail; the
subscriber test now proves reaching the tail does not force an early flush.
All 363 Stream-domain tests pass, along with OS typecheck and focused lint and
format checks.

Raw records are in `/tmp/quiet-tail-{baseline,candidate}-{1..5}.log` for the
life of this workstation.

## 2026-07-14: Second Cumulative Main Comparison

### Revisions And Method

- Candidate: `85682fb5157557918b7120069cb24110230b772f`
- Baseline: `97a6363042818a79ccfdde12e97fa26c23af1a48`
  (`origin/main`, fetched and merged immediately before collection)
- Five independent full rounds per revision. Collection alternated in groups
  of two, two, and one rounds, restarting between revisions so only one Workers
  stack was active at a time.
- Collection ended at `2026-07-13T23:34:42Z`. If this optimization run remains
  active, the next cumulative comparison is due by `2026-07-14T03:34:42Z`.

The branch-hosted harness used the cheapest correct public operation available
on each revision for the same semantic result: main used `append()` and
`runtimeState()`, while the candidate used `appendAck()` and `head()`. Every
timer ran in Node around an awaited RPC or host-observed delivery, and every
round asserted replay contents, selected tails, subscription delivery,
cross-post arrival, and reactivation state. The comparison therefore does not
depend on a Worker isolate clock advancing while Cloudflare has no network I/O
in flight.

### Results

Each value is the median of the five per-round statistics. Positive change
means the candidate used less wall time. Changes below 5% remain neutral.

| Workload                                       |  Main p50 | Candidate p50 | P50 change |  Main p95 | Candidate p95 |    P95 change |
| ---------------------------------------------- | --------: | ------------: | ---------: | --------: | ------------: | ------------: |
| Append one 1 KiB event, discard result         |  2.651 ms |      2.193 ms |      17.3% |  3.775 ms |      3.262 ms |         13.6% |
| Append 100 tiny events in one call             |  7.971 ms |      4.910 ms |      38.4% | 12.207 ms |      8.143 ms |         33.3% |
| Append 32 concurrent singleton calls           | 10.842 ms |      8.910 ms |      17.8% | 15.012 ms |     13.582 ms |          9.5% |
| Append one 256 KiB event, discard result       | 10.620 ms |      7.951 ms |      25.1% | 16.216 ms |     12.829 ms |         20.9% |
| Retry one acknowledged 256 KiB event           |  3.516 ms |      2.440 ms |      30.6% |  4.350 ms |      3.710 ms |         14.7% |
| Read a hot stream head                         |  0.642 ms |      0.538 ms |      16.3% |  1.026 ms |      0.726 ms |         29.3% |
| Read 500 dense 4 KiB events                    | 14.884 ms |     12.753 ms |      14.3% | 21.588 ms |     21.080 ms |  neutral 2.4% |
| Read 20 selected events from 2,000             |  0.854 ms |      0.795 ms |       6.9% |  2.247 ms |      2.071 ms |          7.8% |
| Read latest selected event                     |  0.796 ms |      0.596 ms |      25.2% |  1.053 ms |      0.697 ms |         33.9% |
| Replay 500 128-byte events into a subscription |  6.987 ms |      5.871 ms |      16.0% | 11.640 ms |     10.943 ms |          6.0% |
| Append through delivery to one live subscriber |  1.385 ms |      1.087 ms |      21.5% |  3.573 ms |      3.225 ms |          9.8% |
| Append through delivery to 25 live subscribers |  4.814 ms |      4.422 ms |       8.1% |  6.924 ms |      6.689 ms |  neutral 3.4% |
| Dense one-event durable cross-post             |  4.232 ms |      3.101 ms |      26.7% |  7.286 ms |      4.969 ms |         31.8% |
| Sparse durable cross-post, 1 of 100 events     |  6.315 ms |      4.349 ms |      31.1% | 10.281 ms |     10.005 ms |  neutral 2.7% |
| Head read after forced reactivation            |  2.523 ms |      2.199 ms |      12.8% |  3.649 ms |      3.693 ms | neutral -1.2% |

The equal-workload geometric mean is **21.0% lower p50**, **15.4% lower p95**,
and **22.8% lower mean latency**. All 15 p50 comparisons improve by at least
6.9%. Eleven p95 comparisons improve by at least 5%; three are positive but
neutral, and the only negative p95 is the neutral 1.2% cold-reactivation
shift.

The direct throughput translations at median p50 are:

- 100-event append capacity rises from 12.5k to 20.4k events/s, **+62.3%**.
- 32 concurrent singleton calls rise from 3.0k to 3.6k calls/s, **+21.7%**.
- 500-event replay rises from 71.6k to 85.2k events/s, **+19.0%**.
- Sparse 1-of-100 cross-post input rises from 15.8k to 23.0k events/s,
  **+45.2%**.

These are cumulative branch-versus-current-main results, not a sum of the
percentages from isolated experiments. The absolute local numbers are slower
than the first comparison after both revisions incorporated current main's
observability work; the fair relative comparison improved from 13.1% to 21.0%
at equal-workload p50.

### Current Cost And Collapse Assessment

Before this ledger entry, the current branch-versus-main diff was 99 files.
Production was `+4,698/-1,386` lines (net `+3,312`), tests and e2e were
`+6,901/-1,046` (net `+5,855`), and generated APIs were `+150/-44`. This is
still substantial source complexity. It has not continued to balloon since
the first cumulative candidate, whose production diff was net `+3,322` lines.

The large stateful files have been split by ownership rather than hidden:
`stream-storage.ts`, `stream-subscribers.ts`, the delivery frame reader, and
the cursor store total 3,944 lines now, versus 3,961 lines for storage and
subscribers at the first comparison. The newer raw cursor store removes sqlfu
and a duplicate schema authority; derived homogeneous inserts add one bounded
SQL specialization; deferred quiet-tail acknowledgement removes 11 production
lines. No newer change adds a queue, service, coordinator, timer, storage
engine, protocol, or distributed consistency boundary.

Operationally the design can still collapse into one Stream Durable Object,
one SQLite database, and ordinary Workers RPC. Source-level collapse is not
yet elegant: exact retry frames, cursor epochs, sparse scans, checkpoint
scheduling, and compact RPC result forms remain real branches with a large
test matrix. They are correctness or measured-performance mechanisms, not
legacy compatibility paths. A later rewrite can erase production data and
replace their internal organization, but should retain the schema-v8 row
shape, public semantic projections, frozen-clock-safe benchmark, and
crash/retry tests as executable constraints.

The incremental correctness cost since the first cumulative comparison is
bounded. A successful quiet-tail push acknowledgement may replay one stable
frame with the same delivery ID if the isolate dies before the next claim or
lifecycle flush. The homogeneous insert specialization has no semantic cost;
it verifies its narrow preconditions and falls back otherwise. The destructive
rollout and rollback cost remains unchanged: existing Stream state must be
erased for schema v8, and rollback after v8 also requires erasing Stream state.

The result is strong enough to advance as a destructive preview candidate.
Production shipping still needs a preview workload run, failure/retry soak,
and explicit wipe/rollback sign-off. It does not justify bypassing those gates.

Raw records are in `/tmp/cumulative-20260714-{main,candidate}-{1..5}.log` for
the life of this workstation.

## 2026-07-14: Rejected Single-Type SQL Predicate

### Hypothesis

`scanPushEventTypesFrame()` binds exact event types as one JSON array and uses
`type in (select value from json_each(?))`. Most compiled selectors contain one
type, so a temporary specialization used `type = ?` for that case while
retaining the JSON predicate for empty and multi-type sets.

A 12-round `node:sqlite` control over 8,000 rows ran each predicate 1,000 times.
The median was 996.18 ms for `json_each()` and 832.03 ms for equality, making
the isolated statement loop 16.48% faster. Equality won every control round.

### End-To-End Result

- Candidate: uncommitted specialization on `dd9a49d7f`.
- Baseline: exact parent `dd9a49d7f`.
- Five full rounds per revision, alternated in groups of two, two, and one with
  only one Workers stack active.
- Each measured sample seeded 8,000 durable 128-byte events, selected 80 of
  them, then timed an awaited deliver-all cross-post until all 80 destination
  callbacks arrived. Ten measured samples and two warmups ran per round.
- Collection ended at `2026-07-13T23:52:05Z`. Host timers enclosed network I/O
  and callback observation; no result depended on a Worker isolate clock
  advancing without I/O.

Each value below is the median of the five per-round statistics. Positive
change means less wall time.

| Metric |    Parent | Candidate | Change |
| ------ | --------: | --------: | -----: |
| p50    | 29.712 ms | 30.410 ms |  -2.3% |
| p95    | 39.786 ms | 40.532 ms |  -1.9% |
| mean   | 30.670 ms | 32.134 ms |  -4.8% |

All delivery and replay assertions passed, but the statement-level gain did
not survive frame construction, Workers RPC, and destination delivery. The
production branch, test changes, and temporary benchmark controls were
deleted. This avoids permanent SQL and binding branches for a neutral-to-worse
public result. Future selector work should target materialization or frame
boundaries where the cost is large enough to remain visible end to end.

Raw records are in `/tmp/one-type-{parent,candidate}-{1..5}.log` for the life
of this workstation.

## 2026-07-14: Compact Cross-Post Retry Acknowledgements

### Change

`acceptCrossPost()` returns `void`, but it called the full-result `append()`
path. An at-least-once retry therefore hydrated and parsed every destination
event found by its source-derived idempotency key, then discarded those
envelopes. It now calls `appendAck()`. A warm destination can satisfy a
complete retry batch from the existing 128-entry acknowledged-idempotency
offset cache; a cache miss still queries SQLite for offsets only, never event
JSON. The production change is one substituted method call.

The existing cross-post e2e now replaces a same-key subscription with
`deliver: "all"`, waits until the authoritative source cursor acknowledges the
replay, and proves the destination still contains exactly one copy.

### Result

- Candidate: the one-line change on `3c07f0a31`.
- Baseline: exact parent `3c07f0a31`.
- Five full rounds per revision, alternated in groups of two, two, and one with
  only one Workers stack active.
- Each sample first copied eight 256 KiB events, then timed a same-key
  deliver-all replacement through source cursor acknowledgement. There were
  ten measured samples and two warmups per round; destination reads outside
  the timer asserted all eight source events collapsed to eight copies.
- Collection ended at `2026-07-14T00:09:54Z`. The Node timer enclosed awaited
  configuration and runtime-state RPCs; the completion condition was a durable
  cursor acknowledgement, not a Worker isolate clock.

Each primary value is the median of five per-round statistics. Positive change
means less wall time.

| Metric |    Parent | Candidate | Change |
| ------ | --------: | --------: | -----: |
| p50    | 10.329 ms |  8.882 ms |  14.0% |
| p95    | 12.706 ms | 12.976 ms |  -2.1% |
| mean   | 10.128 ms |  9.347 ms |   7.7% |

The 50 pooled samples confirm the central result and do not show a tail cost:
p50 improves from 10.329 to 8.777 ms (15.0%), p95 from 16.674 to 12.976 ms
(22.2%), and mean from 10.638 to 9.213 ms (13.4%). Median-p50 retry throughput
rises from 774.5 to 900.7 copied events/s, **+16.3%**.

This adds no cache, queue, storage write, protocol, or correctness branch. The
existing cache remains bounded to 128 keys and only bypasses SQLite when every
key in the batch is present; long keys, eviction, cold activation, or a partial
hit fall back to the authoritative offset query. The public contract was
already void and idempotency still derives from the source coordinate, so the
change removes unused materialization without weakening exactly-once copy
semantics over at-least-once delivery.

Raw records are in `/tmp/crosspost-ack-{parent,candidate}-{1..5}.log` for the
life of this workstation.

## 2026-07-14: Match-Sized Sparse Push Frames

### Change

`scanPushEventTypesFrame()` previously materialized up to 8,000 raw rows with
nullable byte lengths, scanned that relation to materialize selected ranks,
then materialized the consumed raw offsets again to recover cursor metadata.
Sparse historical push and cross-post replay therefore built and rescanned two
raw-frame-sized temporary relations even when no event matched.

The retained single SQLite statement now derives the raw row count and exact
offset boundary from an offset-only bounded scan, evaluates byte lengths and
window ranks only for durable matching rows inside that boundary, and computes
consumed raw metadata directly from `events` only when a byte cut occurs. The
match-only CTE is explicitly non-materialized, so dense frames do not pay for
both a selected-row temporary table and a ranked-row temporary table.

Schema v8 stores the serialized byte length beside each null `event_json` for
an oversized chunked row. This lets the boundary query size a selected chunked
event without reading `event_chunks`, and more importantly avoids reading any
chunk metadata for oversized rows excluded by the byte boundary. The existing
multi-statement chunk transaction performs one metadata update per chunked
batch; inline rows and their insert statements are unchanged. There is no
migration or compatibility path because rollout already requires erasing
Stream state.

Intermediate versions were rejected inside the experiment. Materializing both
selected and ranked relations made sparse misses faster but regressed dense
byte-cut scans by 8.6%. A non-materialized version that retained a scalar
chunk-table length query made the chunked byte-cut control about 87% slower
because the planner evaluated the scalar twice. A split inline/chunk relation
also regressed the chunked control by about 90%. No part of those shapes
remains.

### Workers Result

- Candidate: final query on exact parent `1168a8b98`.
- Baseline: exact parent `1168a8b98`.
- One hundred measured fresh streams and two warmups per revision. Every
  stream seeded 7,999 durable selector misses outside the timer, then timed an
  awaited deliver-all cross-post configuration whose own fact became raw row
  8,000. The synchronous no-match drain acknowledged the configuration before
  the RPC returned; an untimed runtime-state read proved the cursor reached
  that offset and an untimed destination read proved no event was copied.
- Only one Workers stack was active at a time. Collection ended at
  `2026-07-14T00:45:55Z` after restarting the candidate so every measured
  Durable Object initialized schema v8.

The Node timer enclosed the awaited configuration RPC, so the result does not
depend on a Worker isolate clock advancing without network I/O.

| Metric                     |    Parent | Candidate | Change |
| -------------------------- | --------: | --------: | -----: |
| p50                        | 15.044 ms | 13.998 ms |   7.0% |
| p95                        | 30.555 ms | 21.246 ms |  30.5% |
| mean                       | 16.889 ms | 15.292 ms |   9.5% |
| p50 scanned-row throughput |  531.8k/s |  571.5k/s |  +7.5% |

Both revisions experienced host/runtime outliers during the extended run;
the baseline maximum was 104.4 ms and the final candidate maximum was 41.9 ms.
The larger sample therefore confirms that the normal-path improvement does not
hide a p95 or mean cost.

### Exact-Method Guard

A disposable `node:sqlite` control invoked the exact production
`scanPushEventTypesFrame()` implementation against 8,000 stored rows. Five
alternating processes per revision ran five warmups before each case. Values
below are medians of the five per-process statistics.

| Frame shape                        | Parent p50 | Candidate p50 | P50 change | Parent p95 | Candidate p95 | P95 change |
| ---------------------------------- | ---------: | ------------: | ---------: | ---------: | ------------: | ---------: |
| No selected rows, 500 samples      |   1.892 ms |      0.684 ms |      63.8% |   2.006 ms |      0.768 ms |      61.7% |
| All inline selected, byte cut, 100 |   4.433 ms |      4.013 ms |       9.5% |   4.643 ms |      4.148 ms |      10.7% |
| All inline selected, hydrated, 20  |  17.055 ms |     16.391 ms |       3.9% |  19.921 ms |     19.652 ms |       1.4% |
| 63 chunked selected, byte cut, 50  |   1.276 ms |      0.185 ms |      85.5% |   1.333 ms |      0.199 ms |      85.1% |

The five-round median means improve 63.2%, 9.4%, 3.4%, and 85.6%
respectively. The query therefore removes sparse work without transferring
cost to dense frames.

An exact-method append control timed 60 sequential 520 KiB chunked inserts per
process, including serialization and the SQLite transaction, across the same
five alternating processes. Median-of-five p50 was 0.708 ms on the parent and
0.711 ms on schema v8, a 0.4% cost; mean was unchanged at 0.756 ms and p95
improved from 1.197 ms to 1.137 ms. The added metadata update is neutral within
host noise while enabling the 85% chunked boundary-scan improvement.

### Correctness And Cost

The method remains synchronous and one-statement, retains the multi-type
`json_each(?)` predicate, and changes no storage engine, RPC contract, or
cursor policy. Schema v8 adds one nullable integer and no migration path;
production code is net +24 lines. A deterministic 100-case model comparison
covers offset gaps, an eviction floor, unevicted ephemeral rows, one- and
two-type selectors, raw limits, exact captured-head advancement, and byte cuts.
Existing tests separately retain oversized first-event hydration, prove the
cached chunked length equals stored chunk bytes, and cover exact raw limits and
empty-after-eviction cases.

Raw Workers records are in `/tmp/sparse-frame-parent-long.log` and
`/tmp/sparse-frame-schema8-candidate-long.log`. The five host controls are in
`/tmp/frame-schema8-{parent,candidate}-{1..5}.log`; chunked append controls are
in `/tmp/chunked-append-schema8-{parent,candidate}-{1..5}.log` for the life of
this workstation.

## 2026-07-14: One MiB Inline Event Ceiling

### Change

Event storage previously reused the 512 KiB chunk-row size as the inline-value
ceiling. A serialized 513 KiB event therefore required an explicit SQLite
transaction, a null metadata row, a length update, and two chunk rows even
though workerd permits much larger values. Workerd sets `SQLITE_LIMIT_LENGTH`
to 2,200,000 bytes and its storage test documents the public limit as 2 MB.

The retained change separates the policies: serialized event JSON through
1 MiB stays in `events.event_json`, while values above 1 MiB still split into
512 KiB `event_chunks`. The pending serialization budget and carried-value
budget remain 1 MiB, so peak buffered JSON does not increase. Schema v8, all
read shapes, and the RPC surface are unchanged. The production diff is
`+9/-7` lines.

The cumulative benchmark gained an opt-in 768 KiB append/replay lane. It also
supplies an admin-owned `prj_...` fixture ID so local benchmark creation does
not depend on the separately deployed dev auth service being at the same
revision as OS.

### Exact Host Result

A disposable `node:sqlite` harness called exact production `insert()`,
`getByOffset()`, and `getRangeSized()` implementations from parent and
candidate modules. Five alternating fresh processes per revision measured 40
appends and 80 reads after warmup. Each process stored 45 events and asserted
that the parent created 90 chunks while the candidate created none. Values are
medians of the five per-process statistics.

| Operation          | Parent p50 | Candidate p50 | P50 change | Parent p95 | Candidate p95 | P95 change |
| ------------------ | ---------: | ------------: | ---------: | ---------: | ------------: | ---------: |
| Append 768 KiB     |   0.998 ms |      0.865 ms |      13.3% |   1.629 ms |      1.124 ms |      31.0% |
| Point read 768 KiB |   1.092 ms |      0.368 ms |      66.3% |   1.424 ms |      0.584 ms |      59.0% |
| Range read 768 KiB |   1.108 ms |      0.371 ms |      66.5% |   1.491 ms |      0.569 ms |      61.8% |

Median means improve 16.6%, 65.3%, and 66.6%, respectively.

### Workers Result

- Candidate: the threshold change on exact parent `e05e3df13`.
- Baseline: exact parent `e05e3df13`.
- Five full rounds per revision in `P,C,C,P,P,C,C,P,P,C` order, with only one
  Workers stack active. Every round used three warmups and 20 measured samples
  for append and replay, fresh project/stream paths, and full semantic checks.
- Collection ended at `2026-07-14T01:16:50Z`. Host `performance.now()` timers
  enclosed awaited RPCs and complete replay responses; no isolate clock was
  used.

| Operation          | Metric |    Parent | Candidate | Change |
| ------------------ | ------ | --------: | --------: | -----: |
| Append 768 KiB ack | p50    | 21.970 ms | 17.470 ms |  20.5% |
|                    | p95    | 35.650 ms | 27.805 ms |  22.0% |
|                    | mean   | 21.839 ms | 17.011 ms |  22.1% |
| Replay 768 KiB     | p50    |  4.826 ms |  4.305 ms |  10.8% |
|                    | p95    |  6.047 ms |  5.801 ms |   4.1% |
|                    | mean   |  4.937 ms |  4.314 ms |  12.6% |

Median-p50 append throughput rises from 45.5 to 57.2 events/s, **+25.8%**.
Unaffected controls stayed neutral: 1 KiB append +1.0%, 100-event append
+4.0%, 256 KiB append +1.5%, dense read -1.2%, and hot head +1.7%.

### Correctness And Cost

The 1 MiB row plus its small metadata remains well below workerd's 2.2 MB
SQLite limit. A new storage test proves a 768 KiB payload is inline and a
1.1 MiB payload remains a three-row chunked value; every existing chunk,
rollback, Unicode, idempotency, eviction, and sparse-frame test fixture was
kept above the new boundary where its behavior depends on chunking.

This adds one constant and no schema, migration, timer, queue, cache, protocol,
or recovery branch. Rollback is trivial: lower the constant. Existing rows can
already mix inline and chunked representations, so neither direction requires
rewriting storage. Raw host records are in
`/tmp/inline-threshold-{baseline,candidate}-host.log`; Workers records are in
`/tmp/inline-threshold-workers-{baseline,candidate}.log` for the life of this
workstation.

## 2026-07-14: Post-Merge Hot-Path Controls And Queue

Three pre-production micro-prototypes were rejected before they added a
permanent branch:

- Removing cross-post receiver validation and an object spread saved about
  0.0001 ms for one event and 0.0046 ms for 100 events on the host. RPC cost
  would dominate it.
- Storing inline JSON as SQLite TEXT instead of BLOB was neutral: singleton
  inserts were about 7% slower, 100-event batches about 3% faster, and the
  production-equivalent `cast(event_json as text)` read was flat.
- Mutating the parsed storage object to restore `path` instead of spreading it
  saved about 0.006 ms over 500 4 KiB rows, below 1%.

The next measured candidates, in priority order, are:

1. Split the core checkpoint schedule: retain a 64-event restored-lag bound
   but checkpoint a clean warm incarnation every 501 events. This may remove
   full-state KV writes from most 100/500-event appends without changing the
   journal commit point. It requires dirty-eviction and clean-teardown cycle
   benchmarks because the one-second condition is only opportunistic under
   workerd's frozen clock.
2. Flatten selected historical frames into parallel event/byte-length arrays.
   An 8,000-event frame would avoid about 8,000 wrapper objects, two temporary
   arrays, and four traversals without changing SQL or retry semantics.
3. Bind guaranteed-inline JSON strings through `cast(? as blob) returning
length(event_json)` to test whether workerd can avoid `TextEncoder` output.
   This is lower priority because returned rows may cost more than the removed
   allocation.

The proposed legacy KV storage rewrite remains deprioritized. Current evidence
continues to favor synchronous SQLite: its commit/output-gate semantics are the
correctness boundary, and the retained wins came from reducing statements,
materialization, and redundant work rather than taking over flush scheduling.

## 2026-07-14: Rejected Split Checkpoint Cadence

### Hypothesis

Keep the restored-lag ceiling at 64 events, but let a clean warm incarnation
trail its disposable core-state checkpoint by up to 500 events. The journal
would remain the commit truth, while fewer full-state KV writes could make
100-event append batches faster. Idle teardown and alarms would still flush a
clean shutdown; an abrupt restart would fold the bounded journal tail.

The prototype used a 501-event warm threshold, switched back to the 64-event
threshold whenever activation restored nonzero lag, and returned to the warm
threshold only after that lag had been checkpointed. Focused tests covered 500
warm events, the 501st event, and the restored-63-plus-one boundary.

### Workers Result

- Baseline: exact parent `b3f1c45ed`; candidate: the split cadence on that
  parent.
- Five full rounds per revision in `P,C,C,P,P,C,C,P,P,C` order, with one
  Workers stack active at a time.
- Each lifecycle metric used two warmups and ten measured fresh streams per
  round. Every stream appended five acknowledged 100-event batches, then
  forced either abrupt reactivation or clean idle teardown and reactivation.
  The cold read asserted all 500 markers survived.
- Host `performance.now()` enclosed every awaited RPC and teardown call. The
  benchmark does not depend on a Worker clock advancing during synchronous
  storage work.

Values are medians of the five per-round p50, p95, and mean statistics.

| Lifecycle metric       | Statistic |    Parent | Candidate | Change |
| ---------------------- | --------- | --------: | --------: | -----: |
| Dirty hot five batches | p50       | 19.307 ms | 18.235 ms |   5.5% |
|                        | p95       | 26.443 ms | 24.573 ms |   7.1% |
|                        | mean      | 19.955 ms | 18.249 ms |   8.5% |
| Dirty cold head        | p50       |  3.187 ms |  3.495 ms |  -9.6% |
|                        | p95       |  3.770 ms |  6.656 ms | -76.6% |
|                        | mean      |  3.164 ms |  4.074 ms | -28.8% |
| Dirty total cycle      | p50       | 26.709 ms | 25.918 ms |   3.0% |
|                        | p95       | 33.188 ms | 32.256 ms |   2.8% |
|                        | mean      | 27.338 ms | 26.036 ms |   4.8% |
| Clean total cycle      | p50       | 27.111 ms | 26.420 ms |   2.5% |
|                        | p95       | 33.789 ms | 34.432 ms |  -1.9% |
|                        | mean      | 27.629 ms | 28.033 ms |  -1.5% |

The standalone 100-event append control improved 6.9% p50 and 7.4% throughput,
confirming the intended hot-path effect. The end-to-end gain did not survive
the work transfer: dirty total-cycle p50 improved only 3.0%, clean-cycle mean
regressed 1.5%, and dirty cold-head p95 regressed 76.6%. This misses the 5%
total-cycle retention gate and creates a materially worse crash-recovery tail.

### Decision And Retained Artifact

Reject the production schedule change and its new branches. The Stream keeps
the single 64-event bound, so production complexity and recovery behavior are
unchanged.

Retain the opt-in `STREAM_BENCH_CHECKPOINT_CYCLE_SAMPLES` benchmark lane. It
measures acknowledged hot appends, forced dirty reactivation, explicit clean
idle flush, cold head, and both total cycles while proving all event markers
survive. It is test-only and dormant in normal cumulative runs. Future
checkpoint experiments now have a lifecycle-level gate instead of relying on
an append microbenchmark. Raw records are in
`/tmp/checkpoint-workers-{parent,candidate}.log` for the life of this
workstation.

The next production experiment is historical-frame flattening: remove wrapper
objects and redundant traversals after the retained sparse SQL query, then
measure dense and sparse replay separately before changing storage or RPC
contracts.

## 2026-07-14: Rejected Historical-Frame Flattening

The prototype changed only selected historical frames from
`{event, byteLength}[]` wrappers to aligned `events[]` and
`eventByteLengths[]`. It accumulated bytes in the storage row pass, removed the
normal-path `filter()` and `reduce()`, and removed both delivery-reader `map()`
passes. Missing chunk rows triggered lockstep in-place compaction; chunk lengths
still came from SQL's full-envelope metadata, scan progress remained SQL-owned,
and returned event arrays remained isolated from cached projections.

A disposable exact-method `node:sqlite` harness included the complete
synchronous section: the retained production SQL, 8,000-row scan, JSON parse,
frame construction, and delivery projection. Five fresh processes per shape
ran five warmups before measurement. Values are medians of per-process
statistics.

| Frame shape                 | Metric |   Parent | Candidate | Change |
| --------------------------- | ------ | -------: | --------: | -----: |
| 4,000 of 8,000 selected     | p50    | 8.610 ms |  8.484 ms |   1.5% |
|                             | p95    | 9.490 ms |  9.705 ms |  -2.3% |
|                             | mean   | 8.708 ms |  8.599 ms |   1.2% |
| No selected rows            | p50    | 0.686 ms |  0.681 ms |   0.7% |
| First selected row byte-cut | p50    | 2.604 ms |  2.652 ms |  -1.8% |

The entire OS unit suite passed with the prototype (1,555 tests), but parsing
and SQLite dominate the dense frame. A 1.5% p50 gain with a p95/control cost is
below the retention threshold and does not justify a parallel-array contract
plus corruption-only compaction branch. The production and test changes were
removed completely. Raw host records are in
`/tmp/frame-flatten-{baseline,candidate}.log` for the life of this workstation.

Next is the lower-risk bind experiment: test whether binding inline JSON text
through `cast(? as blob)` plus `returning length(event_json)` can remove the
eager `TextEncoder` allocation without making insertion or returned-row work
slower. It remains a micro-optimization and will be rejected unless exact
append controls show a clear gain.

## 2026-07-14: Rejected Inline Text Bind And Returned Length

The prototype avoided `TextEncoder` for singleton event JSON between 16 KiB
and one third of the 1 MiB inline ceiling. The upper code-unit bound guarantees
the value remains inline under worst-case UTF-8 expansion. SQLite received the
string through `cast(? as blob)` and returned `length(event_json)`, preserving
BLOB storage and exact full-envelope sizing. Tiny, batched, uncertain-size,
and chunked values retained the existing byte-binding path.

Five exact-method `node:sqlite` processes per revision showed the expected
allocation crossover:

| Append shape         | Parent p50 | Candidate p50 | Change |
| -------------------- | ---------: | ------------: | -----: |
| Singleton 1 KiB      |  0.0057 ms |     0.0060 ms |  -5.1% |
| Singleton 32 KiB     |  0.0401 ms |     0.0316 ms |  21.1% |
| Singleton 256 KiB    |  0.2866 ms |     0.1670 ms |  41.7% |
| Unicode 1 KiB        |  0.0088 ms |     0.0092 ms |  -4.2% |
| 100-event tiny batch |  0.1253 ms |     0.1225 ms |   2.2% |

The Workers test was decisive. Five full rounds per revision ran against the
exact production parent in `P,C,C,P,P,C,C,P,P,C` order, with 120 measured 1
KiB appends and 30 measured 100-event batches per round; the existing 256 KiB
lane contributed 20 samples per round. Host timers enclosed awaited append
RPCs.

| Workers append shape | Parent p50 | Candidate p50 | P50 change | Parent p95 | Candidate p95 |
| -------------------- | ---------: | ------------: | ---------: | ---------: | ------------: |
| Singleton 1 KiB      |   2.159 ms |      2.215 ms |      -2.6% |   3.121 ms |      3.267 ms |
| Singleton 256 KiB    |   7.946 ms |      8.346 ms |      -5.0% |  12.124 ms |     12.334 ms |
| 100-event tiny batch |   5.147 ms |      5.149 ms |       0.0% |   8.548 ms |      9.056 ms |

The 256 KiB mean also regressed 3.9%. Workerd's cast and returned-row cost
exceeds the removed encoding allocation, so the host win does not transfer to
the deployed runtime. The entire prototype was removed; production retains one
serialization representation and no size-dependent SQL branch. Raw host logs
are `/tmp/inline-cast-{baseline,hybrid}.log`; Workers logs are
`/tmp/inline-cast-workers-{parent,candidate}.log` locally.

Together with the checkpoint and frame-shape results, this closes the current
micro-optimization queue. The next work should return to profiles and target a
larger statement, RPC, or lifecycle cost rather than another sub-millisecond
allocation.

## 2026-07-14: Third Cumulative Main Comparison

### Revisions And Method

- Candidate: `742ff34865f7cad6aec3ee6033e2419148f6463e`
- Baseline: `2f25f617a9edc46406be6e4827405704d4b795ab`
  (`origin/main`, fetched immediately before and after collection)
- Five full rounds per revision in `M,C,C,M,M,C,C,M,M,C` order, restarting
  between revisions so only one Workers stack was active at a time. One final
  candidate stack failed to boot and produced no samples; its clean
  replacement round on a fresh port is the recorded fifth candidate round.
- Collection ended at `2026-07-14T01:54:37Z`. If this optimization run remains
  active, the next cumulative comparison is due by `2026-07-14T05:54:37Z`.

The branch-hosted harness again selected equivalent public operations across
the two API generations. Every measured interval ran in Node around awaited
RPC, consumed stream output, or host-observed delivery, and every round
asserted the resulting durable state. No latency depends on a Worker isolate
clock advancing while workerd has no network I/O in flight. Singleton append
used 120 samples and the 100-event batch used 30; the other normal lanes kept
their established sample counts.

### Results

Each value is the median of the five per-round statistics. Positive change
means the candidate used less wall time.

| Workload                                       |  Main p50 | Candidate p50 | P50 change |  Main p95 | Candidate p95 | P95 change |
| ---------------------------------------------- | --------: | ------------: | ---------: | --------: | ------------: | ---------: |
| Append one 1 KiB event, discard result         |  2.590 ms |      2.204 ms |      14.9% |  5.261 ms |      3.602 ms |      31.5% |
| Append 100 tiny events in one call             |  8.162 ms |      5.193 ms |      36.4% | 12.191 ms |      9.087 ms |      25.5% |
| Append 32 concurrent singleton calls           | 10.905 ms |      9.344 ms |      14.3% | 15.370 ms |     20.472 ms |     -33.2% |
| Append one 256 KiB event, discard result       | 10.306 ms |      8.318 ms |      19.3% | 17.869 ms |     12.550 ms |      29.8% |
| Retry one acknowledged 256 KiB event           |  3.458 ms |      2.322 ms |      32.9% |  5.005 ms |      3.217 ms |      35.7% |
| Read a hot stream head                         |  0.608 ms |      0.490 ms |      19.4% |  0.853 ms |      0.622 ms |      27.1% |
| Read 500 dense 4 KiB events                    | 14.534 ms |     12.918 ms |      11.1% | 22.430 ms |     19.350 ms |      13.7% |
| Read 20 selected events from 2,000             |  0.800 ms |      0.733 ms |       8.5% |  2.312 ms |      2.010 ms |      13.1% |
| Read latest selected event                     |  0.744 ms |      0.567 ms |      23.8% |  0.989 ms |      0.765 ms |      22.6% |
| Replay 500 128-byte events into a subscription |  7.303 ms |      5.273 ms |      27.8% | 10.971 ms |      8.375 ms |      23.7% |
| Append through delivery to one live subscriber |  1.324 ms |      1.067 ms |      19.4% |  3.880 ms |      3.411 ms |      12.1% |
| Append through delivery to 25 live subscribers |  4.837 ms |      4.402 ms |       9.0% |  5.996 ms |      5.408 ms |       9.8% |
| Dense one-event durable cross-post             |  3.866 ms |      3.052 ms |      21.1% |  6.414 ms |      4.901 ms |      23.6% |
| Sparse durable cross-post, 1 of 100 events     |  5.752 ms |      4.432 ms |      23.0% | 10.163 ms |      8.661 ms |      14.8% |
| Head read after forced reactivation            |  2.322 ms |      2.128 ms |       8.4% |  4.112 ms |      4.663 ms |     -13.4% |

The equal-workload geometric mean is **19.7% lower p50**, **17.3% lower p95**,
and **21.0% lower mean latency**. All 15 p50s improve by 8.4% to 36.4%, and
all 15 means improve by at least 6.0%. Thirteen p95s improve by 9.8% to 35.7%.
The concurrent-append p95 is genuinely noisy across candidate rounds
(`11.710` to `42.344` ms) and its median regresses 33.2%; cold reactivation p95
regresses 13.4%. Neither tail cost is hidden by the strong central result.

Median-p50 capacity translates as follows:

- 100-event append rises from 12.3k to 19.3k events/s, **+57.2%**.
- 32 concurrent singleton appends rise from 2.9k to 3.4k calls/s, **+16.7%**.
- 500-event replay rises from 68.5k to 94.8k events/s, **+38.5%**.
- Sparse 1-of-100 cross-post input rises from 17.4k to 22.6k events/s,
  **+29.8%**.

This is a whole-branch comparison, not a sum of experiment percentages. It
closely repeats the second comparison's 21.0% p50, 15.4% p95, and 22.8% mean
result after another main merge and the sparse-read and 1 MiB-inline changes.
The cumulative gain is therefore stable; the new retained work did not turn
the branch into a benchmark-specific local maximum.

### Cost And Collapse Assessment

Before this entry, the branch-versus-main diff remained 99 files. Production
was `+4,724/-1,386` lines (net `+3,338`), tests and e2e were
`+7,303/-1,049` (net `+6,254`), generated APIs were `+150/-44`, and docs were
`+1,233/-35`. Relative to the second exact comparison, production net growth
is only 26 lines; most subsequent growth is benchmark coverage and the durable
decision record. The four large stateful implementation files now total 3,970
lines.

The system still collapses operationally: one Stream Durable Object, one
SQLite database, normal Workers RPC, no additional service, queue, timer,
coordinator, or storage engine. The retained sparse query and larger inline
threshold reuse existing schema and frame abstractions. Rejected checkpoint,
parallel-frame, and text-bind prototypes left no production branches.

It does not yet collapse elegantly at source level. Net 3.3k additional
production lines and a 6.3k-line test delta encode retry identity, cursor
epochs, delivery framing, sparse selection, checkpoint recovery, and compact
RPC projections. Those mechanisms interact and should eventually be
reorganized behind fewer explicit state transitions. A destructive redesign
can remove migration and compatibility code, but deleting the mechanisms
without preserving their crash/retry properties would trade measured speed
for silent data loss or duplicate side effects.

The pragmatic shipping unit remains the current SQLite design plus its
executable constraints. Before production it still needs preview workload and
failure/retry soak, plus explicit destructive rollout and rollback approval.
The two p95 regressions should be included in that soak gate. Raw records are
`/tmp/cumulative-3-{main,candidate}.log` and corresponding `-full.log` files
for the life of this workstation.

## 2026-07-14: Third Cumulative Tail Confirmation

The two apparent tail regressions above came from 20-sample lanes, where this
harness's p95 index is the single maximum. A focused, still host-timed lane now
supports independently larger concurrent-append and forced-reactivation
sample counts without rerunning unrelated workloads.

Three rounds per revision ran 200 measured groups of 32 concurrent singleton
appends and 100 reactivations in `C,M,M,C,C,M` order. Values are medians of
per-round statistics:

| Workload                       | Metric |      Main | Candidate | Change |
| ------------------------------ | ------ | --------: | --------: | -----: |
| 32 concurrent singleton calls  | p50    | 10.722 ms |  8.007 ms |  25.3% |
|                                | p95    | 14.148 ms | 12.400 ms |  12.4% |
|                                | mean   | 11.288 ms |  8.792 ms |  22.1% |
| Head after forced reactivation | p50    |  2.444 ms |  2.044 ms |  16.4% |
|                                | mean   |  2.654 ms |  2.261 ms |  14.8% |

One further isolated round per revision used 1,000 forced reactivations. The
candidate improved p50 from `2.621` to `2.039` ms (22.2%), p95 from `3.675`
to `2.974` ms (19.1%), p99 from `7.703` to `6.979` ms (9.4%), and mean from
`2.737` to `2.202` ms (19.5%). Candidate maximum was worse (`22.827` versus
`9.164` ms), but that single host outlier did not persist in p99 across 1,000
complete kill-and-reactivate cycles.

This clears both suite-level tail warnings. It also rejects checkpoint-tail
work as the next optimization: there is no reproduced checkpoint regression
to pay complexity for. Raw records are `/tmp/stream-focused-{main,candidate}-r{1,2,3}.log`
and `/tmp/stream-cold1000-{main,candidate}-r1.log` locally.

## 2026-07-14: Direct Cross-Post Dial Rejected

Source review identified a plausible cross-post cost: each delivered batch
walked the generic itx capability path from the cached authority root through
`streams.get(path).acceptCrossPost(batch)`. A destructive prototype made
cross-post a fourth persisted delivery mode, stored only its normalized sibling
path, dialed the destination Stream Durable Object directly, and cached each
destination stub for the source isolate. It also removed the now-unneeded public
`Stream.acceptCrossPost` capability. The existing cursor claim, retry, alarm,
parking, staged acknowledgement, provenance, and destination-idempotency
machinery remained unchanged.

The implementation commit `46e18f461` changed 29 files (`+347/-226`): production
needed a core-state version bump and another delivery branch; generated APIs,
first-party bootstrap configs, UI state rendering, tests, and design docs all
had to understand the new mode. It passed full OS typecheck, lint, 384 focused
Stream/project/repo tests, the complete 1,556-test OS unit suite, and repeated
focused end-to-end delivery. That is still materially more source-level
complexity for what should be a transport fast path.

The host-timed benchmark enclosed `appendAck` plus observation at a live
subscriber on the destination stream, so no result depends on a Worker clock
advancing without network I/O. Each round measured 500 sequential one-event
cross-posts and 200 groups of 16 concurrent singleton appends. Candidate and
exact parent `47f8831f3` ran with only one Workers stack active at a time.

An initial five-round aggregate misleadingly suggested a retainable result:
dense p50 appeared 7.7% lower and 16-way throughput 5.6% higher. A final
alternating `C,M,M,C,C,M` sequence did not reproduce it:

| Workload                   | Metric     |     Parent | Direct + cached | Change |
| -------------------------- | ---------- | ---------: | --------------: | -----: |
| Dense one-event cross-post | p50        |   3.908 ms |        3.888 ms |   0.5% |
|                            | p95        |   5.985 ms |        6.476 ms |  -8.2% |
|                            | mean       |   4.092 ms |        4.129 ms |  -0.9% |
| 16 concurrent singletons   | p50        |  11.287 ms |       11.038 ms |   2.2% |
|                            | p95        |  14.641 ms |       15.526 ms |  -6.0% |
|                            | mean       |  11.542 ms |       11.322 ms |   1.9% |
|                            | throughput | 1,418 ev/s |      1,450 ev/s |   2.3% |

The generic Cap'n Web route is already pipelined from a cached authority root;
the hypothesized two serial intermediate round trips were not present as
independent host-visible costs. The remaining direct-dial saving is below
noise and its p95 moved the wrong way. The entire prototype was reverted by
`ed8076854`. Production keeps one push mode, one addressing grammar, and no
cross-post-only stub cache. Raw records are
`/tmp/stream-direct-crosspost-{candidate,parent}-r{1,2,3,4,5}.log`,
`/tmp/stream-direct-crosspost-cached-candidate-r{1,2,3,4,5,6,7}.log`, and
`/tmp/stream-direct-crosspost-parent-r{6,7,8}.log` locally.

## 2026-07-14: Windowed Hosted-Processor Settlement Retained

Cloudflare, Cap'n Web, and host-source review identified another asymmetric
RPC cost. The stream pump never awaits delivery, but it pulled every hosted
processor result to detect a dead callback. The returned processor sink is
strictly ordered and failure-sticky: one failed ingest poisons every later call
on that connection, and a replacement connection replays from the durable
checkpoint. A later pulled result can therefore act as a cumulative fence for
earlier unpulled calls without weakening ordered processing or replay.

The retained implementation pulls every eighth hosted-processor result and
always pulls the caught-up head batch. Generic durable callbacks remain
pull-per-batch. Intermediate result capabilities are disposed unpulled, while
their deliveries remain counted as pending until the cumulative fence settles;
idle teardown therefore cannot mistake queued processor work for consumed
work. The final fence reports its newest event's settle latency. A rejection
from any intermediate ingest is rethrown by the host's sticky fence and closes
the stream connection through the existing delivery-failed path.

The focused benchmark kills the project processor, appends 8,000 durable events
to the root stream in one awaited RPC, then awaits the processor checkpoint.
The host timer starts after an awaited head read and encloses both append and
checkpoint network I/O, so it remains valid under Workers' frozen-clock model.
An early version reused one project capability across repeated `kill()` calls
and eventually hit a Cap'n Web decode failure after the append had succeeded.
The final harness uses a disposable control connection for each kill and a new
post-kill project session for each measured append/wait, removing that
client-lifecycle race from the workload.

Three rounds per revision ran 15 measured backlogs in `C,M,M,C,C,M` order,
giving 45 samples per revision against exact parent `7765519ff`:

| 8,000-event processor catch-up |     Parent |   Window 8 | Change |
| ------------------------------ | ---------: | ---------: | -----: |
| p50                            | 1,319.4 ms | 1,191.4 ms |   9.7% |
| p95                            | 1,495.4 ms | 1,425.2 ms |   4.7% |
| mean                           | 1,228.0 ms | 1,160.4 ms |   5.5% |
| median throughput              | 6,064 ev/s | 6,715 ev/s |  10.7% |

A second 45-sample tuning pass tried a four-batch fence. It retained only a
6.5% median-throughput gain (`1,238.5` ms p50), so the second result frame had
a measurable cost and window eight was restored. The final live smoke passed
after restoration.

This adds one counter, one pending-delivery accumulator, and one hosted-only
policy constant; it creates no storage state, migration, service, alarm, or
new recovery mode. The complexity is local and collapses back to pull-per-call
by setting the window to one. Focused tests cover periodic success, a quiet
partial window, and an unpulled intermediate failure reaching the fence. The
entire 371-test Stream unit surface and OS typecheck pass. Raw records are
`/tmp/stream-window8-{candidate,parent}-isolated-r{1,2,3}.log` and
`/tmp/stream-window4-candidate-isolated-r{1,2,3}.log` locally.

## 2026-07-14: Legacy KV Event Store Rejected Before Rewrite

The suggested lower-level storage experiment has two distinct meanings that
must not be conflated. `ctx.storage.kv` is the synchronous structured-clone
facade over the same SQLite database as `ctx.storage.sql`; it has no manual
flush control. True legacy Durable Object KV is a different namespace backend
using the asynchronous `ctx.storage.get/put/list/delete` API. Only that async
API exposes `allowUnconfirmed` and `storage.sync()`.

For a correct append acknowledgement, `allowUnconfirmed` cannot be used: it
allows the RPC result to escape before persistence. The benchmark therefore
discards the async write promises to preserve automatic write coalescing but
keeps the default output gate. The host's awaited RPC still returns only after
the writes are durable. Adding `await storage.sync()` would only yield and wait
for already-scheduled writes, not expose a separate lower-level flush primitive.

An opt-in dynamic-worker benchmark now compares three production-shaped
representations in exact installed workerd `1.20260701.1`:

- batched SQL rows using the Stream log's 98-row derived keyless insert shape;
- synchronous `storage.kv`, one structured-clone upsert per event;
- the async KV API, using up to 128 entries per `put()` and no intervening
  await, which is the application path a legacy-KV class would use.

All methods return counts/checksums. Node timers enclose complete RPCs, backend
order rotates per sample, and setup/reset stays outside measured intervals.
Five rounds contributed 100 samples per normal lane and 40 eviction samples.
Positive percentages below mean KV was slower than SQL.

| Workload                     |  SQL p50 | Sync KV vs SQL | Async KV vs SQL | Async KV p95 change |
| ---------------------------- | -------: | -------------: | --------------: | ------------------: |
| Append one 1 KiB event       | 0.978 ms |          +4.7% |           +5.1% |              +25.2% |
| Append 100 tiny events       | 1.156 ms |          +9.6% |          +10.7% |              -16.0% |
| Append 1,000 tiny events     | 2.425 ms |         +15.9% |          +32.3% |               +4.8% |
| Append 100 1 KiB events      | 1.300 ms |         +28.5% |          +35.0% |              +31.3% |
| Append 100 keyed tiny events | 1.517 ms |         -17.8% |          -14.3% |              -25.7% |
| Read 1,000 events            | 1.390 ms |          +3.7% |          +11.0% |              +12.4% |
| Select 10 of 1,000 events    | 1.097 ms |         +25.3% |          +34.3% |              +33.1% |
| Evict 1,000 events           | 1.924 ms |         +56.9% |          +22.5% |             +102.3% |

The async path's one real win is fully keyed batch append: p50 is 14.3% lower,
p95 25.7% lower, and mean 13.0% lower because a multi-key put efficiently
coalesces event and secondary-index keys. That does not offset regressions on
ordinary keyless ingestion, replay, sparse selection, and eviction. Point
offset/idempotency reads and 100-row dense reads are effectively tied.

Local workerd uses SQLite to emulate every Durable Object backend and merely
controls whether SQL is exposed, so this cannot predict Cloudflare's production
legacy-KV persistence latency. It is still a valid rejection gate for JS
serialization, RPC, API, index-layout, and algorithm costs, and it fails that
gate before a production preview is warranted.

A literal legacy rewrite also fails the collapse test. Its 128 KiB value limit
would force a new chunk format for the existing 256 KiB and 768 KiB workloads;
idempotency and type selection need application-maintained secondary keys;
sparse replay must deserialize raw rows in JS; and floor advancement, cursor
updates, and set deletion lose SQL's atomic set operations. It requires a new
`legacy-kv` class/namespace rather than a local implementation switch. Even
with production erasure allowed, this is substantially more machinery for a
measured ordinary-path regression, so no rewrite was built.

The retained harness is
`e2e/vitest/storage-kv-sql-benchmark.e2e.test.ts`. Raw 100-sample records are
`/tmp/stream-storage-surfaces-r{1,2,3,4,5}.log`; the earlier sync-only
calibration is `/tmp/stream-storage-kv-sql-r{1,2,3}.log` locally.

## 2026-07-14: Larger Hosted-Processor Request Frames Rejected

The retained eight-batch settlement fence removes seven of eight processor
return frames, but an 8,000-event catch-up still sends eight 1,000-event
request frames. A prototype gave configured hosted processors the existing
internal push envelope of 8,000 rows or 4 MiB while leaving ephemeral/browser
connections at 1,000 rows or 1 MiB. This needed no new state or recovery path,
but raised per-connection peak frame memory and moved hosted delivery closer to
the transport ceiling.

Focused unit coverage proved an 8,000+500 row catch-up became two processor
calls. Sparse replay remained byte bounded, and its empty-page coalescing tests
continued to exercise the same eight-page fence. All 124 focused subscriber and
batch-math tests passed.

The same host-timed workload as the settlement experiment compared the working
prototype with exact parent `8508179ea`. Three successful rounds per revision
ran 15 measured 8,000-event kill/reactivate backlogs in reverse order, for 45
samples per side:

| 8,000-event processor catch-up | 1,000-row parent | 8,000-row frame | Change |
| ------------------------------ | ---------------: | --------------: | -----: |
| p50                            |       1,273.1 ms |      1,267.8 ms |   0.4% |
| p95                            |       1,452.8 ms |      1,434.1 ms |   1.3% |
| mean                           |       1,233.2 ms |      1,175.9 ms |   4.6% |
| median throughput              |       6,284 ev/s |      6,310 ev/s |   0.4% |

One additional candidate round failed after several kill/reactivate cycles in
Cap'n Web decoding while the server reported the expected dead old callback
and an immediate `waitUntilEvent` error. Restarting the candidate server made
the complete round pass, so this does not prove a 4 MiB internal frame corrupts
the transport. It does remove any basis for accepting a memory/risk increase
whose median effect is otherwise noise.

The result also localizes the retained window-eight gain: after return-frame
settlement is amortized, the seven remaining request dispatches are not the
dominant end-to-end catch-up cost. The prototype and its test changes were
reverted. Raw successful records are
`/tmp/stream-frame8000-{candidate,parent}-r{1,2}.log`, candidate round three is
`/tmp/stream-frame8000-candidate-r3b.log`, parent round three is
`/tmp/stream-frame8000-parent-r3.log`, and the failed candidate attempt is
`/tmp/stream-frame8000-candidate-r3.log`.

## 2026-07-14: Immediate Processor Redial Retained

The rejected request-frame experiment localized the remaining processor
catch-up delay away from event serialization and request dispatch. Appending
8,000 tiny events took tens of milliseconds, yet the processor checkpoint
usually landed about 1.2 seconds later regardless of whether delivery used one
or eight request frames. Server logs showed the first call reaching the stale
processor callback left by `project.kill()`, failing with `The execution context
which hosts this callback is no longer running`, and then waiting for the
shared one-second first-failure backoff before dialing the replacement host.

Implementation commit `acfeb4678` removes that eviction tax without classifying
errors by message. A durable wake-sink failure persists attempt one with
`nextAttemptAt = now`, arms that same timestamp as a crash-safe durable alarm,
then closes the dead connection. The close's ordinary reconciliation can dial
a replacement immediately. A successful handshake does not reset the failure
streak unless its checkpoint progressed, so a replacement host that rejects
the same event records attempt two and enters the existing jittered exponential
backoff. Poke failures, push and webhook failures, later wake failures, the
15-attempt parking threshold, resume, and checkpoint-progress reset are
unchanged.

That ordering matters for correctness. Persisting the nack before close stops
the replacement handshake from erasing the attempt. Arming the zero-delay alarm
means an eviction between the write and close cannot strand the retry. Multiple
result rejections from the old settlement window cannot multiply redials: the
first closes and removes that connection; later callbacks find no current
connection. A deterministic application failure can therefore cause at most
one optimistic redial before backoff, rather than an unbounded RPC-rate loop.

The same host-timed benchmark killed the project processor, read the root head,
appended 8,000 durable events, and awaited the processor checkpoint. Its Node
timer enclosed awaited append and wait RPCs, so no result depends on a Worker
clock advancing without network I/O. Three interleaved rounds per revision ran
15 measured backlogs each, for 45 samples against exact parent `0c653366b`:

| 8,000-event processor catch-up | Backoff parent | Immediate redial | Change |
| ------------------------------ | -------------: | ---------------: | -----: |
| p50                            |     1,248.4 ms |         309.7 ms |  75.2% |
| p95                            |     1,459.7 ms |         341.2 ms |  76.6% |
| mean                           |     1,208.7 ms |         309.3 ms |  74.4% |
| median throughput              |     6,408 ev/s |      25,830 ev/s |  +303% |

The candidate distribution was tight (`272.4-351.6` ms); the parent remained
bimodal because a few stale callbacks were detected before the backoff became
observable. The pooled median is a 4.03x throughput increase. This result also
explains why larger request frames did not help: after removing the artificial
retry plateau, actual append, redial, replay, processor state write, and
checkpoint observation together cost about 310 ms.

One attempted third parent round failed in Cap'n Web decoding after repeated
kill/reactivate cycles, as one frame experiment round had earlier. It produced
no samples, was excluded, and a complete replacement round passed after a clean
parent-server restart. The recurrence is a separate transport/lifecycle
correctness lead; it does not alter the immediate-redial comparison.

The production delta is one optional branch in the existing shared failure
machine and one zero-delay retry helper. It adds no schema, storage record,
timer kind, service, queue, coordinator, error taxonomy, or recovery mode, and
collapses by removing `immediateFirstRetry: true`. The 371-test Stream unit
surface, focused lint and format, and full OS TypeScript check pass. The wake
failure test proves immediate attempt one, delayed attempt two, parking under
sustained deterministic failure, and reset only after checkpoint progress.
Raw records are `/tmp/stream-immediate-redial-candidate-r{1,2,3}.log` and
`/tmp/stream-immediate-redial-parent-r{1,2,3b}.log`; the invalid parent attempt
is `/tmp/stream-immediate-redial-parent-r3.log` locally.

## 2026-07-14: ID-Only Durable Object Reactivation Fixed

The recurring Cap'n Web failure in the kill/reactivate benchmark was not a
malformed response frame. The client received a valid rejection, but the
server-side error was `Cannot read properties of undefined (reading
'length')`. A temporary guard moved that failure to an explicit `Durable Object
name is unavailable` error at the Project processor relay. Cloudflare's
`DurableObjectId.name` is optional, and workerd's `actor.h` exposes `getName()`
as an optional value. An RPC capability can preserve an object ID across
reactivation without preserving the name originally passed to `idFromName()`.

Every non-sandbox domain object had treated `ctx.id.name` as permanent. Project
reactivation through its returned processor capability therefore passed
`undefined` into the name codec, where the byte-length check produced the
misleading decoder-adjacent error. Stream had the same latent assumption, as
did Agent, Secret, Repo, Workspace, Scheduler, StatefulWorker, CapabilityHost,
and their name-derived paths or diagnostics.

The retained fix centralizes canonical identity in
`resolveDurableObjectName()`. On the first named activation it validates the
runtime name and stores one synchronous `ctx.storage.kv` identity value. Later
named activations read and require an exact match. ID-only activations recover
the stored value and still validate the name grammar. An ID-only first
activation, a malformed stored value, or an identity disagreement fails
closed. Sandbox keeps its existing explicit identity protocol, which already
handles the same runtime behavior.

The unfixed server failed three times in 119 observed kill/reactivation cycles,
at iterations 19, 78, and 20 in three independent runs. The read-validated fix
then completed 300 diagnostic cycles, 200 clean cycles, and 100 cycles against
the exact final code without a failure: 600/600 successful reactivations, each
including an 8,000-event append and processor checkpoint catch-up. The clean
200-cycle distribution was `297.3 ms` p50, `351.7 ms` p95, and `304.3 ms` mean;
the final 100 cycles were `302.8 ms`, `362.6 ms`, and `312.3 ms`. Host timers
enclosed the awaited append and checkpoint RPCs, so this evidence remains
valid under Workers' frozen-clock model.

Identity recovery pays only on object construction, never on an already-live
request path. Three 200-sample rounds against exact parent `9c1f38363` measured
the following forced Stream reactivation cost:

| Cold head after forced reactivation | Exact parent | Identity read |      Cost |
| ----------------------------------- | -----------: | ------------: | --------: |
| p50                                 |     2.134 ms |      2.395 ms | +0.261 ms |
| p95                                 |     3.235 ms |      4.060 ms | +0.825 ms |
| mean                                |     2.284 ms |      2.564 ms | +0.280 ms |

This is a deliberate correctness tax of about `0.28 ms` per cold activation.
An alternative wrote the runtime name on every named activation and read only
for ID-only activation. In a contemporaneous 600-sample check it moved p50 and
mean favorably but worsened p95 (`3.567 ms` versus parent `3.092 ms`) and would
silently overwrite a conflicting identity. That ambiguous timing result did
not justify weakening the invariant or adding unconditional storage churn, so
the read-and-compare shape was restored.

The production change is one generic helper, one small key per Durable Object,
and mechanical adoption in nine domain classes. It adds no service, alarm,
queue, schema migration, asynchronous turn, or request-state machine. It
collapses cleanly: removing the helper calls makes the identity keys inert.
There is intentionally no compatibility recovery for an old object whose
first post-deploy activation is ID-only and has no canonical key; rollout
therefore assumes the planned production data erase. Unit tests cover persist,
restore, mismatch, and missing identity. The 387-test name/Stream unit surface
and full OS TypeScript check pass. Raw stress records are
`/tmp/stream-kill-identity-recovery-r1.log` and
`/tmp/stream-kill-identity-recovery-{clean,final}.log`; cold-cost records are
`/tmp/stream-identity-cost-{candidate,parent}-r{1,2,3}.log` locally.

## 2026-07-14: Fourth Cumulative Main Comparison

### Revisions And Method

- Candidate: `6b9ddac113833f3818f854d6875804bd5c874f6b`
- Baseline: `2f25f617a9edc46406be6e4827405704d4b795ab`
  (`origin/main`, fetched immediately before and after collection)
- Five full rounds per revision in `M,C,C,M,M,C,C,M,M,C` order. The inactive
  server was stopped before every revision switch, so only one Workers stack
  was resident during collection.
- Collection ended at `2026-07-14T04:49:37Z`. If this optimization run remains
  active, the next cumulative comparison is due by `2026-07-14T08:49:37Z`.

The branch-hosted harness selected the cheapest equivalent public operation
available in each revision. Singleton append used 120 samples and 100-event
batch append used 30; all other lanes retained their established counts. Every
interval was measured in Node around an awaited RPC, fully consumed stream, or
host-observed delivery, and every workload asserted its durable result. No
measurement relies on a Worker isolate clock advancing without network I/O.

### Results

Each value is the median of the five per-round statistics. Positive change
means the candidate used less wall time.

| Workload                                       |  Main p50 | Candidate p50 | P50 change |  Main p95 | Candidate p95 | P95 change | Mean change |
| ---------------------------------------------- | --------: | ------------: | ---------: | --------: | ------------: | ---------: | ----------: |
| Append one 1 KiB event, discard result         |  2.527 ms |      2.386 ms |       5.6% |  4.262 ms |      4.096 ms |       3.9% |       13.0% |
| Append 100 tiny events in one call             |  7.478 ms |      5.523 ms |      26.1% | 13.023 ms |      9.605 ms |      26.2% |       26.7% |
| Append 32 concurrent singleton calls           | 10.852 ms |     10.024 ms |       7.6% | 17.177 ms |     17.020 ms |       0.9% |        1.8% |
| Append one 256 KiB event, discard result       |  9.359 ms |      9.306 ms |       0.6% | 17.157 ms |     14.381 ms |      16.2% |        8.6% |
| Retry one acknowledged 256 KiB event           |  3.303 ms |      2.348 ms |      28.9% |  5.254 ms |      3.156 ms |      39.9% |       36.4% |
| Read a hot stream head                         |  0.636 ms |      0.555 ms |      12.6% |  0.848 ms |      0.820 ms |       3.3% |       10.7% |
| Read 500 dense 4 KiB events                    | 14.373 ms |     12.711 ms |      11.6% | 22.477 ms |     18.801 ms |      16.4% |       12.4% |
| Read 20 selected events from 2,000             |  0.855 ms |      0.828 ms |       3.2% |  2.937 ms |      2.491 ms |      15.2% |        2.9% |
| Read latest selected event                     |  0.763 ms |      0.596 ms |      21.9% |  1.027 ms |      0.885 ms |      13.9% |       25.3% |
| Replay 500 128-byte events into a subscription |  7.328 ms |      6.053 ms |      17.4% |  9.382 ms |      8.555 ms |       8.8% |       12.0% |
| Append through delivery to one live subscriber |  1.345 ms |      1.086 ms |      19.3% |  4.513 ms |      3.854 ms |      14.6% |       13.1% |
| Append through delivery to 25 live subscribers |  4.792 ms |      4.605 ms |       3.9% |  6.193 ms |      6.171 ms |       0.4% |        2.8% |
| Dense one-event durable cross-post             |  3.640 ms |      3.347 ms |       8.1% |  6.662 ms |      8.136 ms |     -22.1% |      -13.7% |
| Sparse durable cross-post, 1 of 100 events     |  5.893 ms |      4.995 ms |      15.2% |  9.474 ms |     10.272 ms |      -8.4% |       14.1% |
| Head read after forced reactivation            |  2.448 ms |      2.391 ms |       2.3% |  4.847 ms |      5.289 ms |      -9.1% |       -8.1% |

The equal-workload geometric mean is **12.7% lower p50**, **9.2% lower p95**,
and **11.4% lower mean latency**. Eleven of 15 p50s improve by at least 5%; four
neutral lanes, including forced reactivation, fall below that threshold. The
candidate's batch-append p50 capacity rises from 13.4k to 18.1k events/s
(**+35.4%**), concurrent singleton capacity from 2.95k to 3.19k calls/s
(**+8.3%**), replay from 68.2k to 82.6k events/s (**+21.1%**), and sparse
cross-post input from 17.0k to 20.0k events/s (**+18.0%**).

This result is weaker than the third comparison's 19.7% p50, 17.3% p95, and
21.0% mean win against the same baseline SHA. The intervening immediate
processor redial is dormant in these lanes, while canonical identity recovery
deliberately adds a synchronous read on cold object construction. The latter
explains the forced-reactivation mean regression, but cannot explain broad
warm-path movement. Main and candidate absolute medians both changed across
the two collections, so this checkpoint does not attribute the entire
aggregate contraction to code. It does establish the conservative current
claim: the whole branch remains materially faster than current main, but by
roughly 9-13% across aggregate latency statistics in this run, not 17-21%.

Dense cross-post p95/mean, sparse cross-post p95, and forced-reactivation
p95/mean regress. The cross-post tails use only 20 or 30 samples per round and
are outlier-sensitive; they require focused confirmation before a shipping
decision. The cold mean regression is directionally consistent with the
separate 600-sample identity-cost experiment and is accepted as a correctness
tax unless activation-read coalescing can recover it without weakening the
identity invariant. The focused 8,000-event processor benchmark remains the
relevant evidence for immediate redial: 4.03x throughput with no changed
steady-state lane here.

### Cost And Collapse Assessment

At this SHA, the branch-versus-main diff is 106 files. Production code is
`+4,833/-1,429` lines (net `+3,404`), tests and e2e are `+8,188/-1,050` (net
`+7,138`), generated APIs are `+150/-44`, and docs are `+1,709/-35`. Since the
third comparison, net production growth is 66 lines, primarily the generic
Durable Object identity invariant; test and documentation growth records the
reactivation failure and focused processor evidence.

The runtime topology still collapses operationally: one Stream Durable Object,
one SQLite database, ordinary Workers RPC, and no new deployed service, queue,
coordinator, storage engine, or periodic timer. Rejected legacy-KV event
storage, larger frames, direct cross-post, checkpoint, and cast variants leave
no production mode switches. Identity recovery is one inert key per object and
immediate redial is one branch in the existing retry machine; either can be
reverted without converting persistent Stream data.

Source-level complexity is nevertheless high. The current speed and
correctness mechanisms span cursor epochs, retry identity, compact delivery
frames, sparse SQL selection, checkpoint recovery, teardown, and RPC
projections across large stateful modules. A destructive redesign can remove
all migration and compatibility paths, but consolidation must preserve the
executable crash, retry, ordering, and idempotency constraints. The shipping
decision should therefore treat the current branch as measured evidence and a
candidate implementation, not as proof that every retained abstraction is the
final one.

All ten cumulative test processes passed. Raw records are
`/tmp/cumulative-4-{main,candidate}-r{1..5}.log` locally.

## 2026-07-14: One Stream Activation KV Snapshot Rejected

Workerd implements each synchronous-KV `get()` as its own prepared point
query, has no synchronous multi-get, and implements `list()` as one range
query. A bounded prototype therefore replaced Stream's two construction-time
point reads (canonical Durable Object identity and `coreState`) with one fully
consumed `kv.list()` snapshot. Unknown keys were ignored, the raw snapshot was
released after construction, and checkpoint/name validation was unchanged.

The source-level statement count fell from two to one, but real workerd did not
benefit. Three 200-reactivation rounds per revision ran in `C,P,P,C,C,P` order
against exact parent `6666feede`, stopping the inactive server at each switch.
Both revisions used the candidate `head()` API so the measurement differed
only in activation storage reads. Host timers enclosed the awaited head RPC,
and each iteration asserted the durable offset.

| Forced Stream reactivation | Two point reads | One list snapshot | Change |
| -------------------------- | --------------: | ----------------: | -----: |
| Median-of-round p50        |        2.273 ms |          2.312 ms |  -1.7% |
| Median-of-round p95        |        3.399 ms |          3.918 ms | -15.3% |
| Median-of-round mean       |        2.371 ms |          2.493 ms |  -5.2% |
| Pooled p50                 |        2.363 ms |          2.377 ms |  -0.6% |
| Pooled p95                 |        3.767 ms |          3.931 ms |  -4.4% |
| Pooled mean                |        2.554 ms |          2.604 ms |  -1.9% |

The list iterator and JavaScript key/value pair allocation absorb the saved
statement dispatch. The candidate also had the worse maximum (`18.870 ms`
versus `10.617 ms`). An earlier smoke round looked favorable, which is why the
alternating exact-parent pool was required. Two initial parent rounds were
discarded before analysis after noticing that harness `main` mode called the
larger legacy `runtimeState()` projection; they were rerun through `head()` and
do not contribute to the table.

The acceptance gate required at least 5% p50 and mean improvement with no p95
regression. It failed every part, so the activation helper, prefetched identity
option, constructor plumbing, and tests were all removed. Production and
persistent data are exactly unchanged. Raw valid records are
`/tmp/stream-activation-list-{parent,candidate}-r{1,2,3}.log`; the favorable
non-counted smoke is `/tmp/stream-activation-list-candidate-smoke.log` locally.

## 2026-07-14: One-Capability Hosted Delivery Session Rejected

A workerd/Cap'n Web source audit identified three independently returned live
capabilities in every hosted-processor wake handshake: the delivery sink,
runtime-state reader, and ping responder. The proposed collapse grouped all
three behind one retained session. Workerd accounts roughly 1.6 KiB of
external memory per live RPC stub, so the theoretical saving was two stubs, or
about 3.2 KiB per active hosted connection, plus fewer independent release
paths. This is a memory-accounting estimate from source, not a measured RSS
result.

Two wire shapes were tested against exact parent
`5b3a1d34d68ce4b75542c9c564475b554fdeb9d7`:

1. An explicit `RpcTarget` with `processEventBatch`, `getRuntimeState`, and
   `ping` methods. This guarantees one exported object capability but changes
   delivery from a direct callback invocation to a method call.
2. A callable sink with runtime-state and ping attached as own properties. This
   preserves direct delivery syntax and matches Cap'n Web's callable-stub
   model while still presenting one top-level returned capability.

Each shape passed focused ownership tests, the generated API check, OS
typecheck, and a live Workers RPC smoke with no undisposed-stub warning. The
latency discriminator then ran three 300-sample rounds per revision in
`C,P,P,C,C,P` order, restarting the inactive server at every switch. Every
sample killed the project host, appended one event, and awaited the hosted
processor's durable checkpoint. The Node timer enclosed `appendAck` plus
`waitUntilEvent`, so every interval contains awaited network I/O and remains
valid when Workers freezes an isolate clock. One unchanged-parent process in
the callable run lost its client WebSocket; it produced no result, was
discarded, and passed after a clean parent restart.

Positive change means the candidate used less wall time.

| One-event processor reactivation | Object parent | Object session | Change | Callable parent | Callable session | Change |
| -------------------------------- | ------------: | -------------: | -----: | --------------: | ---------------: | -----: |
| Median-of-round p50              |      5.945 ms |       6.436 ms |  -8.3% |        5.988 ms |         6.664 ms | -11.3% |
| Median-of-round p95              |      9.204 ms |       9.450 ms |  -2.7% |        9.233 ms |        10.772 ms | -16.7% |
| Median-of-round mean             |      6.003 ms |       6.419 ms |  -6.9% |        6.059 ms |         6.831 ms | -12.7% |

Pooled callable results were also worse: p50 `+11.7%`, p95 `+13.7%`, mean
`+17.6%`, and p99 `+60.2%` latency, with a `113.288 ms` candidate maximum
versus `16.845 ms` for its parent. The object variant's pooled p50/p95/mean
were `+8.2%`/`+2.7%`/`+5.9%` slower.

The likely explanation is that workerd's existing callback exports are cheap
enough that reducing their retained count cannot repay session projection,
adapter, and ownership work on this handshake-dominated path. The callable
form disproved the narrower theory that only the object method dispatch caused
the first regression. Because both shapes failed the one-event latency gate by
wide margins, the planned 8,000-event throughput guard and 10,000-connection
memory stress were not run; those cannot make a latency-regressing handshake a
shipping candidate without a demonstrated production memory limit.

The callable prototype touched eight files and peaked at `+275/-62` lines
including ownership tests and generated API churn. That is more lifecycle code,
not a collapse: the stream still projected three local operations while also
owning a shared remote session and response-envelope release rule. Both
variants were removed completely. Production, public generated types, and
persistent data are unchanged. Raw records are
`/tmp/stream-session-{parent,candidate}-r{1,2,3}.log` for the object shape and
`/tmp/stream-callable-session-{parent,candidate}-r{1,2,3}.log` for the callable
shape; `/tmp/stream-callable-session-smoke.log` is the non-counted smoke.

## 2026-07-14: Stream-Index Write Ceiling And Schema Rewrites Rejected

The project worker fan-in launches one best-effort activity RPC per delivered
Stream batch. The root Project DO merges that batch's path, final event time and
type, and `streamMaxOffset` into an activation-local projection, then executes
one `INSERT OR REPLACE` against its `streams` table. The call is deliberately
not awaited by `ProjectRpcTarget.processEventBatch`; worker delivery can
checkpoint while the independent Project DO write is still pending. Exact
redelivery is a projection-level no-op.

A disposable candidate removed only `#indexStreamActivity(batch)`, preserving
AI Search dispatch, project-worker invocation, and the Stream subscription's
durable cursor. The host harness installed a no-op project worker and measured
from append through the `project-worker` subscription's observed
`ackedOffset`. Every cursor poll was an awaited RPC, so the timer remained
valid under Cloudflare's frozen-clock behavior. The parent additionally polled
`project.liveState.get()` outside the measured interval until every index row
reached its expected offset; this prevented unobserved write backlog from
contaminating later samples. Each process used a new project and 20 serial / 10
fan-in warmups.

Five 300-sample serial rounds and five 100-wave, 32-stream fan-in rounds ran in
`P,C,C,P,P,C,C,C,P,P` order against exact production parent `5b3a1d34d`, with
only one Workers stack resident. Positive change means the no-index candidate
used less wall time.

| Complete index removal |     Parent |   No index |           Change |
| ---------------------- | ---------: | ---------: | ---------------: |
| Serial p50             |   3.708 ms |   2.790 ms |  **24.8% lower** |
| Serial p95             |   4.982 ms |   4.618 ms |   **7.3% lower** |
| Serial mean            |   3.937 ms |   3.167 ms |  **19.5% lower** |
| 32-stream fan-in p50   |  49.526 ms |  47.685 ms |   **3.7% lower** |
| 32-stream fan-in p95   |  61.292 ms |  76.061 ms | **24.1% higher** |
| 32-stream fan-in mean  |  50.862 ms |  50.735 ms |   **0.2% lower** |
| Fan-in median capacity | 646.1 ev/s | 671.1 ev/s |  **3.9% higher** |

This is an absolute upper bound, not a shipping design: it deletes recency,
latest-type, event-count, persistence, and live patches. It establishes useful
serial headroom, but not a coalescing opportunity. In serial traffic every
delivered batch is already at the exact captured head, so exact-head
coalescing skips nothing and cannot capture the 19-25% serial result. Under the
only lane where coalescing could matter, multi-stream fan-in, the complete
feature deletion moved p50/capacity less than 4%, mean effectively not at all,
and worsened the noisy tail. The proposed offset-envelope, terminal-scan, and
deferred-persistence state would cost more complexity than its realistic
ceiling, so it was not implemented.

Two destructive fresh-schema variants then attempted to reduce the cost of
every correct touch without dropping updates. Both retained the JS merge and
single-statement atomicity:

1. `WITHOUT ROWID` plus `INSERT ... ON CONFLICT DO UPDATE`, avoiding the
   duplicate primary-key B-tree and replacing rows in place.
2. `WITHOUT ROWID` alone with the original `INSERT OR REPLACE`, isolating the
   table layout from UPSERT behavior.

Three exact-parent rounds per combined variant ran in `C,P,P,C,C,P` order.
The `WITHOUT ROWID`-only candidate then ran three rounds against the same
adjacent parent pool. The combined form regressed serial p50/p95/mean by
**1.2%/6.3%/1.8%**, fan-in p50/mean by **4.5%/4.6%**, fan-in p95 by **42.7%**,
and capacity by **4.3%**. `WITHOUT ROWID` alone moved serial p50 only 0.8%
faster while regressing serial p95/mean by **4.6%/8.2%**, fan-in p50/mean by
**2.7%/4.5%**, fan-in p95 by **29.6%**, and capacity by **2.7%**. The combined
result also rules out spending another full pool on UPSERT alone: adding it to
the already-rejected table layout worsened rather than recovered every median.

The source audit also corrected an overstatement in the existing comment: a
failed activity RPC self-heals only if another batch later arrives. A quiet
stream's final failed touch can remain stale indefinitely, and a failed first
touch can make a later activity timestamp become the index's `createdAt`.
That is a derived-dashboard consistency limitation, not Stream journal or
worker-delivery loss, but a future durable-index design must address it without
making user-worker side effects replay when index persistence fails.

All disposable production edits and the focused harness were removed. The
production tree, generated API, schema, persistent data, and runtime topology
are exactly unchanged; the experiment ended at `2026-07-14T06:00:06Z`. Raw
records are `/tmp/stream-index-{parent,candidate}-r{1..5}.log`,
`/tmp/stream-index-sql-{parent,candidate}-r{1..3}.log`, and
`/tmp/stream-index-rowid-candidate-r{1..3}.log` locally.

## 2026-07-14: Duplicate Offset Was Local Vite HMR, Production Workaround Rejected

An earlier benchmark shutdown emitted one
`UNIQUE constraint failed: events.offset` while Stream delivery appended an
idle-teardown fact. The journal allocator, checkpoint catch-up, ephemeral-row
floor, recursive circuit-breaker append, and teardown close loop were audited
first. They preserve one synchronous allocation/insert/state-update boundary:
`#coreProcessorState` advances before any post-commit wake can append again,
activation replay includes ephemeral rows, and eviction persists the highest
assigned offset. No in-isolate reuse path was found.

A disposable real-runtime stress then raced forced idle teardown with sixteen
concurrent appends per round. One hundred rounds (1,600 user appends plus
connection facts) passed without a constraint error. A 2,000-round run stayed
monotonic too, but two edits to the Stream module during the run produced two
immediate, deterministic primary-key collisions. Both were
`subscriber-connected` facts from a wake poke that had started before HMR;
there were zero collisions before the module update. The user append RPCs and
journal head remained monotonic, so the focused test passed despite the two
best-effort presence facts being dropped.

Cloudflare's Vite runner source explains the exact local-only overlap. Its
persistent Durable Object wrapper asks the module runner for the current user
constructor on every RPC. When constructor identity changes, it constructs and
stores a new user object over the wrapper's same `ctx` and SQLite storage
(`workers-sdk/packages/vite-plugin-cloudflare/src/workers/runner-worker/index.ts`,
`kEnsureInstance`, lines 406-429). It does not cancel work retained by the old
user instance. A pre-update subscriber poke can therefore resolve afterward,
call old `StreamSubscribers.#open`, and allocate from the old object's stale
`maxOffset`; meanwhile the replacement constructor has already appended its
`woken` fact at that offset. This reproduces the original stack exactly at
`StreamEventLog.insert` -> `appendFact` -> `StreamSubscribers.#open`.

This is not Cloudflare's deployed incarnation model. First-party source states
that global uniqueness permits only one instance for a class/ID, uniqueness is
rechecked on storage access, code updates reset the object, and old/new code do
not access the same storage simultaneously. Gradual deployments likewise pin
each object to one Worker version. The docs separately acknowledge local hot
reload lifecycle failures for DO alarms and prescribe restarting local dev
after edits. Workerd's actor container also waits for active references before
graceful test eviction; the Vite user-instance swap bypasses that actor
lifecycle because both user objects live inside one wrapper actor.

A production collision retry, per-append `max(offset)` query, durable generation
fence, or Stream-specific `import.meta.hot` registry was rejected. The first
three tax or complicate the production commit point for a condition the
platform contract excludes. The last leaks a local runner workaround into the
deployed object and still cannot generically cancel old async capabilities.
Collision recovery would also let two locally active delivery runtimes
alternately catch up and continue, hiding duplicate side effects rather than
restoring one actor. The correct current mitigation is to restart the local dev
server after changing DO code while it has live async work; a generic fix
belongs in the Cloudflare Vite runner's DO replacement lifecycle.

All stress code and HMR markers were removed. Production code, schema, public
types, and persistent-data format are unchanged. The clean no-HMR run, the
two-collision HMR run, runner source, workerd actor eviction path, and first-party
uniqueness/deployment docs were all inspected before rejecting a repo runtime
change.

## 2026-07-14: Insert-First Idempotent Append Rejected

A first-time idempotency-keyed `appendAck` normally performs an indexed point
lookup, reduces the event, then inserts it. A narrow prototype tested whether
SQLite's unique index could make the new-versus-retry decision during the
insert and remove that lookup. It applied only to one durable, ordinary,
inline event with no offset assertion. `INSERT ... ON CONFLICT(idempotency_key)
... DO NOTHING RETURNING offset` distinguished a new row from a retry, while a
synchronous transaction enclosed the insert and validation so a paused-stream
rejection rolled the candidate row back. Batches, control and ephemeral events,
large events, offset assertions, and result-bearing appends retained the
general path.

The prototype passed OS typecheck, 101 focused storage/validation/reducer unit
tests, and every measured end-to-end correctness assertion. Five 600-sample
rounds per revision then ran in `C,P,P,C,C,P,P,C,C,P` order against exact
parent `0cb85e10a`, with 20 warmups per round and only one Workers stack
resident. Each Node interval enclosed one awaited WebSocket `appendAck`, so
the measurement remains valid when Workers freezes an isolate clock between
network events.

| First-time keyed 1 KiB `appendAck` |   Parent | Insert first |       Change |
| ---------------------------------- | -------: | -----------: | -----------: |
| Median-of-round p50                | 2.568 ms |     2.867 ms | 11.6% slower |
| Median-of-round p95                | 3.805 ms |     4.789 ms | 25.9% slower |
| Median-of-round mean               | 2.698 ms |     3.103 ms | 15.0% slower |
| Pooled p50 (3,000 samples)         | 2.625 ms |     2.857 ms |  8.8% slower |
| Pooled p95                         | 4.125 ms |     4.789 ms | 16.1% slower |
| Pooled mean                        | 2.827 ms |     3.171 ms | 12.2% slower |

Absolute process speed varied, so each round also carried the unchanged
unkeyed-singleton lane as a local control. The median keyed/unkeyed p50 ratio
was `1.065` on the parent and `1.070` with insert-first: after normalization,
the transaction shape still recovered none of the lookup cost. The direct
alternating comparison moved materially backward, and the paired control rules
out a hidden relative win.

The rejected shape added 91 production lines because duplicate validation
semantics require the insert and reducer to share a rollback boundary, while
post-commit state, metrics, cache, breaker effects, delivery wake, and idle
teardown still have to match the general path. That is a second commit protocol
for no measured gain. The likely explanation is that the partial-index miss is
cheap while `transactionSync` plus `RETURNING` adds more SQLite work than it
removes. The implementation and disposable harness lane were deleted entirely;
production, schema, generated API, and persistent data are unchanged. Raw
records are `/tmp/stream-idempotent-{parent,candidate}-r{1..5}.log`.

## 2026-07-14: Exact Cross-Post Delivery Acknowledgements Retained

The destination Stream's existing activation-local acknowledgement cache is
per event and holds 128 idempotency keys. That completely covers ordinary
cross-post retries through 128 events, but the push spine deliberately permits
8,000-event frames. An exact retry of a maximum frame therefore rebuilt every
provenance-stamped append input and issued 80 SQLite idempotency queries in
100-binding chunks before discovering that all 8,000 copies were already
durable.

A focused harness now invokes the destination Durable Object twice with the
exact same realistic `StreamPushEventBatch` at 1, 128, and 8,000 events. The
first awaited RPC seeds the durable copies; Node times repeated awaited second
RPCs and verifies that the destination head never advances. Timing encloses
the full WebSocket and Workers RPC operation, including retransmission and
deserialization of the frame, so it remains valid when Cloudflare freezes an
isolate clock between network events. Unlike the older cross-post replay lane,
this is the same delivery identity and configuration, not a newly appended
`subscription-configured` event.

The retained implementation remembers a successful complete delivery identity
at the destination only when the frame exceeds 128 events. Smaller deliveries
are already fully covered by the per-event cache and take the old path apart
from one length comparison. The complete-delivery key includes source project,
source path, subscription key, committed configuration offset, and delivery
ID. Including the configuration offset is required: replacement selectors can
produce the same first/last delivery ID while making an interior event newly
eligible. The cache holds at most 128 identities, declines identities over
2,048 code units, and is activation-local. A miss, eviction, oversized
identity, or reactivation falls through to durable per-event idempotency. The
identity is remembered only after `appendAck` returns, so a paused-stream or
validation failure remains retryable.

The final focused guard ran three 60-sample rounds per revision in
`P,C,C,P,P,C` order against exact parent `b5119f84f`, with five warmups per
event count, one worktree and port, and only one Workers stack resident.
Positive change means lower latency.

| Exact 8,000-event retry |    Parent | Candidate |          Change |
| ----------------------- | --------: | --------: | --------------: |
| Median-of-round p50     | 47.663 ms | 20.365 ms | **57.3% lower** |
| Median-of-round p95     | 52.063 ms | 25.840 ms | **50.4% lower** |
| Median-of-round mean    | 48.036 ms | 20.772 ms | **56.8% lower** |

The 8,000-event median capacity rises from about 167,800 to 392,800 event
identities per second, **2.34x**. Its remaining ~20 ms is the cost of sending
and decoding the complete retry frame; a receiver-side cache cannot avoid
those wire bytes. As expected for bypassed paths, 1- and 128-event retries
were mixed transport noise: median-of-round means changed -8.1% and +0.5%,
respectively, while the 128-event p95 moved backward on two isolated outliers.

A separate normal first-delivery guard ran five 600-sample rounds per revision
in `P,C,C,P,P,C,C,P,P,C` order on the same worktree, port, and local state.
Candidate median-of-round p50/mean were 3.8%/1.1% higher and p95 was 14.4%
lower; pooled p50/p95/mean were 3.8%/16.9%/5.6% lower. This clears the hot-path
gate as neutral and also explains an earlier two-worktree run whose candidate
stack drifted slower: the controlled rounds show similarly large time drift
between later parent rounds despite identical code on the measured path.

One uncounted candidate process closed its client WebSocket with code 1006
while starting a second synthetic high-volume run and then the detached local
dev process exited without a Worker exception. The exact same run passed after
a clean restart, all ten counted rounds passed, and the full source-driven
Stream e2e file subsequently passed on one candidate stack. The failed record
is retained as
`/tmp/stream-xpost-delivery-candidate-r3-websocket-1006.log`; it is not evidence
of a cache-held frame because the cache retains only a bounded identity string,
but it remains a local stress-harness caveat.

Correctness verification includes all 374 Stream unit tests, all 16
deployment-style Stream e2e tests, and OS typecheck. The new e2e guard covers
exact dedupe, replacement configuration with a newly eligible interior event,
distinct source projects and paths, DO reactivation, and a failed paused-stream
append followed by successful retry. Production changes are `+65/-3` lines,
with no persistent format, migration, background work, timer, compatibility
branch, or extra RPC. Final exact-retry records are
`/tmp/stream-xpost-exact-gated-{parent,candidate}-r{1..3}.log`; first-delivery
guards are `/tmp/stream-xpost-first-gated-{parent,candidate}-r{1..5}.log`.
The experiment ended at `2026-07-14T07:08:48Z`.

## 2026-07-14: Fourth Cumulative Tail Gates Cleared

The fourth cumulative checkpoint's three apparent regressions did not survive
larger same-worktree controls against current main. Exact candidate
`70cedd88c` and main `77366936f` alternated in `M,C,C,M,M,C,C,M,M,C` order on
one port and local state, with the inactive Workers stack stopped before every
revision switch. The branch-hosted harness timed only awaited RPC/network work
and host-observed delivery, so Cloudflare's frozen isolate clock cannot hide
latency.

Five rounds measured 200 dense and 100 sparse cross-post deliveries per
revision per round:

| Cross-post path | Statistic |     Main | Candidate |          Change |
| --------------- | --------- | -------: | --------: | --------------: |
| Dense 1 of 1    | p50       | 4.877 ms |  4.092 ms | **16.1% lower** |
| Dense 1 of 1    | p95       | 8.086 ms |  7.348 ms |  **9.1% lower** |
| Dense 1 of 1    | mean      | 5.226 ms |  4.488 ms | **14.1% lower** |
| Sparse 1 of 100 | p50       | 6.109 ms |  4.713 ms | **22.9% lower** |
| Sparse 1 of 100 | p95       | 9.588 ms |  7.811 ms | **18.5% lower** |
| Sparse 1 of 100 | mean      | 6.435 ms |  5.096 ms | **20.8% lower** |

Five additional rounds measured 300 forced reactivations per revision per
round. Candidate median-of-round p50/p95/mean improved 8.9%/1.1%/5.4%; pooled
1,500-sample p50/p95/mean improved 12.0%/9.0%/12.1%. This includes the required
canonical identity read, so its separately measured sub-millisecond cold tax
is already paid inside an overall faster public operation.

No production change was made. The larger controls reclassify the fourth
checkpoint's dense p95/mean, sparse p95, and forced-reactivation p95/mean rows
as small-sample tail noise rather than shipping regressions. Cross-post records
are `/tmp/stream-crosspost-tail-{main,candidate}-r{1..5}.log`; reactivation
records are `/tmp/stream-reactivation-tail-{main,candidate}-r{1..5}.log`. The
controls ended at `2026-07-14T07:28:46Z`.

## 2026-07-14: Fresh Retained-Tail Reads Retained

Ascending public reads now reuse the delivery reader's already-retained append
tail when that tail proves the answer is complete. The fast path applies the
same event-type, wildcard, ephemeral, offset, and limit semantics in memory.
It declines when the requested lower bound predates the retained window, when
an offset gap exists, or for descending reads; those cases continue through
the existing indexed SQLite query. No second event cache or new retained copy
was added.

The exact parent/candidate experiment compared parent `e47e15155` with
candidate `195498999` for five alternating rounds per revision on one
worktree, port, and local state. Each host sample enclosed and consumed the
awaited RPC result. Median-of-round results were:

| Read path              |       Main p50 / p95 / mean |  Candidate p50 / p95 / mean |         Change p50 / p95 / mean |
| ---------------------- | --------------------------: | --------------------------: | ------------------------------: |
| 500 events, 4 KiB each | 14.310 / 26.569 / 15.202 ms | 12.563 / 18.343 / 13.256 ms | **12.2% / 31.0% / 12.8% lower** |
| 768 KiB event          |   5.335 / 11.650 / 5.876 ms |   4.841 / 11.272 / 5.534 ms |    **9.3% / 3.3% / 5.8% lower** |

The sparse ascending lane also improved 25.7%/15.2%/19.6% because its retained
tail could prove the answer. The unchanged descending-latest SQLite fallback
was neutral at -0.8%/+3.9%/+4.3% for p50/p95/mean. This is important: the gain
does not depend on weakening the indexed historical-read path.

A larger current-main gate then compared main `a23d5cdd0` with final candidate
`6857ef674` for five rounds of 100 samples. A 768 KiB read improved from
5.705/9.305/6.236 ms to 4.849/7.415/5.302 ms, or
**15.0%/20.3%/15.0% lower p50/p95/mean**. The same fixture's 768 KiB
discarded-result append improved 49.2%/52.5%/51.7%; its absolute append times
are not compared with the cumulative suite because 100 consecutive large
writes intentionally grow one local store much further.

Correctness includes 378 Stream unit tests, all 16 public Stream e2e tests,
and OS typecheck. The focused tests cover filters, wildcards, ephemerals,
limits, exact and fractional bounds, retained gaps, and SQL fallback. The
fractional public bound found during review is deliberately rounded with
`ceil(bound) - 1`, preserving the prior SQL predicate exactly.

Production cost is `+68/-4` lines and tests are `+108/-2`. The additional
branch is local to the reader and collapses safely to the old SQLite query on
any uncertainty. It introduces no schema, migration, timer, RPC, persistent
state, compatibility mode, or duplicated retained payload. Raw focused
records are `/tmp/stream-fresh-read-{parent,candidate}-r{1..5}.log` and
`/tmp/stream-768-tail-{main,candidate}-r{1..5}.log`.

## 2026-07-14: Fifth Cumulative Main Comparison

### Revisions And Runtime

- Candidate: `9be38d96dc7758555db146807ce8cd458c1f00e1`
- Baseline: `f66ba9bd0f0e1c1c8efedf1a09a5195481c6f6c8`
  (`origin/main`, fetched before and after collection)
- Five complete rounds per revision in `M,C,C,M,M,C,C,M,M,C` order.
- The same branch-hosted harness drove both revisions, only one Workers stack
  was active, and each sample timed awaited host-visible network work.
- Collection ended at `2026-07-14T09:33:16.787Z`. If this run remains active,
  the next cumulative comparison is due by `2026-07-14T13:33:16.787Z`.

All ten processes passed. The table reports change from the median of the five
per-round statistics; positive percentages mean less candidate wall time.

| Workload                               | p50 change | p95 change | mean change |
| -------------------------------------- | ---------: | ---------: | ----------: |
| Append one 1 KiB event, discard result |       1.3% |       1.6% |        5.0% |
| Append 100 tiny events in one call     |  **43.2%** |  **45.2%** |   **44.6%** |
| 32 concurrent singleton appends        |  **21.8%** |     -47.1% |   **20.5%** |
| Append one 256 KiB event               |  **33.9%** |  **29.1%** |   **33.4%** |
| Append one 768 KiB event               |  **31.3%** |  **32.2%** |   **32.5%** |
| Read one 768 KiB event                 |  **19.0%** |  **40.1%** |   **20.5%** |
| Retry duplicate 256 KiB append         |  **29.7%** |  **22.9%** |   **26.1%** |
| Hot stream head                        |   **7.1%** |       4.0% |   **12.1%** |
| Read 500 events of 4 KiB               |  **29.3%** |  **21.0%** |   **28.5%** |
| Sparse ascending read, 20 of 2,000     |  **16.1%** |     -40.2% |   **10.5%** |
| Latest sparse event                    |  **13.0%** |     -50.6% |    **8.1%** |
| Replay 500 events                      |  **17.0%** |  **12.0%** |   **17.6%** |
| One live delivery                      |  **17.1%** |     -11.6% |   **11.4%** |
| Live fanout to 25 subscribers          |   **5.8%** |     -13.9% |       -9.2% |
| Dense durable cross-post               |  **12.5%** |       0.4% |   **12.2%** |
| Sparse durable cross-post, 1 of 100    |  **31.9%** |  **20.0%** |   **31.7%** |
| Forced-reactivation head               |     -13.3% |     -16.0% |       -6.1% |

Across all 17 equally weighted workloads, geometric-mean p50 improved
**19.7%**, p95 improved **7.0%**, and mean improved **18.8%**. This is a suite
summary, not a production-traffic weighting. Capacity effects from the same
median rounds include:

| Workload                 |               Main |          Candidate | Capacity change |
| ------------------------ | -----------------: | -----------------: | --------------: |
| 100-event batch append   |     8,118 events/s |    14,282 events/s |      **+75.9%** |
| 32-way singleton append  |        2,095 ops/s |        2,679 ops/s |      **+27.8%** |
| Replay 500 events        |    60,857 events/s |    73,292 events/s |      **+20.4%** |
| Fanout to 25 subscribers | 4,675 deliveries/s | 4,961 deliveries/s |       **+6.1%** |

The red low-sample p95 cells are not treated as established regressions. The
fresh-read focused control cleared sparse ascending reads and classified the
unchanged descending path as neutral. Earlier 1,500-sample reactivation and
larger cross-post controls cleared those tails against main. Concurrent
append, one-delivery, and fanout tails remain candidates for dedicated larger
controls; until then, claims are limited to their stable central tendency and
the aggregate p95 improvement. Cold head remains the one cumulative row whose
central tendency is genuinely slower, although the larger forced-reactivation
public-operation control remains faster overall.

The fifth checkpoint therefore strengthens the shipping case without hiding
the cost: common batch, large-event, replay, read, and cross-post paths improve
materially, while isolated p95 validation is still required for concurrent and
live fanout paths. Raw records are
`/tmp/cumulative-5-current-{main,candidate}-r{1..5}.log`.

## 2026-07-14: Sixth Cumulative Main Comparison

### Revisions And Final Gate

- Candidate: `68fcfb3620`.
- Baseline: `ea4b28637b`, freshly fetched `origin/main` before collection.
- Five complete current-suite rounds per revision, followed by larger focused
  controls for the noisy concurrent, live-delivery, fanout, and forced-cold
  rows. Only one Workers stack was active at a time.
- Every timer ran in Node around an awaited RPC or observed delivery and
  consumed the result. The comparison does not depend on an isolate clock
  advancing while workerd is CPU-bound.

The current-suite central values remained broadly positive. Larger focused
controls replace the four noisy small-sample rows rather than selectively
discarding them:

| Focused workload                |       p50 change |        p95 change |      mean change | Capacity change |
| ------------------------------- | ---------------: | ----------------: | ---------------: | --------------: |
| 32 concurrent singleton appends | **15.76% lower** |   **2.05% lower** | **10.63% lower** |     **+18.70%** |
| One live delivery               |  **7.23% lower** |  **17.98% lower** |  **5.33% lower** |             n/a |
| Fanout to 25 subscribers        |  **2.65% lower** |  **16.67% lower** |  **1.30% lower** |             n/a |
| Forced-reactivation head        | **4.81% higher** | **10.08% higher** | **9.18% higher** |             n/a |

Across all 17 equally weighted workloads after those replacements, geometric
mean p50 improved **17.442%**, p95 improved **12.146%**, and mean improved
**16.369%**. This is still a suite summary, not a claim about production
traffic weights. The most useful capacity results were **+39.7%** for the
100-event append batch and **+23.0%** for 500-event replay.

The forced-cold regression is accepted as the measured correctness tax for
canonical name recovery. ID-only RPC reactivation used to lose the canonical
name needed by the Stream's path/project identity. Recovery now performs one
KV read on activation, about 0.28 ms in the focused storage measurement. Warm
operations do not pay it. Removing the read would recover a small cold-only
number by restoring incorrect reactivation behavior, so it is not an
optimization candidate.

Current-suite records are
`/tmp/cumulative-6-current-{main,candidate}-r{1..5}.log`; focused controls are
`/tmp/cumulative-6-tail-{main,candidate}-r{1..5}.log`.

## 2026-07-14: One Public Append Operation Retained

### API And Internal Boundary

The public Stream surface now has one `append` operation. The default call is
the cheapest useful contract: commit durably and return no payload. A caller
that consumes an input-aligned result selects it on the same operation with
`append({ return: "offsets" }, ...events)` or
`append({ return: "events" }, ...events)`. `appendAck` and `appendOffsets` are
no longer public compatibility aliases. The conceptual surface is now append,
subscribe, read, and wait-for-event.

The Stream Durable Object deliberately retains three specialized internal
methods. `StreamRpcTarget.append` dispatches once at the public boundary, while
code holding a raw `env.STREAM` namespace stub calls the specialized method
directly. This is not a second public API: it keeps result materialization out
of acknowledgement-only writes and prevents an options object from being
parsed as an event. A real itx-connect failure exposed one unsafe cast in the
secret path during the experiment; the final change removed that cast and
audited every raw namespace call site.

Cap'n Web's generated method type cannot preserve the relationship between an
argument overload and its option-dependent result. The honest generated type
is therefore `StreamEvent[] | number[] | void`; internal callers that request a
projection validate it with `appendedEvents` or `appendedOffsets`. A tagged
wire wrapper would improve static narrowing but add bytes and allocation to
every result-bearing append. Keeping the untagged payload is the lower-cost
choice, with a small and explicit TypeScript ergonomics cost.

### Performance And Verification

A same-server dispatch control alternated the old acknowledgement method and
the unified default operation for five runs, timing awaited host-visible RPCs.
Pooled changes were effectively neutral:

| Workload                        |   p50 change |   p95 change |  mean change |
| ------------------------------- | -----------: | -----------: | -----------: |
| Singleton append                | 1.55% higher | 2.64% higher |  0.49% lower |
| 100-event batch                 |  1.23% lower |  6.22% lower |  1.99% lower |
| 32 concurrent singleton appends | 0.47% higher | 1.87% higher | 4.67% higher |

Singleton p99 was noisy and inconsistent across runs, so no p99 claim is made.
Two cross-server runs reversed their global direction when run order reversed,
including unrelated read/head controls, and are rejected as process-order
bias rather than evidence about dispatch.

Verification on the final commit includes OS typecheck, 263 touched-path unit
tests from the API migration, a 54-test raw-stub group rerun after the boundary
fix, all 16 Stream end-to-end tests, and 35 other active Stream/itx end-to-end
checks. One dynamic-worker test timed out after 60 seconds in the parallel
matrix and passed in 2.2 seconds alone. Running the kill/reactivation Stream
suite concurrently with seven other files caused the detached local workerd
process to exit after its intentional kill; the Stream suite passed 16/16
alone and the remaining files passed separately. Wire latency in the final
matrix was p50 1.7 ms and p95 8.7 ms over 20 samples.

The change is broad at call sites and generated API output (`+803/-483` across
49 files) but shallow architecturally: one public dispatch, two result guards,
and no schema, migration, timer, queue, cache, storage-format branch, or
background task. It collapses back to the existing specialized DO operations
at one boundary. The main lasting complexity is the result union imposed by
Cap'n Web's method typing, not runtime control flow. Dispatch records are
`/tmp/stream-append-dispatch-r{1..5}.log`.

## 2026-07-14: Radical Redesign Outcomes

Five wider prototypes were kept on isolated branches long enough to test and
then excluded from the shipping branch:

- A normalized/segmented journal improved only very large chunked writes.
  Ordinary append and read paths regressed, while the extra tables and
  materialization paths made recovery and rollback harder to audit. It ended
  on `experiment/stream-radical-journal` and is rejected.
- A synchronous resident session pump produced mixed medians and materially
  worse tails. It added another scheduler and re-arm state machine without a
  stable throughput win. It ended on
  `experiment/stream-radical-session-pump` and is rejected.
- A `waitForEvent` micro-fast-path was slower than the existing subscriber
  route and was deleted rather than retained behind a branch.
- A second segmented-journal prototype (`c7907f45e`) packed 100-1,000
  homogeneous keyless events into a bounded SQLite row. It improved the
  100 x 1 KiB append p50 by 6.7%, but regressed 100 tiny events by 4.3%, 1,000
  tiny events by 2.6%, dense replay by 4.9%, and large singleton writes. It
  added 512 lines while requiring two-table scans, JavaScript merge logic,
  whole-segment parsing for some point reads, and application-enforced
  cross-table offset uniqueness. All 380 Stream unit tests and 30 active
  Workers checks passed, but the implementation is rejected because the one
  narrow gain does not justify a second journal format.
- An actor-resident acknowledgement queue (`f00ce40ee`) used one real
  `scheduler.wait(0)` turn to combine up to 128 concurrent requests or 1,024
  events before the existing synchronous SQLite commit. Five matched Workers
  rounds improved 32-way and 128-way throughput by 30.9% and 35.5%, with p50
  latency 23.6% and 26.2% lower. The same mandatory collection turn regressed
  singleton p50/p95 by 14.8%/16.3%. It also required volatile request queues
  and ordering barriers on every read, subscription, lifecycle, alarm, and
  result-bearing write path. It is rejected as the default policy. Callers
  with real bursts should use the existing variadic append boundary, which
  retains explicit batching without taxing every singleton.

The actor experiment also pinned the frozen-clock constraint directly. A
detached leading-write timer was stranded after the output gate closed and
produced 13.697 ms singleton p50. Only the unresolved RPC-backed
`scheduler.wait(0)` variant made the batching turn reliable, and that real I/O
boundary is exactly the source of the singleton tax. A forced
`storage.sync()` pipeline was also slower. Raw actor records are
`/tmp/stream-actor-{baseline,candidate}-r{1..5}.log`.

One smaller result survived the subscription redesign. The original resident
wakeup prototype combined shared wake snapshots, a direct `waitForEvent`
route, and new ephemeral-lifecycle handling. The combined branch improved
25-subscriber fanout but regressed the already-present-event `waitForEvent`
path, so it was not integrated wholesale. The shared-snapshot pump was then
isolated as a 29-line patch with no timer, queue, persistence, schema, or
external API change. One wake now constructs one immutable read state for all
resident connections. Each connection keeps only its newest monotonic
notification while a pump is active, so reentrant wakes collapse instead of
repeating state construction and redundant pump passes.

Five matched local Workers rounds alternated baseline `32dcff566` and the
isolated candidate `4db0e0236`, with 300 host-timed append-to-observed-delivery
samples per workload per round. Median-of-round results were:

| Live delivery  |          p50 |          p95 |         Mean |   Throughput |
| -------------- | -----------: | -----------: | -----------: | -----------: |
| One subscriber | 18.10% lower | 12.21% lower | 13.87% lower |          n/a |
| 25 subscribers |  3.21% lower | 15.03% lower |  2.64% lower | 3.31% higher |

The pooled 1,500 samples per implementation agreed with both directions. The
measurements surround awaited RPC and observed delivery on the host and consume
the returned marker; they do not use isolate CPU time as wall time. Raw records
are `/tmp/stream-coalesced-wakeup-{baseline,candidate}-r{1..5}.log`. This
extracted pump is included in the shipping branch; the direct `waitForEvent`
and ephemeral-lifecycle variants remain rejected. Final integration checks
passed all 381 Stream unit tests, the full 1,603-test OS unit suite, and all 35
active Stream Workers tests, including teardown/reactivation and live wire
delivery.

These results reinforce the earlier legacy-KV decision. Owning flush timing is
attractive in theory, but it also means recreating SQLite's transaction and
output-gate correctness boundary in application code. The measured wins in
this branch come from fewer statements, less serialization, retained tails,
and less duplicate work. A KV rewrite remains an experiment only if it can
beat those paths end to end while proving eviction and failure semantics; it
is not a shipping direction on current evidence.

## 2026-07-14: Per-Event Wire Delivery Rejected

### Question And Correctness Boundary

An isolated branch replaced each delivered `processEventBatch(batch)` wire
call with one `processEvent(event)` call while disposing ignored callback
results unpulled. The experiment covered 20 ms, 48 kHz mono PCM16 frames
(1,920 raw bytes represented by a 2,560-character payload) on three actual
Cloudflare paths:

- ephemeral host subscriber: Stream Durable Object to Worker relay over
  Workers RPC, then Worker to the Node consumer over Cap'n Web;
- durable push: source Stream Durable Object to the configured destination,
  with every per-event result awaited in order because it advances the owned
  delivery cursor;
- durable wake: Stream Durable Object to the Project Durable Object's hosted
  processor sink over Workers RPC, retaining the normal cumulative settlement
  fences.

Discarding durable-push results would change ordering and at-least-once
semantics, so that invalid fast variant was not benchmarked as a candidate.
Every timer ran in Node around append plus observed callback or processor
completion. Exact marker sets were consumed, and `waitUntilEvent` supplied the
durable-wake consumption fence. The measurements therefore do not depend on a
Worker isolate clock advancing without network I/O.

### Deployed Result

Revision `2f564eee0` was deployed to leased Cloudflare preview 4 as Worker
version `0196bad7-654c-421f-a96e-04636ae17306`. Three independent alternating
runs produced 60 pooled samples per ephemeral mode, 30 per durable-push mode,
and 15 per durable-wake mode. The 128-frame ephemeral case received three
additional 20-sample runs. Positive latency changes are regressions; positive
capacity changes are improvements.

| PCM delivery workload    | p50 change | p95 change | Capacity change |
| ------------------------ | ---------: | ---------: | --------------: |
| Ephemeral, 1 frame       |      -4.7% |     -42.3% |           +4.9% |
| Ephemeral, 8 frames      |      +2.6% |     -12.4% |           -2.5% |
| Ephemeral, 32 frames     |      +6.0% |     +37.0% |           -5.6% |
| Ephemeral, 128 frames    |     +13.5% |     +42.8% |          -11.9% |
| Durable push, 1 frame    |     +11.1% |    +345.6% |          -10.0% |
| Durable push, 8 frames   |    +321.3% |     +56.5% |          -76.3% |
| Durable push, 32 frames  |  +1,298.0% |  +1,329.6% |          -92.8% |
| Durable wake, 512 frames |     +33.7% |         \* |          -25.2% |

The wake p95 is not claimed: a 3.2-second batch-side preview outlier reversed
the pooled tail direction. Per-event p50 was slower in all three wake rounds;
the median round was 54.9% slower. The predeclared non-inferiority margin was
5%, so even ephemeral delivery fails at 32 and 128 frames. One clean 128-frame
warmup took 1.74 seconds per-event versus 78 ms batched, and a measured
per-event sample reached 1.04 seconds. A separate preview-3 run also failed to
observe all 128 callbacks within 30 seconds; it is excluded from the clean
preview-4 aggregate but reinforces the backpressure/tail risk.

Local Workers diagnostics pointed in the same direction but were not used as
the acceptance result. At 32 and 128 ephemeral frames they retained about 59%
and 42% of batch throughput; durable wake was about 3.1 times slower, and
correct durable push was about 13 times slower at 32 frames. Deployed records
are `/tmp/stream-process-event-preview4-r{1..3}.log` and
`/tmp/stream-process-event-preview4-128-r{2..4}.log`; the complete experiment
and selectable host harness end on `experiment/stream-process-event` at
`3eeb4854b`.

### Decision And Collapse Path

Direct per-event transport is rejected. A batch is not merely public API
ergonomics: it is the amortization, transaction, acknowledgement, and cursor
checkpoint unit. Multiplying calls removes one visible array while adding
transport envelopes, backpressure, settlement, and failure-ordering work.

This does not require two fundamental subscription operations. The coherent
API can still expose `subscribe` with a user-level `processEvent` hook, while a
receiver-side adapter accepts one internal batch and invokes that hook locally
for each event. Hosted processors already follow that shape. Ephemeral clients
would need an SDK/session adapter because a raw remote callback cannot hide N
wire calls by itself. Keep the batched callback as an internal protocol detail,
not a second public concept. That collapse preserves the measured performance
and correctness boundary while simplifying the external model to append,
subscribe, read, and wait-for-event.

## 2026-07-14: Seventh Cumulative Main Comparison

### Revisions And Method

- Candidate: `10d8f7e77c9879dc01cf065360712eae78771d3a`.
- Baseline: `b733e52edc6ef12fa67ae1ff1b2deb53aa161ac9`, freshly fetched
  `origin/main` when collection started.
- The complete 17-workload suite ran five times per revision in
  `M,C,C,M,M,C,C,M,M,C` order. All ten processes and semantic assertions
  passed.
- The four noisy concurrency/delivery/reactivation rows then ran with
  500-1,500 host observations per implementation, and the storage control ran
  2,000 singleton observations per implementation plus larger batch/read
  controls.
- Only one local Workers stack was active at a time. Every timer ran in Node
  around awaited network/RPC work or observed delivery and consumed the
  result, so frozen isolate clocks are not used as wall time.

`origin/main` advanced to `e98c1d981` after collection. Those four commits
do not change the Stream Durable Object, storage, subscriber, or processor
production paths; they consolidate Stream test doubles and make unrelated
search/UI/preview changes. They were merged separately as `25d5dcd1f`. The
recorded comparison remains against the exact current-main revision fetched at
the start, rather than relabelling post-hoc results with the later SHA.

### Cumulative Result

The unadjusted 17-workload geometric mean improved by 13.480% at p50, 2.945%
at p95, and 10.361% at mean. Replacing the five deliberately low-sample rows
with their larger controls gives the more defensible cumulative result:

| Equally weighted suite statistic | Candidate improvement |
| -------------------------------- | --------------------: |
| Geometric-mean p50               |           **15.841%** |
| Geometric-mean p95               |           **11.610%** |
| Geometric-mean mean              |           **13.286%** |

This is a branch-versus-main suite summary, not a production-traffic
weighting and not a sum of previously reported percentages.

The focused replacements report change from the median of five per-round
statistics:

| Focused workload                |       p50 change |       p95 change |      mean change | Capacity change |
| ------------------------------- | ---------------: | ---------------: | ---------------: | --------------: |
| One 1 KiB append                |  **3.78% lower** | **6.84% higher** | **5.36% higher** |             n/a |
| 32 concurrent singleton appends | **13.80% lower** | **12.99% lower** | **13.99% lower** |     **+16.01%** |
| One live delivery               |  **7.52% lower** | **4.24% higher** | **1.33% higher** |             n/a |
| Fanout to 25 subscribers        |  **8.20% lower** | **10.28% lower** |  **5.24% lower** |      **+8.94%** |
| Forced-reactivation head        |  **7.48% lower** | **2.54% higher** | **1.74% higher** |             n/a |

Singleton, one-subscriber delivery, and forced reactivation are classified as
neutral rather than wins or regressions. Their pooled and median-of-round
directions disagree on at least one statistic; for example, singleton pooled
mean is 2.71% lower while median-of-round mean is 5.36% higher. Concurrent
append and 25-subscriber fanout agree across the larger round and pooled
distributions and remain established wins.

The storage control also confirms that the retained architecture scales with
explicit batches:

| Storage workload            |       p50 change |       p95 change |      mean change | Capacity change |
| --------------------------- | ---------------: | ---------------: | ---------------: | --------------: |
| 100 tiny events             | **27.29% lower** | **19.37% lower** | **23.82% lower** |     **+37.52%** |
| 100 events of 1 KiB         | **37.64% lower** | **31.76% lower** | **34.69% lower** |     **+60.36%** |
| 100 keyed tiny events       | **21.67% lower** | **15.55% lower** | **22.14% lower** |     **+27.67%** |
| One inline 768 KiB event    | **48.22% lower** | **42.55% lower** | **40.74% lower** |             n/a |
| One chunked 1,100 KiB event |  **4.29% lower** |  **8.93% lower** |  **2.99% lower** |             n/a |

The 1,000-event batch improved p50/mean by 39.69%/33.06% and capacity by
65.82%, but its 50 samples per round do not support a tail claim. Dense
post-reactivation replay improved 14.93%/8.60%/15.05% at p50/p95/mean.

No production code was added for this checkpoint. The latest-main merge
reduced duplicated test harnesses, and the branch's option-aware in-memory
append adapter was folded into that one canonical helper. OS typecheck and 173
affected processor tests pass after the merge. Complete records are
`/tmp/cumulative-7-full-{main,candidate}-r{1..5}.log`; focused delivery and
reactivation records are
`/tmp/cumulative-7-tail-{main,candidate}-r{1..5}.log`; storage records are
`/tmp/cumulative-7-storage-{main,candidate}-r{1..5}.log`. Collection ended
at `2026-07-14T14:33:46.511Z`; if active work continues, the next cumulative
comparison is due by `2026-07-14T18:33:46.511Z`.

## 2026-07-14: Column-Owned Event Envelope Local Gate

### Hypothesis And Correctness Boundary

Stream schema 8 stored `type`, `offset`, `idempotencyKey`, and `ephemeral`
twice: once in indexed SQLite columns and again in `event_json`. The isolated
`experiment/stream-column-envelope` branch advances directly to destructive
schema 9 and stores only the event body (`createdAt`, payload, metadata, and
source) as JSON. Reads restore the indexed envelope columns and the invariant
stream path. There is deliberately no schema-8 migration or compatibility
branch; deploying this revision requires erasing the environment's Stream
Durable Object data.

The indexed columns are authoritative. Insert, inline replay, chunk replay,
point reads, keyed reads, selected-frame scans, and exact delivery byte cuts
all use the same reconstructed envelope semantics. Tests compare full UTF-8
`JSON.stringify(event)` lengths across Unicode types and payloads, quoted
Unicode idempotency keys, ephemeral rows, and selector SQL. All 82 storage
tests and all 381 Stream-domain unit tests pass, as does OS typecheck.

The prototype is commit `af05d32eb`, based on exact shipping parent
`11b84f49a`. A five-process host SQLite prefilter reduced a representative
tiny stored row from 145 to 82 bytes. It estimated 16.13% lower tiny-batch p50
and 10.26% lower tiny replay p50; the host result only justified running the
real workerd gate and is not an acceptance result.

### Exact-Parent Local Workers Result

Five workerd processes per revision ran in `C,M,C,M,M,C,C,M,M,C` order. Each
process used fresh projects and paths, asserted every semantic result, and
collected 400 singleton observations, 200 observations for the 100-event
batch rows, 50 for the 1,000-event row, 100 per replay row, and bounded large
event samples. Node host timers surrounded awaited network/RPC operations and
consumed every result; no isolate clock supplied wall time.

Change is computed from the median of five per-round statistics. Positive
numbers mean lower candidate latency; capacity is operations per second.

| Workload                      | p50 change | p95 change | Mean change | Capacity change |
| ----------------------------- | ---------: | ---------: | ----------: | --------------: |
| One 1 KiB append              |      8.77% |     14.63% |      10.34% |             n/a |
| 100 tiny events               |      7.43% |     15.66% |      12.37% |           8.02% |
| 100 events of 1 KiB           |      6.61% |      1.98% |       9.06% |           7.08% |
| 1,000 tiny events             |     13.52% |     47.94% |      17.89% |          15.63% |
| 100 keyed tiny events         |     14.52% |     11.69% |      19.58% |          16.99% |
| Dense cold replay, 500 x 1KiB |     -5.66% |     -3.25% |      -5.74% |             n/a |
| Sparse cold replay, 20/2,000  |      3.40% |     13.83% |       4.39% |             n/a |
| One inline 768 KiB event      |      4.65% |      6.41% |       6.58% |             n/a |
| One chunked 1,100 KiB event   |      3.60% |      0.96% |       3.16% |             n/a |

The mixed run's dense replay row disagreed with its pooled distribution,
which was only 0.60% slower at mean. A separate read-only control therefore
ran five processes per revision with 500 forced-reactivation observations per
workload per process. Dense replay was 2.26% lower at median p50, 14.04% lower
at p95, and 6.57% lower at mean; pooled p50/p95/mean improved
7.16%/16.69%/9.62%. Sparse replay remained neutral overall: median mean was
0.96% worse while pooled mean was 1.95% better. Replay is classified as
neutral-to-improved, not as a regression or a claimed sparse-read win.

Raw mixed records are
`/tmp/column-envelope-storage-{main,candidate}-r{1..5}.log`; the larger replay
control is `/tmp/column-envelope-read-{main,candidate}-r{1..5}.log`.

### Cost And Deployed Gate

The implementation changes one production module plus its tests: 231 added
and 88 removed lines in the isolated commit. It deletes redundant persisted
data but makes read projections and envelope reconstruction explicit, and it
adds exact SQL byte accounting for selector cuts. That is meaningful local
complexity, but it does not add a service, queue, async protocol, migration,
or new externally visible operation. The collapse path is one commit: schema
9 has not entered the shipping branch, so rejection means deleting the
experiment branch with no production fallback code left behind.

This local result advanced the experiment to an actual deployed Worker A/B,
recorded below. At `2026-07-14T15:16Z` all nine preview slots were legitimately
leased to active PRs, so no holder was evicted and no unleased deployment was
attempted. The later run used this PR's legitimate `preview_5` lease.

## 2026-07-14: Eighth Cumulative Main Comparison

### Revisions And Method

- Candidate: `f2fbff2c138cb4505cf694e0e28df834e2e89591`.
- Baseline: `c80cad73a1a4d8416151b8789749aba16fe74a83`, freshly fetched
  `origin/main` when collection started.
- The complete 17-workload suite ran five times per revision in
  `M,C,C,M,M,C,C,M,M,C` order. All ten processes and all semantic assertions
  passed.
- Larger controls then ran five times per revision in the same order: 2,000
  singleton storage observations; 500 concurrent-append and forced-reactivation
  observations; 1,500 one-subscriber and 25-subscriber live observations; and
  larger batch/read controls.
- Each process used a dedicated explicit port, fresh state, and fresh projects
  and paths. Only one Workers stack was active at a time. Node timed awaited
  network/RPC calls or host-observed delivery and consumed every result; no
  Worker-isolate clock supplied wall time.

`origin/main` advanced through `7b106d623` after collection. It was merged as
`79b671d46`; the one browser-runtime conflict combined main's new single-download
composite mirror with this branch's cheaper `head()` reconcile and required the
composite to fan out `ingestThrough`. OS typecheck and all 389 Stream unit tests
pass. The benchmark record remains against the immutable current-main SHA that
was fetched when collection began.

### Cumulative Result

The unadjusted 17-workload geometric mean improved by **13.596% at p50**,
**5.303% at p95**, and **13.968% at mean**. Replacing singleton append,
concurrent append, one- and 25-subscriber live delivery, and forced reactivation
with their larger controls gives the more defensible cumulative result:

| Equally weighted suite statistic | Candidate improvement |
| -------------------------------- | --------------------: |
| Geometric-mean p50               |           **17.416%** |
| Geometric-mean p95               |            **9.324%** |
| Geometric-mean mean              |           **16.077%** |

This is an equal-workload branch-versus-main summary, not a production-traffic
weighting and not a sum of prior comparison percentages.

The focused controls report change from the median of five per-process
statistics. Rows with conflicting pooled/median directions or changes below
5% remain neutral.

| Focused workload                |       p50 change |       p95 change |      mean change | Capacity change |
| ------------------------------- | ---------------: | ---------------: | ---------------: | --------------: |
| One 1 KiB append                |  **2.84% lower** | **5.94% higher** | **8.34% higher** |         neutral |
| 32 concurrent singleton appends | **21.77% lower** | **14.58% lower** | **19.10% lower** |     **+27.83%** |
| One live delivery               | **26.84% lower** |  **7.65% lower** | **16.77% lower** |             n/a |
| Fanout to 25 subscribers        | **15.26% lower** |  **9.97% lower** | **11.01% lower** |     **+18.01%** |
| Forced-reactivation head        |  **5.85% lower** | **7.02% higher** |  **5.95% lower** |         neutral |
| 100 tiny events                 | **21.66% lower** |  **5.87% lower** | **13.20% lower** |     **+27.64%** |
| 100 events of 1 KiB             | **32.52% lower** | **28.85% lower** | **30.98% lower** |     **+48.18%** |
| 100 keyed tiny events           | **21.93% lower** |  **7.47% lower** | **17.92% lower** |     **+28.09%** |
| Dense post-reactivation replay  | **22.09% lower** | **16.71% lower** | **20.05% lower** |             n/a |
| Sparse post-reactivation replay | **16.96% lower** |          neutral | **14.55% lower** |             n/a |
| One inline 768 KiB event        | **48.53% lower** | **40.95% lower** | **39.31% lower** |             n/a |
| One chunked 1,100 KiB event     |          neutral |          neutral |          neutral |             n/a |

The 1,000-event batch improved p50/mean by 43.71%/36.62% and capacity by
77.66%; its small per-process tail sample regressed 15.92%, so no p95 win is
claimed. Complete records are
`/tmp/cumulative-8-full-{main,candidate}-r{1..5}.log` and
`/tmp/cumulative-8-focus-{main,candidate}-r{1..5}.log`. Collection ended at
`2026-07-14T18:56:13.048Z`; if active work continues, the next cumulative
comparison is due by `2026-07-14T22:56:13.048Z`.

## 2026-07-14: Column-Owned Event Envelope Rejected At Deployed Gate

### Actual Worker Topology

The deployed lane does not benchmark a direct host-to-DO shortcut. The Node
host first waits on an output stream, then appends through the public OS Worker
RPC to a source Stream Durable Object. A dynamic Project Worker receives the
subscription batch, forwards its events through public append into an output
Stream Durable Object, and writes a completion fact there. The host stops its
clock only after observing and validating that completion. This covers:

```text
Node host -> OS Worker -> source Stream DO -> Project Worker consumer
          -> OS Worker -> output Stream DO -> Node host observation
```

All timers are on the Node host around real network I/O, and all returned or
delivered values are consumed. The measurement therefore remains valid when
Cloudflare freezes an isolate clock between I/O operations.

The A/B alternated deployment periods on the draft PR's `preview_5` lease:
shipping schema 8, candidate schema 9, shipping, candidate, then final shipping
restore. Five complete processes per implementation contributed 300 single
forwarding observations and 120 100-event forwarding observations per
implementation. One baseline process hung during setup before emitting a
benchmark marker and was excluded rather than treated as latency data.

### Worker-Consumer Result

Positive change means the candidate used less time. The pooled distribution
and median of the five per-process statistics must agree before accepting a
deployed win.

| Workload                      | Aggregation | p50 change | p95 change | Mean change |
| ----------------------------- | ----------- | ---------: | ---------: | ----------: |
| Forward one event end to end  | Pooled      |      2.96% |     19.66% |       6.63% |
| Forward one event end to end  | Median run  |     -3.12% |      4.43% |      11.29% |
| Forward 100 events end to end | Pooled      |      3.97% |    -46.90% |     -12.92% |
| Forward 100 events end to end | Median run  |     -0.44% |    -30.75% |     -17.78% |

The single-event median direction disagrees and the p50 effect is below the 5%
acceptance threshold. The 100-event path is neutral at p50 and materially worse
at p95/mean. Schema 9 therefore provides no demonstrated end-to-end deployed
Worker-consumer improvement.

### Deployed Storage Control

The storage-focused lane used equal pooled sample counts for both revisions
across one large and one smaller deployment-period run. It isolates public
append and post-reactivation reads while still timing from Node across the
deployed Worker/Stream-DO boundary.

| Storage workload               | p50 change | p95 change | Mean change |
| ------------------------------ | ---------: | ---------: | ----------: |
| One 1 KiB append               |      4.68% |    -34.11% |       3.98% |
| 100 tiny events                |      3.29% |     -7.82% |      -5.86% |
| 100 events of 1 KiB            |      8.31% |     13.21% |       5.41% |
| 1,000 tiny events              |      9.72% |     12.82% |      13.53% |
| 100 keyed tiny events          |     -6.17% |     -7.59% |     -20.26% |
| Dense cold replay, 500 x 1 KiB |      3.30% |     15.38% |       4.01% |
| Sparse cold replay, 20 / 2,000 |      2.54% |     23.28% |      11.36% |
| One inline 768 KiB event       |    -37.41% |     21.63% |      -5.53% |
| One chunked 1,100 KiB event    |     26.13% |     53.06% |       4.56% |

The two deployment periods frequently disagreed. In the second paired period,
for example, schema 9 made 100 x 1 KiB slower rather than faster and left dense
replay effectively unchanged. The pooled 1,000-event win is useful evidence
that smaller rows can help the intended case, but it does not outweigh the
keyed-write regression, the 768 KiB median regression, or the absent
Worker-consumer gain. Large-event tails contain multi-hundred-millisecond to
multi-second platform outliers; the chunked p50 is only 1.91% better when
comparing median runs and is classified as neutral.

### Decision And Collapse

Schema 9 is rejected and its production diff is not integrated. It trades 231
added and 88 removed lines in storage/tests for workload-specific local wins,
but deployed evidence shows no coherent end-to-end benefit and exposes real
regressions. The clean collapse is therefore immediate: shipping remains on
schema 8 with no migration branch, fallback path, second persistence model, or
runtime flag. The isolated experiment remains at
`experiment/stream-column-envelope` commit `639e98a3d4df618a2925b90869d9aa6351753621`
for evidence only.

The reusable deployed benchmark lane remains because it closes a previous
measurement gap for real Worker consumers. Raw Worker records are
`/tmp/schema9-preview5-{main,candidate}-worker-r*.log`; storage records are
`/tmp/schema9-preview5-{main,candidate}-storage-r{1,2}.log`. Preview 5 was
restored to shipping OS version `a0e07804-fac5-4858-95eb-a5e37c9532d0`, and
dashboard, event-docs, OS-API, and auth-RPC smoke checks passed. Production was
not deployed or erased.

## 2026-07-14: Receiver-Side `processEvent` Collapse Accepted

### Implementation And Correctness Boundary

The rejected per-event wire experiment above established the boundary: Stream
delivery must remain one batched RPC, acknowledgement, and cursor unit. The
receiver no longer needs to expose that transport unit to ordinary handlers.
The accepted implementation does two small things:

- `IterateWorkerEntrypoint` and `IterateDurableObject` call `processEvent`
  synchronously and await only a returned promise. Synchronous handlers no
  longer pay one forced promise and microtask boundary per event.
- `iterate/sdk` exports `subscribe(stream, { processEvent, ...options })`. The
  helper installs one internal `processEventBatch` callback, receives one wire
  batch, and invokes the user handler locally in order.

Asynchronous handlers are still awaited in order, rejection still rejects the
batch, and no acknowledgement or cursor advances before handler settlement.
Ten embedded-SDK runtime tests cover synchronous no-yield delivery, asynchronous
ordering, rejection propagation, both base classes, the subscription helper,
and generated-module loading.

An actual Worker experiment exposed a separate lifecycle rule. A callback
capability supplied by a Workers RPC invocation disconnects when that
invocation returns; retaining only the subscription handle in a stateless
Worker field does not extend the callback lifetime. The deployed benchmark now
keeps the initiating invocation pending until every completion is observed,
and the SDK documentation states this requirement.

### Receiver And Exact-Parent Local Results

A Node receiver-only prefilter ran 500 batches for nine rounds with PCM-shaped
events. Positive change means less dispatch time. The asynchronous control was
unchanged; the synchronous path removed the forced per-event promise cost.

| Events per batch | Previous adapter | Conditional-await adapter | Speedup |
| ---------------: | ---------------: | ------------------------: | ------: |
|               32 |         0.967 ms |                  0.273 ms |   3.55x |
|              128 |         3.691 ms |                  0.745 ms |   4.96x |
|              512 |        14.846 ms |                  2.914 ms |   5.09x |
|            2,048 |        62.706 ms |                 14.617 ms |   4.29x |

The SDK subscription helper's extra function dispatch was then isolated from
network effects. Across 3,000 batches of 1,000 events per round, its median
cost was 24.856 ms per three million events versus 4.190 ms for a hand-written
batch loop. That is a 6.9 microsecond absolute increment per 1,000-event batch,
or about 6.9 nanoseconds per event. The large relative percentage is an
artifact of both loops taking only microseconds per batch.

The exact shipping parent and candidate then ran in local workerd with five
fresh processes per revision, 20 singleton observations and 50 1,000-event
PCM observations per process. Every candidate process beat every baseline
process on the batch path.

| 1,000 x 1,920-byte batch | Previous adapter | Candidate | Improvement |
| ------------------------ | ---------------: | --------: | ----------: |
| p50                      |        53.799 ms | 49.726 ms |       7.57% |
| p95                      |        64.645 ms | 58.123 ms |      10.09% |
| mean                     |        54.829 ms | 50.317 ms |       8.23% |

### Deployed Durable Worker Consumer

The deployed lane timed only on the Node host around actual network I/O:

```text
Node host -> OS Worker -> source Stream DO -> Project Worker processEventBatch
          -> local processEvent -> OS Worker -> output Stream DO -> Node waiter
```

Five alternating deployment-period runs per revision initially showed the
candidate ahead by 11.54% at pooled p50, 9.96% at p95, and 10.40% at mean for
1,000 PCM events. Because deployment weather was material, the stronger lane
selected the old or new loop from the event payload inside one deployed Worker
version. Seven fresh projects produced 105 valid batch pairs:

| Deployed durable batch | Previous adapter |  Candidate | Improvement |
| ---------------------- | ---------------: | ---------: | ----------: |
| pooled p50             |       233.645 ms | 222.287 ms |       4.86% |
| pooled p95             |       695.938 ms | 571.228 ms |      17.92% |
| pooled mean            |       348.336 ms | 306.965 ms |      11.88% |

The median within-pair improvement was 2.28%; the candidate won 55 of 105
pairs, and both execution-order strata favored it. One separate 40-pair
process was excluded in full after Cloudflare reported R2 backup throttle code 10058. It was infrastructure failure, not latency data.

### Deployed Ephemeral Subscription

The first whole-helper A/B used the real exported `subscribe` helper in a
deployed Project Worker but assigned baseline and candidate to different source
Stream DOs. Seven valid projects produced 105 pairs. That lane failed its 5%
non-inferiority gate: candidate pooled p50 was 4.40% slower and paired median
was 3.74% slower, although p95 was 2.24% better. Only 47 of 105 pairs favored
the helper. The local 6.9-microsecond result showed that the 9.3-millisecond
pooled gap could not plausibly be receiver dispatch, so the physical-stream
confounder was removed rather than rationalized.

The decisive lane used one source Stream DO, one ephemeral batched callback,
one output Stream DO, and payload-selected old/new receiver loops. Seven fresh
projects completed all 105 1,000-event pairs. Positive change favors
`processEvent`:

| Shared-transport result | Previous adapter | `processEvent` |  Change |
| ----------------------- | ---------------: | -------------: | ------: |
| pooled p50              |       205.546 ms |     211.278 ms |  -2.79% |
| pooled p95              |       536.181 ms |     594.663 ms | -10.91% |
| pooled mean             |       265.742 ms |     281.453 ms |  -5.91% |
| paired median change    |              n/a |            n/a |  +1.57% |
| within-pair wins        |              n/a |         57/105 |     n/a |

Both execution-order strata were non-negative for the candidate (+3.23% and
+0.003%). Six of seven per-project median changes were within 1.6%; the seventh
was -4.92%. This supports central-path parity for receiver-side dispatch. It
does not prove tail parity: random multi-second Cloudflare stalls were larger
on the candidate samples in this collection, so no p95 or mean improvement is
claimed.

The final lane exercised the actual exported helper while retaining one
physical source Stream DO. It installed two ephemeral subscriptions on that
source: the baseline used `processEventBatch`, the candidate used
`subscribe(source, { processEvent })`, and distinct event-type filters selected
the path. Both wrote completion events to the same output Stream DO. Twelve
fresh projects each completed 40 alternating 1,000-event pairs with 1,920-byte
PCM-shaped payloads, for 480 valid pairs and no exclusions:

| Actual-helper deployed result | Previous adapter | `processEvent` |  Change |
| ----------------------------- | ---------------: | -------------: | ------: |
| pooled p50                    |       194.874 ms |     197.152 ms |  -1.17% |
| pooled p95                    |       546.734 ms |     424.564 ms | +22.35% |
| pooled mean                   |       235.688 ms |     237.921 ms |  -0.95% |
| paired median change          |              n/a |            n/a |  -0.40% |
| within-pair wins              |              n/a |        233/480 |     n/a |

This passed every predeclared high-volume gate: pooled p50 and paired-median
slowdown were below 5%, the candidate won 48.54% of pairs, both execution-order
strata were within 5% (-1.04% baseline-first and +0.41% candidate-first), and
both pooled p95 and median per-project p95 were within the 5% tail budget. The
median project p95 change was +6.30%. The observed pooled p95 improvement is
evidence against a regression, not a claimed intrinsic helper speedup; the
receiver-only measurement remains the evidence for removed dispatch overhead.

Each project also completed five singleton pairs. Across 60 pairs, candidate
p50 was 0.95% slower. A single 357.8 ms candidate outlier made p95 12.62% slower
and mean 5.15% slower, so this smaller sample supports only singleton central
parity, not singleton tail parity. All twelve initiating Worker RPC invocations
remained alive through completion; there were no timeouts, order failures, or
callback losses.

One of eight earlier whole-helper projects was invalidated in full after four
successful warmups. Its source append succeeded in 1.234 seconds, but no
completion reached the output Stream DO and the host waiter expired after
60.063 seconds. No Project Worker exception was recorded. The correlated wait
trace is
[`f6a91b92d44cb3d34c271e3a39d82d84`](https://dash.cloudflare.com/376ef7ed81b0573f93524de763666c15/observability/traces/f6a91b92d44cb3d34c271e3a39d82d84),
and the failure remains classified as an unexplained ephemeral capability or
delivery loss rather than benchmark latency. All seven shared-transport
projects completed after the lifecycle fix.

### Decision, Cost, And Collapse

Receiver-side `processEvent` is accepted, while direct per-event wire delivery
remains rejected. The external model can stay append, subscribe, read, and
wait-for-event; `processEventBatch` remains an internal protocol and an escape
hatch only for intentional whole-batch atomicity.

The production source cost is 47 added and 4 removed lines in one SDK module,
plus one regenerated embedded-module line. The rest is 197 lines of runtime
tests and 306 added/27 removed lines in the reusable benchmark. There is no
storage change, migration, flag, service, queue, retry protocol, fallback, or
second subscription transport. Collapse is one helper and two short adapter
loops, so it can be reverted cleanly without data work. Preview 5 was restored
from shipping commit `7a781d177` as Worker version
`1665fbd8-a32a-4f28-a52d-23157021722e`; all four smoke checks passed, and
production was not touched.

Raw records are `/tmp/process-event-local-{main,candidate}-r{1..5}.log`,
`/tmp/process-event-preview5-{main,candidate}-r{1..5}.log`,
`/tmp/process-event-preview5-paired-r{1..7}.log`,
`/tmp/process-event-preview5-ephemeral-r{1..8}.log`, and
`/tmp/process-event-preview5-ephemeral-shared-r{1..7}.log`. The final
actual-helper soak is
`/tmp/process-event-preview5-ephemeral-helper-shared-r{1..12}.log`.

## 2026-07-14: Ninth Current-Main Cumulative Checkpoint

The ninth checkpoint pinned candidate
`c8b29eab6f69669bc9cfd1ae4b16f193f35cee3f` against freshly fetched main
`7b106d623ca1d814304443c0ad34f8e36ac0b0bb`. Two local workerd servers ran
those immutable revisions. The candidate harness targeted each server by its
explicit loopback URL, and every timer ran on the Node host around awaited RPC,
network work, or host-observed delivery. No result uses elapsed time from a
Worker isolate while Cloudflare could freeze its clock.

Four interleaved collections each ran five fresh processes per revision: the
15-workload cumulative suite, enlarged storage controls, enlarged concurrent
append/live-delivery controls, and 200-sample dense/sparse cross-post controls.
All 40 processes passed their semantic assertions. The full suite alone showed
13.514% lower p50, 3.847% lower p95, and 10.253% lower mean latency.

As in checkpoint eight, the headline replaces exactly five noisy full-suite
rows with their pre-existing larger controls: singleton append, 100-event
append, concurrent-32 append, one-subscriber delivery, and 25-subscriber
delivery. It does not substitute the new cross-post controls into the
geometric mean:

| Equal-workload statistic | Improvement versus current main |
| ------------------------ | ------------------------------: |
| p50                      |                     **21.363%** |
| p95                      |                     **11.649%** |
| mean                     |                     **18.571%** |

Focused results were materially stronger than their low-sample rows:

| Focused workload                     | P50 change | P95 change | Mean change |
| ------------------------------------ | ---------: | ---------: | ----------: |
| Append one 1 KiB event               |      8.49% |      1.76% |       3.06% |
| Append 100 tiny events               |     37.01% |     15.85% |      33.69% |
| Append 100 1 KiB events              |     50.43% |     40.13% |      49.23% |
| Append 1,000 tiny events             |     62.42% |     36.84% |      56.56% |
| Append 32 concurrent singleton calls |     38.23% |     29.64% |      37.01% |
| Deliver to one live subscriber       |     25.72% |     19.26% |      22.41% |
| Deliver to 25 live subscribers       |     13.40% |     25.45% |      15.60% |
| Head after forced reactivation       |     36.17% |     29.34% |      36.28% |
| Dense one-event cross-post           |     35.76% |     36.52% |      34.12% |
| Sparse cross-post, 1 of 100 events   |     42.14% |     35.68% |      39.42% |

P50-derived capacity improved 58.76% for 100-event append, 61.90% for 32
concurrent singleton appends, and 15.48% for 25-subscriber fanout. The original
20-sample sparse cross-post row had shown a 77.82% p95 regression; at 200
samples per run, both cross-post controls improved p50 and p95 in all five
candidate runs. Substituting those two controls as well would produce
23.769%/17.077%/21.036% p50/p95/mean improvement, but that number is not the
headline because it changes the prior aggregation rule.

The remaining full-suite tail caveats are warm sparse read and latest-match
read p95 at -5.10% and -5.34%, while their p50s improve 17.85% and 14.03%.
Hot-head mean is 6.91% worse despite a 9.64% p50 win. Those rows have only 30,
30, and 80 observations per process respectively and are not claimed as
regressions or wins without focused confirmation. No code changed during this
checkpoint. Raw records are
`/tmp/cumulative-9-{full,focus,tail,crosspost}-{main,candidate}-r{1..5}.log`.
The collection ended at `2026-07-14T22:04:40Z`; if active optimization
continues, the next current-main checkpoint is due by
`2026-07-15T02:04:40Z`.

## 2026-07-14: Deployed Reset Recovery And PCM Reconfirmation

Commit `7b13cd80add08ec2a71eea0bcf43c75426c60b82` was deployed to leased
preview 5 as OS Worker version `136cd4ee-5bab-434f-82f8-eb93817608ed`.
The deployed reset E2E entered through the public Worker/WebSocket capability,
installed a one-shot wait, killed the actual Stream Durable Object, appended
while the original handle was dead, and observed the replay through the
original promise in 10.39 seconds. This confirms that the Worker-owned
heartbeat detects a changed Stream incarnation and resumes after the latest
synchronously delivered offset.

The timer did not provide the liveness signal. Each active utility waiter sends
one tiny `ping()` per second over Workers RPC, both detecting reset and
providing real network I/O while Cloudflare may freeze the Worker clock. Normal
event completion remains push-based. The heartbeat is absent from `append`,
ordinary `subscribe`, configured delivery, and hosted processing.

The same deployment then re-ran the actual exported `processEvent` helper over
the complete topology:

```text
Node host -> source Stream DO -> Project Worker callback
          -> output Stream DO -> Node waiter
```

Seven fresh projects each ran 40 alternating pairs of 1,000 events with
1,920-byte PCM-shaped payloads. The baseline used `processEventBatch`; the
candidate used `subscribe(source, { processEvent })`. Both subscriptions read
the same source Stream DO and wrote completion events to the same output Stream
DO. All 280 pairs completed without loss, reordering, timeout, or callback
lifetime failure. Timers ran only on the Node host around source append and
host-observed output.

| Post-reset deployed result | Previous loop | `processEvent` |  Change |
| -------------------------- | ------------: | -------------: | ------: |
| pooled p50                 |    187.900 ms |     189.688 ms |  -0.95% |
| pooled p95                 |    437.881 ms |     338.337 ms | +22.73% |
| pooled mean                |    221.680 ms |     210.125 ms |  +5.21% |
| paired median              |           n/a |            n/a |  +0.35% |
| within-pair wins           |           n/a |        144/280 |     n/a |

The baseline-first stratum's paired median was -1.76%; the candidate-first
stratum's was +2.11%. The median per-project p50 change was -0.84%, and the
median per-project p95 change was +33.91%. This passes the predeclared 5%
high-volume non-inferiority gates and reconfirms parity. The observed p95 and
mean gains are evidence against a regression, not claimed intrinsic helper
speedups. Across 35 singleton pairs, `processEvent` was 1.36% slower at pooled
p50, 43.15% faster at observed p95, and 1.73% slower by paired median, which
also supports central parity at the smaller sample size.

The recovery checkpoint replaces 73 lines of Durable Object-local wait logic
with a 180-line Worker utility and 125 focused test lines. The full checkpoint,
including deployed regression coverage and stale-test corrections, is 433
additions and 108 removals. Its runtime complexity is isolated to the utility
waiter and one connection-pump ownership guard; it adds no schema, migration,
queue, service, fallback protocol, or traffic to the Stream hot path. All PR
checks passed, including the full preview deployment and browser E2E suite.
Production was not deployed or erased. Raw PCM records are
`/tmp/process-event-preview5-post-reset-r{1..7}.log`.

## 2026-07-14: Tenth Current-Main Cumulative Checkpoint

The tenth checkpoint pinned candidate
`716728ff7f2d48eb4dac25aee5f48c9c962da6f6` against freshly fetched main
`7b106d623ca1d814304443c0ad34f8e36ac0b0bb`. Two local workerd servers ran
those exact revisions. The candidate harness targeted each by an explicit
loopback URL. Every timer ran on the Node host around awaited network/RPC work
or host-observed delivery; no result uses elapsed time from a Worker isolate
while Cloudflare could freeze its clock.

The first provisional collection exposed a benchmark-client defect on both
candidate and main: after the server had completed every RPC, repeated forced
reactivation could leave the host Cap'n Web client unsettled. The harness had
also reused a Stream capability created before the first `kill()` for every
later kill. Commit `716728ff7` gives each destructive control call a disposable
session while retaining the existing measured connection for the head read,
and puts 30-second Node-host deadlines around concurrent append groups and
cold reads. This is 67 additions and 15 removals in the opt-in benchmark only;
it changes neither production code nor successful timing boundaries. The
provisional records were invalidated.

Four corrected interleaved collections each ran five fresh processes per
revision: the 15-workload cumulative suite, 200-sample storage controls,
200-sample concurrent append plus 300-sample live-delivery controls, and
200-sample dense/sparse cross-post controls. All 40 processes passed their
semantic assertions. The full suite alone showed 14.499% lower p50, 1.013%
lower p95, and 9.852% lower mean latency.

The headline keeps the checkpoint-eight/nine aggregation rule: replace exactly
five noisy full-suite rows with their larger existing controls (singleton
append, 100-event append, concurrent-32 append, one-subscriber delivery, and
25-subscriber delivery), then take the equal-workload geometric mean. It does
not substitute the enlarged cross-post controls:

| Equal-workload statistic | Improvement versus current main |
| ------------------------ | ------------------------------: |
| p50                      |                     **17.560%** |
| p95                      |                      **4.226%** |
| mean                     |                     **14.579%** |

Focused median-of-five-run results were:

| Focused workload                     | P50 change | P95 change | Mean change |
| ------------------------------------ | ---------: | ---------: | ----------: |
| Append one 1 KiB event               |     19.66% |     14.98% |      17.65% |
| Append 100 tiny events               |     40.08% |     26.63% |      36.35% |
| Append 100 1 KiB events              |     54.71% |     45.38% |      52.70% |
| Append 1,000 tiny events             |     61.42% |     43.16% |      57.31% |
| Append 32 concurrent singleton calls |     23.64% |     16.23% |      18.76% |
| Deliver to one live subscriber       |     12.29% |     10.71% |      12.60% |
| Deliver to 25 live subscribers       |      6.58% |      7.91% |       6.24% |
| Head after forced reactivation       |      3.68% |     -9.05% |       2.50% |
| Dense one-event cross-post           |     16.45% |     12.29% |      15.76% |
| Sparse cross-post, 1 of 100 events   |     19.74% |     13.20% |      19.04% |
| Append one inline 768 KiB event      |     52.18% |     38.88% |      42.36% |
| Append one chunked 1.1 MiB event     |      4.72% |      8.92% |       6.79% |

P50-derived capacity improved 66.89% for 100-event append, 30.95% for 32
concurrent singleton appends, and 7.05% for 25-subscriber fanout. Substituting
the enlarged cross-post controls too would produce
18.650%/12.790%/16.770% p50/p95/mean improvement, but that is not the headline
because it changes the established aggregation rule.

The meaningful residual tail caveats are forced-reactivation p95 at 9.05%
slower and the low-sample replay-subscribe p95 at 7.13% slower. Cold-head p50
and mean still improve, and the enlarged concurrent, live-delivery, and both
cross-post controls reverse their noisy full-suite p95 rows. These results do
not justify a tail win for reactivation, but they continue to show broad
central-latency and throughput gains without a general p95 collapse.

Raw corrected records are
`/tmp/cumulative-10-{full,storage,tail,crosspost}-{main,candidate}-r{1..5}.log`.
The collection ended at `2026-07-14T23:34:01Z`; if active optimization
continues, the next current-main checkpoint is due by
`2026-07-15T03:34:01Z`. Production was not deployed or erased.

## 2026-07-14: Deployed Reset, Re-wake, And Retry Soak

Preview 5 was green at draft head `ba7cdab2e`, including its normal deploy and
end-to-end lane. Two additional deployed soaks then targeted
`https://os.iterate-preview-5.com` through the public Worker/Cap'n Web surface.
Each process had a 120-second Node-host deadline; completion did not depend on
a Worker isolate timer advancing while Cloudflare could freeze its clock.

Ten fresh reset/re-wake processes each ran two scenarios on independent
projects:

1. Tear down a root Stream's configured processor connections, append after
   they are absent, and require every configured subscriber to re-dial from its
   checkpoint.
2. Start a public `waitForEvent`, observe its internal subscription, kill the
   actual Stream Durable Object, append through the replacement incarnation,
   and require the original promise to receive the exact durable event.

All 20 scenarios passed without loss, timeout, stale-handle failure, or failed
re-dial. Whole-scenario wall time, including project/session setup, was 7.749 s
p50 / 8.813 s observed p95 for configured re-wake and 9.745 s p50 / 14.376 s
observed p95 for wait recovery. These are soak timings, not isolated Stream DO
latency claims.

Ten more fresh processes each ran two durable-delivery scenarios:

1. Configure source-to-target cross-posting, require an exact provenance copy,
   replay/replace the subscription, and prove the idempotency key collapses the
   duplicate.
2. Exercise frame-level exact retry across target-DO reset, reject a delivery
   while paused, resume, retry, and require every newly eligible event exactly
   once.

All 20 delivery/retry scenarios passed. Whole-scenario p50 / observed p95 was
9.738 / 10.567 s for configured copying and 9.594 / 11.720 s for exact retry.
Seven complete local reset/re-wake pre-soak processes also passed. An eighth
local process stalled before Vitest entered its run while unrelated long-lived
test processes were active on the machine; it was terminated and excluded as
a host-runner failure, not counted as Stream evidence.

Raw deployed records are `/tmp/stream-reset-soak-preview5-r{1..10}.log` and
`/tmp/stream-retry-soak-preview5-r{1..10}.log`. This soak changed no production
code, schema, protocol, or preview configuration. Production was not deployed
or erased.

## 2026-07-15: Exact-Type Wake Storage Preselection Rejected

### Hypothesis And Real Consumer Lane

Configured wake processors publish exact `consumes` lists, but their backlog
connection currently reads each bounded raw page and applies that selector in
JavaScript. The prototype passed those exact types into the existing
push-oriented storage frame scan, which advances the raw cursor while
materializing only matching durable payloads. Ephemeral subscriptions stayed
on the raw reader because they must see transient rows.

The focused benchmark uses a real agent Durable Object as the configured wake
consumer. Before every sample it kills that consumer through a fresh control
session, appends 4,000 events to the agent's Stream Durable Object, and waits
for the replacement agent processor to checkpoint through the appended head.
Sparse samples match none of the agent processor's declared types; dense
samples match all of them. Every timer runs on the Node host around append
through observed processor checkpoint recovery.

An initial collection exposed the same Cap'n Web harness rule as forced Stream
reactivation: reusing an agent capability created before the first `kill()`
could leave the host client unsettled after the server had completed append and
`waitUntilEvent`. Those provisional samples were invalidated. The retained
benchmark creates a fresh session and agent capability for every destructive
kill and measured iteration and places 30-second host deadlines around kill,
head, append, and checkpoint observation.

### Exact-Parent Result And Decision

Candidate and exact parent `cb7ce6055c060897d30dbc8ea0a0d458f51d348a`
ran in separate local workerd servers in
`C,P,P,C,C,P,P,C,C,P` process order. Five processes per implementation each
contributed five sparse and five dense samples; all 50 corrected scenarios
passed their offset/checkpoint assertions.

| 4,000-event configured catch-up | Parent p50 | Candidate p50 |        P50 change |    P95 change |   Mean change |
| ------------------------------- | ---------: | ------------: | ----------------: | ------------: | ------------: |
| Sparse, 0% selected             |  43.564 ms |     45.802 ms |  **5.14% slower** | 15.10% slower |  6.76% slower |
| Dense, 100% selected            |  60.812 ms |     67.205 ms | **10.51% slower** | 11.82% faster | 10.10% slower |

Median-of-five-run p50 agreed: sparse was 5.14% slower and dense was 14.18%
slower. The existing selected-frame SQL plan pays for raw-boundary and
byte-window CTEs that durable push needs; avoiding nonmatching JSON parsing did
not repay that plan cost in this wake topology. The production prototype and
its unit test are rejected and removed. No second wake query, type index,
heuristic branch, schema, or migration is retained.

The 98-line opt-in benchmark remains because exact-type configured catch-up was
previously absent from the cumulative harness and because its fresh-capability
kill discipline prevents false hangs in later experiments. Raw corrected
records are `/tmp/stream-wake-selector-{main,candidate}-r{1..5}.log`.
Production was not deployed or erased.

## 2026-07-15: Eleventh Current-Main Cumulative Checkpoint

The eleventh checkpoint pinned candidate
`3423e25e90a25e4713e01fe2a571993dc01a0510` against freshly fetched main
`7b106d623ca1d814304443c0ad34f8e36ac0b0bb`. Separate local workerd servers
ran those exact revisions. Every timer ran in the Node host around awaited
network/RPC work or host-observed output; no result depends on a Worker clock
advancing without network I/O.

Five fresh processes per revision ran each of the full cumulative suite,
storage controls, concurrent/live-tail controls, and enlarged cross-post
controls. Every process passed its semantic assertions. The unmodified full
suite geometric result was 24.628% lower p50, 11.181% lower p95, and 22.719%
lower mean latency.

The conservative headline retains the established checkpoint-eight through
ten rule: replace exactly singleton append, 100-event append, concurrent-32
append, one-live-subscriber delivery, and 25-live-subscriber delivery with
their larger focused controls, then take the equal-workload geometric mean.
It does not substitute the enlarged cross-post controls:

| Equal-workload statistic | Improvement versus current main |
| ------------------------ | ------------------------------: |
| p50                      |                     **22.857%** |
| p95                      |                      **9.148%** |
| mean                     |                     **21.406%** |

Focused median-of-five-run results were:

| Focused workload                     | P50 change | P95 change | Mean change |
| ------------------------------------ | ---------: | ---------: | ----------: |
| Append one 1 KiB event               |     14.19% |      5.82% |      12.74% |
| Append 100 tiny events               |     40.31% |     28.89% |      35.74% |
| Append 100 1 KiB events              |     52.74% |     44.54% |      50.90% |
| Append 1,000 tiny events             |     62.06% |     51.59% |      58.40% |
| Append 32 concurrent singleton calls |     32.86% |     21.33% |      30.02% |
| Deliver to one live subscriber       |     13.10% |     12.64% |      11.84% |
| Deliver to 25 live subscribers       |     13.27% |     18.13% |      18.29% |
| Head after forced reactivation       |     12.33% |     -5.69% |      11.71% |
| Dense one-event cross-post           |     26.15% |     27.15% |      27.29% |
| Sparse cross-post, 1 of 100 events   |     37.33% |     30.88% |      35.72% |
| Append one inline 768 KiB event      |     53.03% |     37.10% |      39.88% |
| Append one chunked 1.1 MiB event     |     -1.25% |    -16.19% |      -1.10% |

P50-derived capacity improved 67.52% for 100-event append, 48.95% for 32
concurrent singleton appends, and 15.30% for 25-subscriber fanout. The
enlarged dense and sparse cross-post controls improved every statistic but are
still excluded from the headline to preserve the prior aggregation rule.

The meaningful residual caveats are forced-reactivation p95 at 5.69% slower
and chunked 1.1 MiB p95 at 16.19% slower. The chunked path is neutral at p50
and mean, so this does not establish a central regression, but it remains a
tail investigation rather than a shipping win. Raw records are
`/tmp/cumulative-11-{full,storage,tail,live,crosspost}-{main,candidate}-r{1..5}.log`.
The collection ended at `2026-07-15T01:23:09Z`; if active optimization
continues, the next current-main checkpoint is due by
`2026-07-15T05:23:09Z`. Production was not deployed or erased.

## 2026-07-15: Bounded Dynamic Worker Recovery Deployed

Preview 5 deployed exact runtime head `2a69d0eb20156c558acc45798c37f956dbf00aac`
after the local Loader recovery proof described above. Three independent
deployed runs crossed the real topology from the Node host through the OS
Worker, source Stream Durable Object, project Worker Loader, and output/probe
Stream Durable Objects. Each synthetic exact clone failure recovered through
one anonymous Loader, delivered the exact event once at the idempotent output,
advanced the source subscription cursor, and reused the recovered Loader for
the following delivery.

This closes the preview gate for the bounded recovery mechanism. It does not
claim that a synthetic message classifier reproduces Cloudflare's internal
Loader fault; the production observation remains the evidence for that fault,
and the deterministic injection proves only our handling once that exact error
crosses the boundary. The runtime cost remains one stable named Loader, one
exact resolved artifact shared by both attempts, and at most one sticky
anonymous fallback per runner/artifact. Production was not deployed or erased.

## 2026-07-15: Paused Destination Cannot Poison-Skip Healthy Events

The first deployed 24-cycle mixed recovery soak on earlier head `937ac2e5c`
failed after delivering 23 of 24 events in cycle 2. Durable inspection proved
that source offset 21, sequence 16, had not been lost by append or storage. The
source had instead committed
`push-poison-skipped:project-worker:21` after three attempts and advanced its
cursor through the later events.

The target Stream was intentionally paused while the source project-worker
subscription delivered. Its ordinary append rejected with a generic
`Error("stream paused ...")`; the source subscription's `onPoison: "skip"`
policy therefore classified an operator-controlled whole-destination outage
as evidence that the healthy source event itself was poison. That distinction
is now explicit: paused ordinary append throws
`StreamReceiverUnavailableError`, so Workers RPC keeps the batch behind the
same cursor and the existing availability backoff retries it after resume.
Cap'n Web still reconstructs a generic public error, so the public E2E asserts
the message while the durable upstream regression asserts cursor behavior and
the absence of a poison fact.

The deployed regression configured an actual durable push subscription over
Workers RPC with `onPoison: "skip"`, paused its target, waited through at least
three attempts, and proved that the source cursor stayed immediately before
the healthy event. After target resume the exact cross-post arrived and the
source cursor advanced, with no poison-skip fact before or after recovery.

Two independent deployed mixed soaks then ran 24 alternating source-kill,
output-kill, paused-dual-kill, and idle-control cycles with batches of eight.
All 384 events arrived exactly, in order, with zero append retries:

| 24-cycle deployed soak |   Run 1 |   Run 2 |
| ---------------------- | ------: | ------: |
| events delivered       |     192 |     192 |
| settle p50             | 0.801 s | 1.001 s |
| settle p95             | 4.309 s | 4.749 s |
| maximum settle         | 4.722 s | 5.393 s |

These are forced-eviction recovery timings, not ordinary delivery latency.
The multi-second tail is the deliberate retry/backoff cost of preserving the
whole batch across unavailability. Raw records are
`/tmp/stream-mixed-recovery-preview5-2a69d0e-r{1,2}.log`. Production was not
deployed or erased.

## 2026-07-15: Deployed 640-Byte PCM `processEvent` Reconfirmation

Exact preview head `2a69d0eb2` re-ran the actual Worker-consumer topology with
1,000 640-byte PCM-shaped frames per append. Node-host timers enclosed source
append through output completion, so the result does not depend on a Worker
clock advancing without network I/O. Durable delivery used one source Stream
DO, the project Worker, and one output Stream DO. Ephemeral delivery installed
both callbacks on one physical source Stream DO and used the same output.

For the durable paired callback, the baseline awaited every
`processEvent(event)` result and the candidate discarded undefined returns,
awaiting only the final asynchronous completion. For the ephemeral pair, the
baseline supplied `processEventBatch` and the candidate used the exported
`subscribe(..., { processEvent })` helper over the same transport.

| 1,000 x 640-byte deployed path | Previous loop | `processEvent` |       Change |
| ------------------------------ | ------------: | -------------: | -----------: |
| durable p50                    |    138.510 ms |     138.242 ms | 0.19% faster |
| durable mean                   |    141.955 ms |     145.799 ms | 2.71% slower |
| durable throughput             |     7,219.7/s |      7,233.7/s | 0.19% faster |
| ephemeral p50                  |    145.735 ms |     147.101 ms | 0.94% slower |
| ephemeral mean                 |    147.575 ms |     150.795 ms | 2.18% slower |
| ephemeral throughput           |     6,861.8/s |      6,798.0/s | 0.93% slower |

With 20 batch samples per side, the observed p95 values were 199.522 versus
232.225 ms durable and 271.566 versus 277.115 ms ephemeral. Those small
collections are too noisy for a tail claim, but they do not change the central
result: 1,000 user-level per-event calls are within about 1% at p50 and
throughput in both real deployed push modes. This reconfirms the accepted API
boundary: external subscriptions can expose `processEvent`; batching remains
an internal transport, persistence, acknowledgement, and cursor concern.

Raw records are
`/tmp/stream-worker-consumer-pcm-durable-preview5-2a69d0e.log` and
`/tmp/stream-worker-consumer-pcm-ephemeral-preview5-2a69d0e.log`. Production
was not deployed or erased.

## 2026-07-15: Search Segment Rewrite Race Identified

Trace `2a88f158a4e8a696b83304a21a648138` ruled out the observed R2 code 10058
as the cause of Stream delivery loss: search indexing is caught under
`waitUntil`, while project Worker delivery is the only awaited acknowledgement.
It did expose an independent correctness defect in the derived search corpus.
Eight delivery batches launched eight reads and up to seven concurrent writes
to the same R2 segment in 1.4 seconds. A newer 6,979-byte snapshot completed
first; an older 6,720-byte snapshot completed later and became the final
object. A quiet stream could therefore remain permanently regressed until a
later delivery or explicit reindex.

The next isolated experiment coalesces work by project/path/segment, uses
source offsets as the ordering watermark, serializes same-key rewrites, leaves
different keys parallel, and uses an R2 conditional write if the Workers API
can robustly prevent cross-isolate stale replacement. On the exact trace shape
this should reduce eight reads/writes to about two or three, cutting same-key
R2 operations and bytes by 62.5% to 75%. It is not yet a shipping claim; the
prototype must prove final highest-offset content under controlled races and a
deployed burst before integration.

## 2026-07-15: True Legacy KV Rewrite Rejected

The earlier `ctx.storage.kv` observation was not enough because that API is
implemented over the same SQLite engine. A separate true legacy-class Durable
Object prototype therefore rebuilt the event store over asynchronous legacy KV
and compared it with a synchronous SQLite class under one otherwise identical
Worker. Three independent trials contributed 75 Node-host samples per workload
and implementation. Timers enclosed the complete HTTP, Worker-to-DO RPC,
storage output-gate, and response path; no Worker-local elapsed clock was used.

| Host-timed workload           | SQLite p50 | Legacy KV p50 | Regression |
| ----------------------------- | ---------: | ------------: | ---------: |
| One 1 KiB append              |   0.941 ms |      0.962 ms |       2.3% |
| 1,000 tiny events             |   3.330 ms |      3.493 ms |       4.9% |
| 100 x 1 KiB                   |   1.535 ms |      1.643 ms |       7.0% |
| One 768 KiB event             |   4.086 ms |      4.506 ms |      10.3% |
| Read 500 of 5,000             |   1.945 ms |      2.184 ms |      12.3% |
| Filter 10 of 1,000            |   0.890 ms |      1.216 ms |      36.6% |
| 32 concurrent singleton calls |  11.515 ms |     11.865 ms |       3.0% |

Derived throughput fell from about 300k to 286k events/s for 1,000-event
batches, 65.1k to 60.9k events/s for 100 x 1 KiB, 183.5 to 166.4 MiB/s for the
768 KiB path, and 2.78k to 2.70k calls/s under 32-way concurrency.
`storage.sync()` produced no repeatable benefit: workerd already schedules one
flush for the dirty set and attaches confirmed writes to the output gate;
`sync()` only waits for that scheduled flush.

The code cost is also categorically worse. A production replacement would own
segmentation, chunks, head metadata, idempotency indexes, pagination, filtered
scans, cleanup, eviction recovery, crash testing, and asynchronous reentrancy.
Removing backward compatibility eliminates migration work, but none of those
runtime invariants. The prototype passed its implemented correctness checks,
82 existing Stream storage tests, TypeScript, and a Wrangler dry run, but does
not implement the additional crash, cursor, eviction-floor, and frozen-clock
timeout machinery required for shipping.

The rejection is preserved locally on branch
`experiment/stream-legacy-kv-yolo` at commit `8f2011a3d`. It changes no
shipping code, schema, deployment, or production data.

## 2026-07-15: Direct Project-Worker Delivery Preserved, Not Shipped

An isolated redesign bypassed generic ITX root minting and expression
evaluation for the exact built-in `project-worker` / `["processEventBatch"]`
subscription. It dispatches through a shared `ProjectStreamConsumer`; custom
expressions retain the generic evaluator. Worker invocation, stream activity,
agent status, search indexing, bounded Loader fallback, paused-destination
classification, cursor acknowledgement, and poison handling all remain shared
between the two routes.

The branch passed 448 broad tests, 120 focused tests, OS typecheck, lint,
format, and deployed Loader and mixed-recovery proofs. The deployed mixed soak
delivered all 192 events through 24 forced-recovery cycles with zero append
retries. The first three 20-sample Worker-to-Stream-DO processes looked
promising when pooled:

| 1,000 x 640-byte callback | Generic route | Direct route | Change |
| ------------------------- | ------------: | -----------: | -----: |
| p50                       |    141.005 ms |   127.541 ms |  -9.5% |
| mean                      |    146.282 ms |   131.199 ms | -10.3% |
| p50-derived capacity      |     7,091.9/s |    7,840.6/s | +10.6% |
| p95                       |    178.239 ms |   202.763 ms | +13.8% |

That result did not survive a larger alternating-deployment check. A later
50-sample direct period measured 110.812 ms p50, 221.694 ms p95, and 151.658 ms
mean, while the following 50-sample generic period measured 93.631 ms p50,
120.474 ms p95, and 98.746 ms mean. The final direct repeat then failed when
Cloudflare reset a Durable Object for an internal storage error, reference
`d99an1rdute4id703mlsh1jd`.

These periods were not isolated infrastructure. Telemetry showed unrelated
high-volume Cloudflare API scans, R2 same-key throttling, multi-second
`touchStreamActivity` and `getHead` RPCs, and 60-second force-closed spans on
the same preview. The storage reset is therefore not attributed to the direct
route, but neither is the earlier central win accepted. The optimization is
not shipping without a clean, interleaved experiment that reproduces the
median gain and removes the p95 regression.

The coherent refactor remains useful architecture research: it reduces the
generic RPC-target implementation while centralizing built-in consumer side
effects. It is preserved locally on branch `experiment/stream-direct-lane` at
commit `9fd1cbbb3`. Preview 5 was restored to exact shipping head `cddbaa18c`
after the experiment. Production was not deployed or erased.

## 2026-07-15: Search Rewrite Coalescer Accepted After Deployed Race

The search race identified above now has a clean isolated prototype. One
isolate-local writer per project/path/segment shares an active drain, retains
the highest pending source offset, and lets different segment keys proceed in
parallel. The R2 object records `streamThroughOffset`; conditional writes use
the current ETag, and a failed compare-and-swap rereads the winner so an older
isolate cannot replace a newer snapshot. Automatic indexing and explicit full
reindex use the same writer. A null automatic render is a no-op rather than a
delete, and R2 code 10058 retries use `scheduler.wait(1100)` instead of a
Worker-local elapsed clock.

The 37 focused tests cover eight same-key races collapsing to at most one
active and one trailing rewrite, same-key serialization, different-key
parallelism, two-isolate stale-write rejection, null-render ordering, 10058
pacing/retry, failed-drain cleanup, completed-drain lifecycle, and immediate
recognition of a newer conditional-write winner. OS typecheck, targeted lint,
format, and diff checks pass.

The prototype was then deployed as Worker version
`27f2aa79-30c0-4e09-b02e-88a4f615d48a` and exercised through the real
deployed topology: a Worker consumer receiving from a Stream Durable Object,
forwarding into another Stream Durable Object, with source/output kills and
paused-destination recovery. All 96 events arrived exactly once in the final
assertion over 12 cycles, with zero append retries. Node-host timings around
the complete deployed calls measured 815.522 ms p50, 4,841.336 ms p95/max,
and 1,605.104 ms mean settle latency. The long observations were the expected
paused dual-kill backoff paths; no Worker-local elapsed clock was used.

Cloudflare telemetry for the exact project and Worker version showed the hot
output segment completing 27 successful puts with maximum put concurrency one,
zero overlapping put pairs, and zero 10058 failures. The snapshots jumped over
event bursts instead of attempting one rewrite per delivered event. The final
R2 document was fetched independently and contained the highest committed
offset 100. The old implementation's captured eight-event collision attempted
15 puts to one segment, reached concurrency eight with 32 overlapping pairs,
and failed six puts with R2 code 10058. It also demonstrated the correctness
failure: an older 6,720-byte snapshot completed after and replaced a newer
6,979-byte snapshot.

This is accepted primarily as a correctness fix, with the expected throughput
and R2-cost benefit now observed rather than extrapolated. It adds 162 net
production lines and 342 test lines, all confined to derived search indexing;
Stream storage, delivery, callback, cursor, and public API paths do not branch
on it. The isolate-local coalescer is only an optimization: ETag-conditional
puts and the persisted source-offset watermark preserve monotonic snapshots
across isolate churn. If the local map is lost, correctness collapses to extra
reads, conditional-write retries, and explicit full reindex, not event loss or
Stream unavailability. The accepted implementation entered the draft PR at
commits `58a812143` and `0e568690c`. Production was not deployed or erased.

## 2026-07-15: Twelfth Current-Main Cumulative Checkpoint

The twelfth checkpoint pinned candidate
`b65e30af314ac0922dea2d8150c5beaa2bd7e788` against freshly fetched main
`7b106d623ca1d814304443c0ad34f8e36ac0b0bb`. Separate local workerd servers
ran those exact revisions. Node-host timers enclosed awaited network/RPC work
or host-observed output, so Cloudflare's frozen isolate clock cannot create a
false speedup.

Five fresh processes per revision ran each of the complete suite, enlarged
storage/reactivation controls, append-tail controls, live-delivery controls,
and enlarged cross-post controls. All 50 processes and every semantic
assertion passed. The unmodified full-suite geometric result was 38.177%
lower p50, 35.911% lower p95, and 36.498% lower mean latency.

The conservative headline preserves the checkpoint-eight through eleven
substitution rule rather than choosing controls after seeing this result. It
replaces singleton append, 100-event append, concurrent-32 append,
one-subscriber live delivery, and 25-subscriber live delivery with their
larger focused controls, then takes an equal-workload geometric mean:

| Equal-workload statistic | Improvement versus current main |
| ------------------------ | ------------------------------: |
| p50                      |                     **34.312%** |
| p95                      |                     **29.007%** |
| mean                     |                     **32.771%** |

This is a branch-versus-main result for equally weighted workloads, not a sum
of prior percentages and not a production-traffic weighting. The unusually
large change includes all accepted work through the search rewrite coalescer;
one checkpoint does not establish that every environment will reproduce a
stable 34% aggregate win.

Focused median-of-five-run results were:

| Focused workload                     | P50 change | P95 change | Mean change |
| ------------------------------------ | ---------: | ---------: | ----------: |
| Append one 1 KiB event               |     70.76% |     69.43% |      66.08% |
| Append 100 tiny events               |     22.60% |      9.96% |      27.03% |
| Append 100 1 KiB events              |     36.65% |     22.74% |      31.93% |
| Append 1,000 tiny events             |     36.86% |     13.63% |      32.11% |
| Append 100 keyed tiny events         |     16.06% |     12.89% |      21.87% |
| Append 32 concurrent singleton calls |     28.98% |     17.84% |      28.13% |
| Deliver to one live subscriber       |     52.08% |     32.34% |      34.76% |
| Deliver to 25 live subscribers       |      3.04% |     -2.37% |       3.69% |
| Dense post-reactivation replay       |     21.79% |      8.50% |      19.83% |
| Sparse post-reactivation replay      |      9.93% |      2.33% |      14.20% |
| Dense one-event cross-post           |     13.53% |     14.29% |      12.75% |
| Sparse cross-post, 1 of 100 events   |     29.54% |     18.73% |      26.33% |
| Append one inline 768 KiB event      |     50.29% |     40.34% |      43.55% |
| Append one chunked 1.1 MiB event     |      8.26% |      9.24% |       7.87% |

The 25-subscriber row remains neutral under the 5% rule. The first
forced-reactivation collection reported 1.17% lower p50 but 71.61% higher p95;
the larger clean control below did not reproduce it. Raw records are
`/tmp/cumulative-12-{full,storage,tail,live,crosspost}-{main,candidate}-r{1..5}.log`.
Collection ended at `2026-07-15T03:25:24.355Z`; if active optimization
continues, the next current-main checkpoint is due by
`2026-07-15T07:25:24.355Z`. Production was not deployed or erased.

## 2026-07-15: Restored-Lag Threshold Tightening Rejected

The forced-reactivation tail warning received an isolated 1,500-observation
control per revision. Fresh main measured 2.354/2.729/2.989 ms at pooled
p50/p90/p95 and 2.465 ms mean. Exact current head measured
2.192/2.583/2.771 ms and 2.285 ms mean: 6.86% lower p50, 5.35% lower p90,
7.29% lower p95, and 7.30% lower mean. Its p99 was 20.87% higher, but its
maximum was 34.57% lower. The checkpoint's 71.61% p95 regression was therefore
transient noise, not a current branch regression.

A candidate then tightened the restored-lag checkpoint threshold from 64 to
16 events. Across another 1,500 observations it measured 2.188 ms p50,
2.818 ms p95, and 2.299 ms mean versus current head's 2.192/2.771/2.285 ms.
The central differences were below 1%, p95 moved 1.70% in the wrong direction,
and the tighter threshold performs more checkpoint writes. It is rejected.

Raw records are `/tmp/reactivation-fresh-main-r{1..3}.log`,
`/tmp/reactivation-16-parent-r{1..3}.log`, and
`/tmp/reactivation-16-candidate-r{1..3}.log`. No production code, schema, or
deployment changed.

## 2026-07-15: Fair Deployed `processEvent` Parity Proof

Preview 5 ran exact branch revision
`b65e30af314ac0922dea2d8150c5beaa2bd7e788` as Worker version
`0c3e023b-4bb6-4202-b88c-5030faa92028`. Every measured sample appended 1,000
640-byte PCM-shaped frames through the public OS Worker into a source Stream
Durable Object, delivered one private batch to a project Worker, appended a
completion to an output Stream Durable Object, and stopped a Node-host clock
only after observing and validating that completion. No Worker-local elapsed
clock supplied wall time.

The durable baseline explicitly looped the delivered batch, called the same
`processEvent` handler, and awaited only non-undefined results. Candidate mode
delegated the exact same batch to `IterateWorkerEntrypoint`'s real
`super.processEventBatch(batch)` adapter. Thirteen fresh projects contributed
390 valid paired batches:

| Durable push statistic | Explicit batch loop | SDK `processEvent` | Candidate change |
| ---------------------- | ------------------: | -----------------: | ---------------: |
| p50                    |          118.555 ms |         120.115 ms |     1.32% slower |
| p90                    |          275.745 ms |         268.465 ms |     2.64% faster |
| p95                    |          308.605 ms |         291.899 ms |     5.41% faster |
| p99                    |        1,455.080 ms |       1,282.602 ms |    11.85% faster |
| mean                   |          173.676 ms |         158.059 ms |     8.99% faster |
| p50-derived throughput |        8,434.9 ev/s |       8,325.4 ev/s |      1.30% lower |

The paired median favored the adapter by 0.25%, and it won 196 of 390 pairs.
This establishes durable central parity. The observed p90/p95/p99 do not show
an adapter regression, but their positive differences are not claimed as
intrinsic wins.

The ephemeral comparison installed both subscriptions on one physical source
Stream Durable Object and one project Worker. The baseline supplied an
explicit `processEventBatch`; the candidate used the exported
`subscribe(stream, { processEvent })` helper. Both called the same handler and
used the same conditional-await fast path. Because subscriber installation
order itself affected scheduling, eight baseline-first and eight
candidate-first fresh projects were balanced, contributing 480 paired
batches:

| Ephemeral push statistic | Explicit batch loop | SDK `processEvent` | Candidate change |
| ------------------------ | ------------------: | -----------------: | ---------------: |
| p50                      |          134.968 ms |         133.710 ms |     0.93% faster |
| p90                      |          178.387 ms |         174.057 ms |     2.43% faster |
| p95                      |          241.984 ms |         206.858 ms |    14.52% faster |
| p99                      |          618.458 ms |         824.153 ms |    33.26% slower |
| mean                     |          149.702 ms |         149.599 ms |     0.07% faster |
| p50-derived throughput   |        7,409.2 ev/s |       7,478.9 ev/s |     0.94% higher |

The paired median differed by 0.06%, and the adapter won 241 of 480 pairs.
With baseline installed first, candidate p95 looked 26.34% worse; with
candidate installed first, it looked 36.22% better. The tail direction follows
installation order and platform stalls, so neither p95 nor p99 is claimed as
an adapter win or regression. Central throughput and mean are equivalent.

One additional durable attempt failed before measurement on its baseline
warmup. Trace `331953fc4e43583139f14ad53161dbe6` showed the Stream persist a
nack and arm retry while preview 5 emitted ten failing `ItxEntrypoint.get`
RPCs; Cloudflare then terminated the OS Worker for exceeding its memory limit.
The host's 60-second network-backed `waitForEvent` correctly timed out. That
attempt is excluded from latency data and retained as a separate shared-preview
resource/recovery signal, not attributed to either callback arm.

Raw valid records are
`/tmp/process-event-preview5-b65-durable-super-r{1..13}.log`,
`/tmp/process-event-preview5-b65-ephemeral-fair-r{1..8}.log`, and
`/tmp/process-event-preview5-b65-ephemeral-candidate-first-r{1..8}.log`.
The result supports a single public `processEvent(event)` callback for both
durable and ephemeral subscriptions. It does not support replacing internal
batch transport, storage materialization, cursor acknowledgement, or retry
frames with one RPC per event. Production was not deployed or erased.

## 2026-07-15: Three Parallel Redesign Tracks Consolidated

Three independent redesign tracks converged on the same external vocabulary:
`append`, `subscribe`, `read`, and `waitForEvent`. None found a reason to add a
separate append-ack operation or retain `processEventBatch` as the ordinary
user callback.

Track A independently audited the existing implementation and Cloudflare RPC
constraints. Its recommendation is the smallest shipping API: public
per-event callbacks over private bounded batches. The deployed parity proof
above closes its main performance risk without adding production code.

Track B built an executable receiver-owned pull-cursor kernel. The source owns
the synchronous SQLite journal, bounded reads, race-free head waits, and a
coalesced monotonic head notification. The receiver owns its cursor and one
serial bounded-page drain. With 100,000 memory events, page size 1 reached
14.55m events/s, page 256 reached 84.93m/s, and page 1,000 reached 89.47m/s.
A blocked 100,000-append burst retained one in-flight page; the source notifier
collapsed 100,000 published heads to `notifyHead(1)` and
`notifyHead(100000)`. This is promising architecture research, but it still
needs a durable receiver target-head store, cross-object watermark protocol,
retention fencing, selectors, adapters, and deployed RPC/storage proof. It is
preserved locally, outside the shipping PR, on branch
`experiment/stream-pull-kernel-track-b` at commit `3416ea6b0`; all 12 focused
tests pass.

Track C rechecked storage and overload alternatives. True legacy KV remained
2.3% to 36.6% slower than synchronous SQLite while requiring the application
to own segmentation, indexes, crash recovery, and flush scheduling. Segmented
journals were 9% to 22% slower and normalization was neutral. Actor-level
append coalescing improved concurrent-32 and concurrent-128 throughput by
22.5% and 26.5%, but made singleton append 8.8% slower. It is therefore only a
possible overload-specific mechanism, not a default append path.

The coherent collapse is small at the API boundary and deliberately batched
inside: one append, one subscribe callback shape, bounded private pages, and
explicit read/wait utilities. The pull redesign could eventually simplify
source delivery state substantially, but shipping it now would exchange known
complexity for an unproven cross-object durable protocol. The current
recommendation is to ship the callback simplification and accepted local
optimizations, preserve pull cursors as the next architectural prototype, and
keep synchronous SQLite.

## 2026-07-15: In-Flight Follower Append Coalescing Rejected

The actor-resident append queue above paid its singleton tax by delaying every
leader. A narrower experiment moved the queue to the fronting Worker. It sent
the first acknowledgement-only append to the Stream Durable Object
immediately, observed that RPC, and flattened only ordinary followers arriving
while it remained in flight. Result-bearing appends, stream control events,
optimistic-offset appends, reads, subscriptions, runtime inspection,
cross-post receipt, and kill all sealed the current append generation and ran
as ordered barriers. No timer formed the batch: the real Worker-to-Durable
Object network/RPC promise was the window, so frozen isolate clocks could not
strand or shorten it.

The prototype is preserved outside the shipping branch on
`experiment/stream-follower-batch` at commit `70dee5eb3`. It adds 207
production lines (and removes 17), plus 325 test/benchmark lines. Seven focused
generation/order/failure tests and the OS typecheck pass. The first append
returns the exact transport promise; followers are bounded to 128 calls or
1,024 events, and a leader rejection still drains later work.

Exact current head `e3d13a562414190316bd9337becc3cb3ef7960bf` and the
candidate ran in separate local workerd servers. Five fresh Node processes per
revision used host `performance.now()` around awaited Cap'n Web -> OS Worker ->
Stream Durable Object calls. Process order alternated by pair. Each process
measured 600 serial singleton appends, 100 variadic 100-event appends, 300
concurrent-32 waves, 100 concurrent-128 waves, and 300 append-to-live-arrival
samples. Every append result, final offset bound, and live marker assertion
passed.

Geometric paired changes were:

| Workload                           |      p50 latency |   p95 latency |    Mean latency | p50 throughput |
| ---------------------------------- | ---------------: | ------------: | --------------: | -------------: |
| Serial singleton append            | **11.60% worse** |   1.03% worse | **7.02% worse** |              - |
| Existing variadic 100-event append |    12.31% faster | 15.02% faster |   13.10% faster |  14.04% higher |
| 32 concurrent singleton calls      |    23.15% faster | 23.82% faster |   21.46% faster |  30.13% higher |
| 128 concurrent singleton calls     |    39.76% faster | 39.47% faster |   40.47% faster |  65.99% higher |
| Serial append to live arrival      |     8.44% faster | 47.95% faster |   24.95% faster |              - |

The unchanged variadic and live paths also looked materially faster on the
candidate server, exposing a local process-placement advantage. That makes the
concurrency result conservative only in a broad sense, not a clean attribution
for every row. The singleton result nevertheless failed the predeclared 5%
non-regression gate: all five paired p50 ratios were slower (1.076, 1.114,
1.035, 1.353, and 1.031; median 1.076). Observing the leader promise is work
the existing straight-through promise relay does not perform, so the design
cannot claim a free singleton path merely because it dispatches immediately.

More importantly, flattening separate public appends is not
contract-preserving. One variadic Stream DO append is one atomic validation,
reduction, timestamp, storage, and fan-out boundary. A state-invalid follower
therefore rejects otherwise independent neighbors; successful calls acquire a
shared timestamp and delivered batch boundary; a circuit-breaker transition
can admit events that separate calls would reject. Pre-parsing structural
inputs in the Worker does not repair state-dependent failure isolation.

A correct automatic coalescer would require substantially more machinery:

- one isolate-wide ordered lane keyed by canonical project/stream identity,
  rather than one `StreamRpcTarget`, so repeated `streams.get()` capabilities
  in the same isolate share order;
- a private grouped DO operation that retains each public variadic call as a
  separate transaction and returns a per-group success/error outcome;
- byte, event, request, and caller bounds; exact error-name transport; idle
  lane cleanup; capability-safe subscription barriers; and no retry after an
  ambiguous transport failure.

That design still cannot coalesce writers in other isolates, sessions, or
regions, and still must observe the leader RPC that produced the singleton
regression. The complexity is not an elegant collapse: it duplicates ordering
and error-demultiplexing policy outside the Stream DO for an overload-only win
callers can already obtain with explicit variadic `append(...events)`.

The candidate is rejected and was not deployed. Raw records are
`/tmp/follower-batch-{baseline,candidate}-r{1..5}.log`. The exact-head preview
and production were untouched; no data was erased.

## 2026-07-15: Thirteenth Current-Main Cumulative Checkpoint

The thirteenth checkpoint pinned exact candidate
`5a4a0c350f14d06a521a814bb4ac637a9ac73af1` against freshly fetched main
`7b106d623ca1d814304443c0ad34f8e36ac0b0bb`. Separate local workerd servers
ran those immutable revisions. Node-host timers enclosed awaited network/RPC
work or host-observed delivery, so Cloudflare's frozen isolate clock cannot
manufacture a latency improvement.

Five fresh processes per revision ran each of the complete suite, enlarged
storage/reactivation controls, append-tail controls, live-delivery controls,
and enlarged cross-post controls. Process order alternated within each family.
All 50 processes, exact-revision checks, and semantic assertions passed. The
unmodified full-suite geometric result was 24.999% lower p50, 12.425% lower
p95, and 23.194% lower mean latency.

The conservative headline uses the same substitution rule declared for
checkpoints eight through twelve. It replaces singleton append, 100-event
append, concurrent-32 append, one-subscriber live delivery, and 25-subscriber
live delivery with their larger focused controls, then takes an
equal-workload geometric mean:

| Equal-workload statistic | Improvement versus current main |
| ------------------------ | ------------------------------: |
| p50                      |                     **30.291%** |
| p95                      |                     **21.993%** |
| mean                     |                     **28.639%** |

This is a branch-versus-main result for equally weighted benchmark workloads,
not a sum of earlier percentages and not a production-traffic weighting. It
repeats a large cumulative central win, but the change from checkpoint twelve
also demonstrates that one local checkpoint is not a stable estimate of the
exact production aggregate.

Focused median-of-five-run results were:

| Focused workload                     | P50 change | P95 change | Mean change |
| ------------------------------------ | ---------: | ---------: | ----------: |
| Append one 1 KiB event               |     72.51% |     70.11% |      66.96% |
| Append 100 tiny events               |     41.23% |     31.83% |      42.42% |
| Append 100 1 KiB events              |     53.88% |     36.96% |      51.09% |
| Append 1,000 tiny events             |     59.73% |     41.51% |      56.23% |
| Append 100 keyed tiny events         |     38.13% |     28.57% |      39.93% |
| Append 32 concurrent singleton calls |     35.76% |     24.06% |      37.55% |
| Deliver to one live subscriber       |     63.38% |     59.39% |      60.32% |
| Deliver to 25 live subscribers       |     15.48% |     11.50% |      14.40% |
| Dense post-reactivation replay       |     21.94% |     16.39% |      20.20% |
| Sparse post-reactivation replay      |      9.95% |      2.38% |      14.30% |
| Dense one-event cross-post           |     15.05% |      6.85% |      11.51% |
| Sparse cross-post, 1 of 100 events   |     20.63% |     19.57% |      23.70% |
| Append one inline 768 KiB event      |     49.10% |     35.50% |      41.70% |
| Append one chunked 1.1 MiB event     |     14.35% |     -7.55% |       2.81% |

The focused forced-reactivation head control again disagreed with its own full
suite row: the focused p50 improved 2.07%, while p95 and mean regressed 60.41%
and 11.29%; the full row was neutral at -0.21%/+1.06%/+0.83%. No current-head
reactivation regression is inferred from that unstable tail, especially after
the clean 1,500-observation control above, but it remains an explicit soak
risk. The full suite's 500-event replay row was 1.05% slower at p50, 33.18%
slower at p95, and 5.63% slower at mean across only 50 observations per
revision. It needs a larger isolated control before the tail is accepted or
attributed. The chunked append p95 also moved 7.55% in the wrong direction,
while its p50 improved 14.35% and its mean remained within the 5% gate.

Raw records are
`/tmp/cumulative-13-{full,storage,tail,live,crosspost}-{main,candidate}-r{1..5}.log`.
Collection ended at `2026-07-15T05:37:32.334Z`; if active optimization
continues, the next exact-current-main checkpoint is due by
`2026-07-15T09:37:32.334Z`. Both benchmark servers were stopped. Production
was not deployed or erased.

## 2026-07-15: Current-Head Legacy KV Rewrite Rejected

A fresh isolated experiment reimplemented the narrow Stream API on a true
legacy Durable Object KV namespace at exact shipping head `5a4a0c350`. This is
not `ctx.storage.kv` on a SQLite-backed class, which still uses SQLite under
workerd; the experiment declared a separate legacy class and compared its
automatic dirty-set flush and explicit `storage.sync()` variants with
synchronous SQLite.

Three trials ran the correctness suite first, then contributed 225 Node-host
samples per ordinary workload and 111 for the 768 KiB workload. Timings include
HTTP, Worker-to-Durable-Object RPC, the storage output gate, and the response
body. Every automatic legacy-KV p50 was slower:

| Workload                          | SQLite p50 | Legacy KV p50 | Regression |
| --------------------------------- | ---------: | ------------: | ---------: |
| Append one 1 KiB event            |   0.941 ms |      0.983 ms |       4.4% |
| Append 100 tiny events            |   1.247 ms |      1.259 ms |       0.9% |
| Append 1,000 tiny events          |   3.408 ms |      3.605 ms |       5.8% |
| Append 100 x 1 KiB events         |   1.572 ms |      1.699 ms |       8.0% |
| Append one 768 KiB event          |   4.083 ms |      4.582 ms |      12.2% |
| Repeat 100 keyed acknowledgements |   1.017 ms |      1.125 ms |      10.7% |
| Read 500 of 5,000                 |   1.960 ms |      2.189 ms |      11.7% |
| Select 10 of 1,000 by type        |   0.898 ms |      1.221 ms |      35.9% |
| 32 concurrent singleton appends   |  11.565 ms |     11.990 ms |       3.7% |
| Subscribe and deliver one event   |   1.004 ms |      1.048 ms |       4.3% |
| Positive `waitForEvent` delivery  |   1.049 ms |      1.071 ms |       2.1% |

P50-derived throughput fell from 293k to 277k events/s for 1,000 tiny events,
63.6k to 58.9k events/s for 100 x 1 KiB, 183.7 to 163.7 MiB/s for the 768 KiB
event, and 2.77k to 2.67k calls/s at concurrency 32. Explicit `storage.sync()`
was slower than SQLite in every p50 lane as well. Source inspection explains
why it cannot provide manual flush control: ActorCache already schedules the
dirty-set transaction, and `sync()` waits for that flush rather than initiating
or shaping it. `allowUnconfirmed` can let an acknowledgement escape durability
and is invalid for Stream append acknowledgements.

The narrow prototype is already 668 implementation lines and still omits
crash injection, durable subscription cursors, ephemeral eviction floors,
alarm recovery, descending reads, selector cursor advancement, corruption
checks, and frozen-clock-safe timeout rearming. Legacy KV also limits values to
128 KiB and writes to 128 keys per transport batch, has no indexed selector or
range queries, and makes the application own segmentation, chunks, cleanup,
and crash recovery. Erasing production removes migration work; it does not
remove any of those runtime obligations.

The experiment and raw evidence remain isolated on
`experiment/stream-kv-yolo` at commits `153ae59fe` and `cc827aa70`. Its 85
focused tests, three prototype correctness runs, OS typecheck, and Wrangler
dry-run pass. It was not deployed. The experiment collapses by deleting one
branch and directory; shipping it would materially increase complexity while
reducing throughput. Synchronous SQLite remains the accepted journal.

## 2026-07-15: Replay Central Latency Cleared, P99 Risk Retained

Checkpoint thirteen's 500-event replay row had only 50 observations per
revision and reported a 33.18% candidate p95 regression. A larger isolated
control appended 500 128-byte events, opened a replaying subscription, and
host-timed every delivered batch until all 500 offsets were observed. Three
fresh processes per immutable revision contributed 300 observations each.
Exact main was `7b106d623ca1d814304443c0ad34f8e36ac0b0bb`; candidate production code was
exact shipping revision `147758b867b454292c550038e5f9c73fd103227c`.

| Replay statistic | Fresh main | Candidate | Candidate change |
| ---------------- | ---------: | --------: | ---------------: |
| p50              |   6.966 ms |  6.418 ms |     7.87% faster |
| p90              |  10.077 ms |  9.118 ms |     9.52% faster |
| p95              |  11.173 ms | 11.446 ms |     2.44% slower |
| p99              |  16.917 ms | 43.251 ms |   155.67% slower |
| mean             |   7.923 ms |  7.489 ms |     5.49% faster |
| maximum          |  21.811 ms | 61.411 ms |   181.56% slower |

The earlier p50/p95 warning is cleared: candidate central latency is faster
and p95 is within the 5% gate. The candidate nevertheless produced a 43-61 ms
pause in every process while main's maximum was 21.8 ms. That repeated p99
shape is consistent with an allocator or garbage-collection pause, although
the benchmark does not identify its cause. It remains a soak and heap-profile
risk rather than being averaged away as noise.

One main attempt was excluded after a long-lived local benchmark server failed
to deliver its first event within 60 seconds; restarting the exact same main
revision produced a valid replacement. Every included process passed exact
revision, offset, count, and ordering assertions. Raw records are
`/tmp/replay-tail-{main,candidate}-r{1..3}.log`. Both local servers were
stopped; no deployment or data changed.

## 2026-07-15: Hybrid Per-Event Receiver Accepted

Three independent redesign agents converged on the same narrow receiver: keep
bounded `processEventBatch` transport private, expose only
`processEvent(event)`, return `void` for an entirely synchronous batch, and
create one ordered continuation only after the first Promise. They rejected
credits, timers, queues, schemas, protocol changes, and a separate append-ack
operation. This preserves the external vocabulary of `append`, `subscribe`,
`read`, and `waitForEvent` while retaining the existing internal batching and
durable retry protocol.

The implementation at `d2514eeb1a7b7029ca1dbf2f34bdc27a79b91e08` added
the hybrid drain to `subscribe`, `IterateWorkerEntrypoint`, and
`IterateDurableObject`; made the class batch receiver TypeScript-private; and
kept `processEvent` as the only subclass callback. Fourteen focused embedded
SDK tests cover empty and synchronous batches, ordered asynchronous suffixes,
synchronous throws, asynchronous rejection, and both Worker and Durable
Object base classes. The package build and declarations, broad Stream tests,
OS typecheck, lint, full CI, and preview e2e passed.

A deployed same-build failure probe then made the first event throw
synchronously once. Preview 5 redelivered exact source offsets 4, 5, and 6 in
order, forwarded each exactly once, and checkpointed offset 6. The observed
failure count remained one in every output. This proves that the synchronous
throw escapes the receiver before any acknowledgement and still drives the
real Worker-to-Stream-Durable-Object retry path.

The first deployed performance implementation used one cached receiver arrow
for all class events. Eight fresh durable projects later contributed 240
singleton and 200 paired 1,000 x 640-byte samples against an explicit
always-async batch loop. Singleton p50 improved 2.54%, but PCM p50 regressed
6.74% even though its paired median improved 0.91%. The extra class receiver
arrow was the only per-event call absent from the baseline. Exact head
`8e3c9e8473e43c6eb01f8647a81ecec1f8189e89` therefore specializes the Worker
and Durable Object synchronous loops to call the subclass directly; only a
genuinely asynchronous suffix uses the shared continuation. The resulting
production SDK change remains 33 net lines over `147758b86`; no transport,
storage, cursor, or schema state was added.

The ephemeral contract matters here. `StreamRpcTarget.subscribe` terminates
the callback leg with `void forward(batch)`, so the subscriber's result is
genuinely unobserved by the Stream DO. Four balanced fresh deployed projects
therefore made every per-event handler synchronous, moved only the benchmark's
completion signal into `ctx.waitUntil`, and compared the hybrid helper with an
explicit always-async batch loop on the same Stream DO and Worker:

| Ephemeral statistic | Singleton change | 1,000 x 640-byte change |
| ------------------- | ---------------: | ----------------------: |
| p50                 |     1.41% faster |            0.45% slower |
| p95                 |     2.63% slower |           34.83% faster |
| p99                 |    24.74% slower |            8.55% faster |
| mean                |     2.19% faster |            6.72% faster |
| paired median       |     0.88% faster |            0.98% slower |
| paired wins         |          258/480 |                 156/320 |

This proves central parity even for the voice-PCM case. Per-project tail
direction changed with platform stalls, so no tail improvement is attributed
to the adapter. A separate ephemeral lane whose final handler returned its
completion Promise was also central-neutral (0.15% slower singleton p50,
0.87% slower PCM p50), but PCM p95 and mean were 17.51% and 7.12% slower. The
relay discards either adapter's result, so async callback work is not a durable
acknowledgement boundary; applications needing retry must use durable push.

Durable project-worker push is different: `Itx.processEventBatch` awaits the
Worker result so a rejection reaches the Stream spine's retry machinery. The
shipping hybrid therefore propagates the first returned Promise and processes
the remaining local suffix in order. It does not discard durable work. Exact
head `8e3c9e8473e43c6eb01f8647a81ecec1f8189e89`, deployed as OS Worker version
`e0802646-5798-4cc1-a324-878299c79fb0`, ran thirteen fresh projects with
balanced installation order. Each sample host-timed append -> Stream DO ->
project Worker -> completion Stream DO -> validated Node waiter. All 780
paired samples (1,560 timed arms) and their event ordering/count assertions
passed.

| Durable statistic | Explicit batch singleton | Hybrid singleton | Explicit batch PCM |   Hybrid PCM |
| ----------------- | -----------------------: | ---------------: | -----------------: | -----------: |
| p50               |                68.715 ms |        69.313 ms |         147.150 ms |   144.607 ms |
| p90               |               117.869 ms |       117.329 ms |         227.936 ms |   220.514 ms |
| p95               |               134.089 ms |       130.601 ms |         330.523 ms |   299.486 ms |
| p99               |               260.192 ms |       223.160 ms |       1,968.028 ms | 1,531.404 ms |
| mean              |                79.794 ms |        87.566 ms |         207.846 ms |   178.449 ms |

PCM improved 1.73% at p50, 3.26% at p90, 9.39% at p95, and 14.14% at mean;
its paired median improved 0.58% and the hybrid won 206 of 390 pairs. Singleton
p50 was 0.87% slower, p95 2.60% faster, and paired median 0.19% slower: central
parity. Its 9.74% worse mean came entirely from one 3.115-second candidate
outlier; candidate p99 was still 14.23% faster. Tail improvements are not
claimed as intrinsic wins, but the enlarged distribution rejects a systematic
latency or throughput regression.

Two deliberately enlarged projects stopped at the same batch-34 boundary,
once on each implementation, and are excluded. They identify a shared-preview
or harness saturation ceiling rather than a receiver difference. Raw records
are `/tmp/hybrid-deployed-sync-discard-r{1..4}.log`,
`/tmp/hybrid-deployed-ephemeral-r{1..4}.log`,
`/tmp/hybrid-deployed-durable-awaited-r{1..8}.log`, and
`/tmp/hybrid-deployed-specialized-durable-r{1..13}.log`.

The accepted shape is an elegant collapse rather than a second delivery
system: one public per-event callback, one private bounded transport batch,
one optional ordered Promise continuation, and no added durable state. The
microbench gains under fully synchronous saturation remain upside; deployed
tests establish that obtaining them does not tax the actual PCM path.
Production remains untouched.

## 2026-07-15: Fourteenth Cumulative Main Comparison

The candidate was exact draft-PR head
`cee0ddfc81de5e289f3ff9d5e2a786eb286544ec`; its production code differs from
the accepted receiver revision `8e3c9e8473e43c6eb01f8647a81ecec1f8189e89`
only by the preceding ledger entry. Freshly fetched `origin/main` remained
`7b106d623ca1d814304443c0ad34f8e36ac0b0bb` before and immediately after the
collection and was already an ancestor of the candidate. No merge commit was
required.

Five fresh Node/Vitest processes per revision ran each of the unmodified full
suite, enlarged append/reactivation tails, enlarged live delivery, enlarged
cross-post, and enlarged storage/reactivation lanes. The 50 processes ran
between `2026-07-15T08:47:50Z` and `2026-07-15T09:00:08Z`; every process
reported the exact expected revision, non-empty finite samples, and a passing
semantic result. Revision lead alternated by lane. All timers remained on the
Node host around awaited network/RPC work or host-observed delivery.

| Equal-workload aggregate  | p50 improvement | p95 improvement | Mean improvement |
| ------------------------- | --------------: | --------------: | ---------------: |
| Unmodified full suite     |         33.332% |         24.916% |          30.247% |
| Conservative substitution |         28.684% |         21.720% |          25.299% |

The conservative row replaces the noisier full-suite append singleton,
100-event append, concurrent-32 append, one-subscriber delivery, and
25-subscriber delivery values with their enlarged controls. It is an
equal-workload geometric summary, not production-traffic weighting and not a
sum of isolated improvements.

Median-of-five focused p50 results remain directionally consistent with the
thirteenth checkpoint: acknowledgement-only 1 KiB append improved 66.59%,
concurrent-32 append improved 38.91%, one-subscriber live delivery improved
54.68%, 25-subscriber delivery improved 11.66%, dense reactivation read
improved 34.39%, sparse reactivation read improved 35.87%, and inline 768 KiB
append improved 49.69%. A 100-event tiny append in the equal-count storage lane
regressed 23.07% p50, while 100 x 1 KiB and 1,000 tiny events improved 27.60%
and 31.38%. The 1.1 MiB chunked append was neutral at 4.19% slower p50 and 4.38%
faster p95.

The enlarged controls retain explicit tails. Concurrent-32 append improved
38.91% p50 and 15.72% p95. Forced-reactivation head improved 7.61% p50 but was
33.45% slower p95, repeating its known unstable tail. One-subscriber delivery
improved 54.68% p50 and 37.30% p95; 25-subscriber delivery improved 11.66% p50
and was neutral at 1.26% p95. Dense enlarged cross-post was 8.58% slower p50
but 9.82% faster p95; sparse cross-post improved 22.91% p50 and 18.63% p95.

The ten-observation full-suite replay row improved 17.41% p50 but was 82.18%
slower p95. The enlarged-cross-post processes' incidental replay row was 2.47%
slower p50 and 27.20% slower p95. Those low-sample tails do not supersede the
separate 300-observation replay control: central latency there passed while
four isolated candidate samples exceeded 30 ms and none did on main. Replay
p99 therefore remains the next attribution experiment rather than being
hidden in the aggregate.

Raw records are `/tmp/cumulative-14-{full,tail,live,crosspost,storage}-`
`{main,candidate}-r{1..5}.log`; the aggregate output is
`/tmp/cumulative-14-analysis.txt`. Both benchmark servers were stopped and all
draft-PR checks passed, including preview deploy/e2e. Production remained
untouched. If active optimization continues, the next cumulative comparison
is due by `2026-07-15T13:00:08Z`.

## 2026-07-15: Replay Tail Speed Confirmed, Idle Retention Is the Next Gate

The enlarged replay investigation first tested two narrower allocation
hypotheses against exact candidate Stream code `147758b867b454292c550038e5f9c73fd103227c`.
That Stream-domain code is unchanged at the current draft-PR head. Five fresh
workerd/Node processes per arm contributed 2,500 observations to each control,
with every timer on the Node host around awaited RPC/network work and validated
delivery.

Restoring append's full `{ return: "events" }` result did not remove the tail.
Acknowledgement-only replay had p50/p95/p99 of 6.904/12.272/30.856 ms; the
allocating result had 6.347/13.203/37.456 ms. Both arms produced 40-67 ms
process-local pauses. The cheaper append result therefore did not merely shift
client allocation into the later subscription.

Omitting the event-type selector also did not remove the tail. Its pooled
p50/p95/p99 were 6.963/12.556/25.082 ms, with a 51.841 ms p99.5 and 85.015 ms
maximum. It improved three process-local p99 values and worsened two; every
process still produced a 40-85 ms pause. Selector projection work may
contribute, but it is not the root cause and does not justify deleting the
throughput cache.

An external Chrome DevTools Protocol profile then measured 1,000 complete
500-event replay subscriptions in a fresh local workerd process. The exact
current-main control was `f02de82f1ce8557d9d47ae2dffde06e70ce3aaf9`.
Both revisions began from the same 1.47 MB lazy-isolate heap, and an explicit
post-run collection separated retained state from merely uncollected garbage.

| 1,000-Stream replay stress | Current main |  Candidate | Candidate change |
| -------------------------- | -----------: | ---------: | ---------------: |
| Node-host p50              |    10.031 ms |   7.641 ms |   23.829% faster |
| Node-host p95              |    20.602 ms |  13.031 ms |   36.751% faster |
| Node-host p99              |    31.405 ms |  28.149 ms |   10.370% faster |
| Node-host mean             |    11.327 ms |   8.677 ms |   23.400% faster |
| Node-host maximum          |    55.843 ms | 107.818 ms |   93.080% slower |
| Post-GC used heap          |     202.4 MB |   321.1 MB |   58.643% higher |
| Profiled work duration     |      52.30 s |    32.48 s |  37.900% shorter |
| Profiled GC total          |       1.66 s |     2.12 s |   28.084% higher |
| Longest sampled GC run     |     49.64 ms |  594.01 ms |             risk |

The larger distribution clears the candidate-specific central replay-tail
warning: candidate is faster through p99, and its nine samples at or above
30 ms compare with main's thirteen. It does not clear the single-maximum or
memory risk. After collection the candidate retained 118,693,792 more bytes
(113.2 MiB) than main. CPU profiling spans append setup as well as each timed
subscription, so its sampled GC runs identify pressure but cannot be assigned
one-for-one to Node latency samples.

Source shape explains the retained delta. `StreamDeliveryFrameReader` keeps
the latest parsed `#freshTail` after every append even when the Stream has no
live connection, push drain, or poke in flight. This stress creates 1,000
separate Streams and appends 500 events to each, so the candidate can retain
roughly 500,000 parsed event objects merely to accelerate a possible future
replay. Current main instead pays SQLite read/parse cost, which explains both
its lower retained heap and its slower replay.

The split decision is therefore explicit. The fresh-tail path earns its replay
latency and throughput, while unconditional idle retention does not yet earn
its 58.6% post-GC heap cost or rare maximum. The next gate is a demand-bound
release experiment: preserve the tail while a live/configured delivery can
consume it, release it when delivery becomes idle, and measure both replay and
live PCM before integrating. No storage, selector, protocol, or production
change follows from the attribution alone.

Raw allocation records are
`/private/tmp/replay-attribution-{ack,events}-r{1..5}.log` and
`/private/tmp/replay-selector-omit-r{1..5}.log`. Profile records are
`/private/tmp/replay-workerd-profile-{candidate-postgc,main-f02-postgc}-benchmark.log`
and their adjacent `.cpuprofile` files. The temporary inspector configuration
was not added to the shipping branch. Both benchmark servers were stopped;
production remained untouched.
