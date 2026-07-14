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
source level yet. A later consolidation should preserve the public semantic
projections (`append`, `appendOffsets`, `appendAck`), schema-v8 row shape,
frame/cursor correctness tests, and host benchmark, then unify the duplicated
bounded-range/frame planning inside storage and subscriber delivery. Do not
trade those measured contracts for legacy KV or a second persistence model.

### Shipping Interpretation

The branch is worth advancing as a destructive preview candidate because the
large wins cover batch ingest, large writes, duplicate retries, replay, latest
reads, and sparse durable delivery, with no reproduced regression in live
latency or cold activation. It is not ready for an unqualified production
merge solely on this local benchmark: schema-v8 wipe/rollback procedure and a
preview workload run still need explicit sign-off, and the source-complexity
consolidation map should be retained even if consolidation happens after the
performance branch ships.

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
