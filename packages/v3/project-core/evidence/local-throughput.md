# Local HTTP throughput baseline — 5 September 2026

**Measured, not a production capacity claim.** These are public-network calls
to local workerd on an Apple M4 Max, arm64, Node 26.5.0, Wrangler 4.127.1, with
debug logging enabled. Client and server share the machine; the tutorial server
remained idle on another port. No CPU profile or deployed comparison was taken.

This checkpoint predates the single-INSERT storage change. A later
[CPU sample and existing-core comparison](append-cost.md) uses a different
payload/batch workload and records its own matched before/after results;
do not compare their raw rates as though only storage changed.

This is an operational measurement, not an additional test in the 32-test suite.
The benchmark used a fresh project for each case and round. Every event carries
a 256-character ASCII `data.payload`, plus its ID/type and platform envelope.
No signatures, processors, subscribers, or external fetches are in this workload.
Each append response returns full event records and the client parses them.
An initial `inspect` opens each context before timing; payload creation, request
serialization, validation, storage, response transfer, and parsing contribute
to total wall-clock throughput. This is not isolated SQLite throughput.

## Results

Three rounds, sequentially. `p95` is **request** latency, not per-event latency.
In batch cases a request writes 128 events atomically. Parallel callers keep
eight requests in flight; the spread case uses eight independent root contexts
in eight projects, all hosted by the same local runtime.

| Case                                  | Requests/round | Events/round | Events/sec, rounds 1 / 2 / 3 | Request p95 ms, rounds 1 / 2 / 3 |
| ------------------------------------- | -------------: | -----------: | ---------------------------- | -------------------------------- |
| One event, one caller/context         |            500 |          500 | 290 / 295 / 288              | 4.14 / 4.82 / 4.29               |
| Batch 128, one caller/context         |            200 |       25,600 | 6,315 / 6,237 / 6,110        | 22.55 / 23.65 / 24.63            |
| Batch 128, eight callers, one context |            400 |       51,200 | 6,251 / 6,485 / 6,350        | 217.45 / 172.15 / 173.29         |
| Batch 128, eight callers/contexts     |            400 |       51,200 | 6,920 / 6,821 / 6,358        | 156.18 / 163.13 / 207.06         |

After each append phase, a separate untimed-for-append pass reads **every event**
through `readEvents({ afterOffset, limit: 128 })`. It asserts consecutive offsets,
payload length, and total count. All **385,500 appended events** were read back.
The larger read phases delivered 33,707–35,994 events/sec. The 500-event read
phases were only 14–15 ms long and are too short for useful capacity inference.

The first practical inference is modest: batching greatly improves this local
workload; adding callers to the same ordered context mostly increases queueing.
The eight-context case does not establish distributed scaling: all contexts,
the local proxy, logging, and client compete on the same machine. Do not change
the public path model or introduce one DO per file based on these numbers.

Example of the measured operation:

```ts
const events = Array.from({ length: 128 }, (_, n) => ({
  id: `batch-17/${n}`,
  type: "bench",
  data: { payload: "x".repeat(256) },
}));
await context.append(events); // one atomic append, not 128 network round trips
```

## Reproduction protocol

Start the fixture as described in [local verification](local-verification.md),
with a fresh persistence directory and `--log-level debug`. The measurement
uses the ordinary [public API helper](../e2e/support.ts), with the same JSON
request shape; it does not inspect storage or call private methods.

For each of three rounds, run the four cases above in table order:

1. Make a unique project per context and call `inspect` once outside the timer.
2. Start a wall-clock timer. Keep one/eight append requests in flight until the
   case's request count is exhausted. Use unique IDs `<request>/<event>`.
3. For each request, record time from just before the API call through response
   JSON parsing and assert status 200 and exactly 1/128 returned records.
4. Divide successful event count by elapsed seconds for aggregate throughput.
   Sort request durations; p95 uses index `floor(requestCount * 0.95)`.
5. Start a separate timer, read all contexts sequentially in 128-event pages,
   and assert offsets advance by exactly one, payload length is 256, and the
   total equals requests × batch size. Divide count by that duration for reads.

The essential measurement is deliberately ordinary JavaScript:

```js
const start = performance.now();
const response = await fetch(`${base}/api?project=${project}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ method: ["append"], args: [events] }),
  signal: AbortSignal.timeout(10_000),
});
const body = await response.json();
assert.equal(response.status, 200, JSON.stringify(body));
assert.equal(body.result.length, events.length);
latencies.push(performance.now() - start);
```

Fixture: `/tmp/project-core-restart-bench-oW0ukx`, port 8799, run marker
`b99c1609-1221-4348-a257-7c4bd3720244`. Project names are
`bench-<marker>-<round>-<single|batch128|contended|spread8>-<context-index>`.
Request log: `wrangler-2026-09-04_23-29-43_752.log` in the normal Wrangler log
directory. It also contains two deliberate failures from the preceding
[restart probe](local-restart.md); no additional hung-session cancellations,
`NOSENTRY` alarm mismatches, or uncaught async diagnostics appeared.

Still required: deployed CPU/request and latency distributions, comparison with
the existing core under matched semantics, longer steady-state/saturation runs,
signed-event cost, live fanout/slow-reader load, processor workloads, storage
growth, and a genuinely independent runtime. No claim of “extremely high
throughput” or CPU efficiency is justified by this baseline alone.
