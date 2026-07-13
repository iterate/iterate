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
- Storage schema v7 deliberately has no legacy migration. Existing stream data
  must be erased before rollout. A binary rollback after v7 state is created is
  also destructive; rollback requires erasing stream state again. Deployment
  is therefore operationally simple only because this effort explicitly
  accepts a production wipe.

The system still collapses operationally into one Stream DO, its SQLite, and
ordinary Workers RPC; it does not add a service, queue, coordinator, or new
distributed consistency boundary. It does **not** collapse elegantly at the
source level yet. A later consolidation should preserve the public semantic
projections (`append`, `appendOffsets`, `appendAck`), schema-v7 row shape,
frame/cursor correctness tests, and host benchmark, then unify the duplicated
bounded-range/frame planning inside storage and subscriber delivery. Do not
trade those measured contracts for legacy KV or a second persistence model.

### Shipping Interpretation

The branch is worth advancing as a destructive preview candidate because the
large wins cover batch ingest, large writes, duplicate retries, replay, latest
reads, and sparse durable delivery, with no reproduced regression in live
latency or cold activation. It is not ready for an unqualified production
merge solely on this local benchmark: schema-v7 wipe/rollback procedure and a
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
