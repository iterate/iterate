# Append cost — local comparison, 5 September 2026

**The small core is still substantially slower than the existing clean room.**
Removing a redundant SQL update improved median batch throughput by 18% over
JSON and 13% over Capnweb in three local rounds. Singleton throughput did not
improve. This is useful evidence for one storage change, not achievement of
the throughput/CPU goal or evidence from a deployed environment.

## Workload and comparison limits

Apple M4 Max, arm64, Node 26.5.0; both runtimes use Wrangler 4.127.1 and
Capnweb 0.12.2 with debug logging. Runs were sequential, not competing benchmarks.
Each case uses a fresh project and one caller: 500 requests of one event, or
100 requests of 100 events. Each event contains a 1,024-character ASCII string.
No signatures, processors, subscribers, or external fetches are exercised.
Batch append is atomic on both implementations, not 100 individual RPCs.

The small core warms `inspect`, then times payload construction, requests, and
decoded receipts. Per-request latency starts after payload construction. Its
JSON transport calls `/api`; its Capnweb transport opens an HTTP batch session
at `/rpc` for each request. Both invoke the same context append implementation:

```js
using rpc = newHttpBatchRpcSession(
  new Request(`${base}/rpc?project=${project}`, { signal: AbortSignal.timeout(10_000) }),
);
const records = await rpc.append(events);
assert.equal(records.length, events.length);
```

The existing core uses its public Capnweb `/api` endpoint and pipelines
`session.authenticate().projects.get(project).invoke(["itx", ["append", ...events]])`.
It warms `whoami`, prebuilds payloads outside the total timer, and includes
receipt validation inside the request timer. Its payload also contains an
integer sequence. It uses percentile index `ceil(N * p) - 1`; the small core
uses `floor(N * p)`. These are not identical protocols, envelopes, validation,
or timing boundaries. The large gap warrants investigation; small differences
must not be treated as isolated storage or transport cost.

After each case the small core reads every event in pages of 100, checking
consecutive offsets and full payloads: 63,000 events before and 63,000 after.
The existing core reads pages of 1,000 and checks total/type counts, allowing
its two startup facts: all 31,500 user events passed. It did not measure read
latency. No private storage access is involved in either benchmark.

## Results

Values in each cell are rounds 1 / 2 / 3. Latencies are per request, not per event.

| Implementation / transport  | Batch | Events/sec               | p50 ms                | p95 ms                | p99 ms                |
| --------------------------- | ----: | ------------------------ | --------------------- | --------------------- | --------------------- |
| Existing core / Capnweb     |     1 | 347 / 367 / 372          | 2.83 / 2.68 / 2.63    | 3.45 / 3.30 / 3.18    | 4.05 / 4.25 / 4.37    |
| Small core before / JSON    |     1 | 293 / 298 / 294          | 3.35 / 3.17 / 3.19    | 4.14 / 4.88 / 5.87    | 4.90 / 7.00 / 7.60    |
| Small core after / JSON     |     1 | 291 / 290 / 293          | 3.30 / 3.20 / 3.16    | 4.45 / 5.13 / 6.28    | 7.15 / 7.82 / 7.55    |
| Small core before / Capnweb |     1 | 288 / 289 / 290          | 3.30 / 3.27 / 3.23    | 4.68 / 5.19 / 6.13    | 6.78 / 6.94 / 7.60    |
| Small core after / Capnweb  |     1 | 281 / 285 / 285          | 3.35 / 3.29 / 3.28    | 5.10 / 5.28 / 6.49    | 7.52 / 7.28 / 7.74    |
| Existing core / Capnweb     |   100 | 17,544 / 17,760 / 17,232 | 5.27 / 5.26 / 5.31    | 8.27 / 7.93 / 7.99    | 10.22 / 8.58 / 9.30   |
| Small core before / JSON    |   100 | 5,603 / 5,740 / 5,607    | 17.16 / 17.07 / 17.06 | 21.68 / 22.46 / 23.78 | 60.68 / 25.20 / 26.86 |
| Small core after / JSON     |   100 | 6,484 / 6,618 / 6,630    | 14.95 / 14.39 / 14.48 | 20.48 / 19.59 / 18.96 | 21.75 / 22.68 / 19.94 |
| Small core before / Capnweb |   100 | 5,623 / 5,560 / 5,558    | 17.39 / 17.55 / 17.62 | 21.68 / 24.04 / 21.15 | 27.89 / 33.67 / 26.48 |
| Small core after / Capnweb  |   100 | 6,305 / 6,354 / 6,206    | 15.37 / 15.24 / 15.60 | 20.79 / 20.38 / 20.92 | 25.02 / 23.49 / 24.63 |

Median batch rates rose from 5,607 to 6,618 (JSON) and 5,560 to 6,305
(Capnweb). The reference remains about 2.8 times the latter. There are only
three rounds on a shared machine; this is not a statistical capacity estimate.
Batch-case read rates before were 27,032–27,502 events/sec over JSON and
23,682–25,164 over Capnweb; after, 26,038–26,434 and 23,747–24,437 respectively.
Reconstructing stored envelopes therefore has a read cost worth monitoring.

## CPU sampling and the retained change

Before changing storage, a separate 50,000-event workload (500 × 100 JSON
appends) ran under the workerd Inspector CPU profiler. It took 8,806 ms;
the profile duration was 8,844,848 µs with 1,068 samples. The project head
was checked at 50,000; this profiling-only run did not replay every event.

| Aggregated leaf frame | Samples |  Share |
| --------------------- | ------: | -----: |
| Native SQL `exec`     |     507 | 47.47% |
| `(program)`           |      72 |  6.74% |
| Garbage collector     |      51 |  4.78% |
| Commit callback       |      50 |  4.68% |
| Native cursor `one`   |      44 |  4.12% |
| Edge `fetch`          |      43 |  4.03% |
| Canonical JSON        |      42 |  3.93% |
| `#commit`             |      36 |  3.37% |

These are sampled leaf-frame shares, not billable CPU/request, whole-process
CPU, or exact attribution to individual SQL statements. No after-change CPU
profile was taken. Similar JSON/Capnweb batch rates and the SQL-heavy profile
suggested reducing synchronous SQL work before changing the public API.

An ordinary new event previously made five SQL calls: duplicate lookup, trust
lookup, trust-offset lookup, INSERT, then UPDATE solely to put the assigned
offset inside the JSON envelope. It now makes four. SQLite's row key supplies
the offset when returning, retrying, or replaying an event:

```ts
const { offset } = sql
  .exec<{
    offset: number;
  }>(
    "INSERT INTO events(id,input,record) VALUES (?,?,?) RETURNING offset",
    input.id,
    serialized,
    JSON.stringify(record),
  )
  .one();
const stored = { ...record, offset };
apply?.(stored); // same transaction; application receives the assigned offset
```

The table schema and atomic transaction boundary are unchanged. Settings
writes still apply after their event and before the next event in the batch.
No in-memory offset allocator or batch-wide trust cache was introduced.
Older JSON rows that already contain `offset` work too: reads overwrite that
field with the authoritative SQL row key. The response byte budget measures
the reconstructed envelope, not its shorter stored representation.

The existing idempotency E2E now compares complete append/retry/replay
envelopes. A row written before this change and two rows written afterwards
also passed public replay and duplicate-append checks after a real local
stop/start using the same persistence directory. This is not an abrupt-crash
or deployed eviction test.

After the change: **32/32 E2Es, no skips**, 10.43 seconds; typecheck and scoped
lint pass; **4,972 raw authored lines**. Fresh suite log has 18 deliberately
thrown negative-fixture exceptions, 15 classified processor-failure records,
two expected WebSocket peer closures, and zero hung cancellations, extra async
exceptions, or `NOSENTRY` alarm mismatches. The previous retry stress checkpoint
is separate; it was not repeated for this storage-only change.

## Retained local files and reproduction

Use the synthetic-fixture setup in [local verification](local-verification.md).
For three rounds, run JSON singleton, JSON batch, Capnweb singleton, Capnweb
batch in that order, warming a fresh project for each. Time each request
through decoded receipts, verify the receipt count, then replay and validate
every event outside the append timer. Throughput is event count / total
elapsed seconds. These are measurement sketches, not hidden runtime features
or excluded functional tests.

- Small-core persistence: `/tmp/project-core-matched-bench-5lLAjf`.
  Before marker `a37312ae-1a35-4a58-92da-882464770da1`; after marker
  `4289c576-a8d6-44b7-962b-c5d5db7880d1`. Project names are
  `matched-<marker>-<round>-<json|capnweb>-<1|100>`.
- Profile project: `profile-4c5402f3-5542-445e-870c-4ba8b2496664`.
  Inspector sequence: `Runtime.enable`, warm API, `Profiler.enable`, sampling
  interval 1,000 µs, start, workload, stop. A first client probe that omitted
  `Runtime.enable` timed out before running a workload. The successful setup
  follows the local workerd inspector driver at commit
  `c4e03fa1d2a3f2607e2b79567076d5fdd5179d03`.
- Existing-core driver and persistence:
  `/tmp/project-worker-bench-e5WACZ/public-http-batch-bench.mjs`.
  Its `wrangler.test.jsonc` uses a local `DummyControlPlane`, never a product
  control plane. Debug log is alongside the driver.
- Existing-core HEAD: `b74521b32a6d962b6a39e2b0fd3614bd376ea6fe`;
  tracked binary diff SHA-256:
  `cf5e5077b9b2d08a612077aa915d1177357c51c24075169506f0937e110a51cf`.
  This was the user's dirty worktree, not a pristine release comparison.
- Small-core benchmark log: `wrangler-2026-09-04_23-35-45_714.log`;
  fresh suite/restart log: `wrangler-2026-09-04_23-45-55_566.log`, both in
  `/Users/jonastemplestein/Library/Preferences/.wrangler/logs`.

Next storage question: can trust value and its policy offset be read in one
query? Test key rotation and policy changes _within a batch_ before touching
that boundary. Caching one policy for the whole batch would be incorrect.
Deployed CPU/latency, longer saturation runs, signed events, live fanout,
processor workloads, and independent-runtime evidence remain outstanding.
