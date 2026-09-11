# Canonical validation: remove redundancy, withhold a speedup claim

5 September 2026. **The core keeps a two-line simplification, not a claimed
5–8% performance gain.** The full reverse control weakens the initial timing
result. Whole-envelope validation, signed bytes, rollback and duplicate
semantics remain intact. The final public-network suite passes **34/34**, and
the raw authored-code counter remains **4,999**.

## The change and its safety boundary

```ts
// Before: both the caller and canonical() deeply validate and clone the JSON.
const serialized = canonical(Json.parse(input));

// Now: canonical owns that validation, exactly once per invocation.
export function canonical(value: unknown): string {
  return canonicalJson(Json.parse(value));
}
const serialized = canonical(input);
```

This removes one redundant traversal at the commit call site; it does not
remove the separate event-schema validation, crypto verification, or sorted-key
serialization. Validation still runs synchronously inside the existing SQLite
transaction, before each duplicate lookup or insertion. No cache, new state,
await, cast, or validation bypass is introduced.

`EventInput.parse()` alone is insufficient here. Additional public-JWK metadata
passes through its schema, and native Workers RPC can carry non-JSON values:

```js
// Constructed inside a loaded WorkerEntrypoint using an otherwise valid event:
second.provenance.signatures[0].key.padding = new Date("2020-01-01T00:00:00Z");
await context.append([first, second]); // rejects; neither event commits
```

The public probe installs that worker, invokes it over HTTP, and checks that
the log still contains only its setup event. A subsequent valid JSON batch
using the same IDs succeeds at offsets 2 and 3, with verification levels 0
and 1. Reordering nested properties, including extra JWK metadata, returns the
identical receipt; changing that metadata returns `409 ID_CONFLICT`. All
committed envelopes replay exactly. Extra JWK metadata is retained input,
**not signer-attested provenance**; see [the byte-boundary probe](read-page-cost.md).

These checks pass on initial A, candidate B, and final reapplied B. They are
behavior characterization, not evidence of a newly fixed functional defect.
The reverse-A timing phase does not repeat these guards. The same three phases
also pass the emoji, escaped lone-surrogate and oversized signed-envelope
HTTP/WebSocket page probes: page counts 3/2, 4/1 and 1/1/1, with complete
receipt/replay/live equality. This adds 48 committed/replayed boundary events,
including 39 live envelopes, separately from the performance and suite totals.

## Initial A → candidate B → restored A

Same local Apple M4 Max, Node 26.5.0, Wrangler 4.127.1 and workerd
1.20260828.1 as [the preceding CPU work](fairness-cpu.md), with debug logging.
Each phase has three fresh-project cases per shape, flat first in rounds 1/3
and nested first in round 2. Every case sends 320 HTTP requests × 100 unsigned
events through 16 writer loops. There are **no live readers** in this timing
workload. Payloads are prepared and projects initialized before timing.

```js
const flat = { text: "x".repeat(1024) }; // 1,035 JSON UTF-8 bytes
const nested = {
  // 1,617 JSON UTF-8 bytes
  document: { path: "docs/roadmap.md", version: 12 },
  changes: Array.from({ length: 12 }, (_, i) => ({
    range: { from: i * 10, to: i * 10 + 3 },
    insert: "x".repeat(40),
    attributes: { bold: i % 2 === 0, reviewer: null },
  })),
  labels: ["draft", "review"],
  complete: false,
};
```

| Phase       | Shape  | Main CPU ms, rounds 1 / 2 / 3 | Median CPU µs/event | Median write events/sec |
| ----------- | ------ | ----------------------------: | ------------------: | ----------------------: |
| Initial A   | Flat   |            3350 / 3060 / 3130 |                97.8 |                   9,656 |
| Candidate B | Flat   |            2960 / 3010 / 2910 |                92.5 |                  10,321 |
| Restored A  | Flat   |            3140 / 2840 / 2950 |                92.2 |                  10,101 |
| Initial A   | Nested |            7230 / 7130 / 7510 |               225.9 |                   4,318 |
| Candidate B | Nested |            6670 / 6770 / 6470 |               208.4 |                   4,680 |
| Restored A  | Nested |            7190 / 6750 / 6850 |               214.1 |                   4,544 |

Initial A→B median CPU falls 5.4% flat and 7.7% nested. But the restored flat
median is slightly below B, and restored nested reduces B's apparent advantage
to 2.6%, with overlapping per-case values. These phase-ordered shared-machine
runs do not establish a reliable flat speedup or a general 5–8% improvement.
Retain the change for removing known redundant work without expanding the
implementation; do not turn the initial pair into a performance promise.

CPU is cumulative `ps time` user+system delta for the exact checked main-workerd
PID, with 10 ms resolution—not isolate CPU or Cloudflare billing. Proxy and
Wrangler are recorded separately (150–210 ms and 30–90 ms per case); client
CPU is separate too. Timing ends after all decoded append receipts and their
client assertions. Replay is outside both append timing windows. Every receipt
checks ID, type, full input data, context, finite time, verification, and batch
offsets; all **576,000 events** then replay as identical complete envelopes,
with consecutive offsets, exact page cursors/head, and an empty final read.

Hot reload replaces main workerd between phases, resetting JIT/GC state;
persistence is retained but projects are fresh. There is no discarded warm-up
round or enabled CPU profiler. No typecheck, formatter, or full-suite run
overlaps these cases. Lightweight log inspection does; this is not a dedicated
benchmark machine or proof of exclusive process traffic. The benchmark has no
signed-event, live-reader, deployed-capacity or recovery performance claim.

## Retained public proof and captures

The existing fetch-gate test now forges the private bypass header from **both**
the external caller and loaded application code:

```js
// Executed by the dynamically loaded application:
await fetch("https://example.com/", {
  headers: { "x-core-below-fetch": "attempted-bypass" },
});
// Public replay must contain the egress gate's event, not just an ingress marker.
assert.ok(hosts.includes("example.com"));
```

It passes with the existing runtime gate; this closes a proof gap, not a newly
discovered bypass. The final combined suite passes 34 tests with zero failures,
skips or cancellations in 20,943.36 ms using the [synthetic fixture command](local-verification.md#public-network-suite)
and `LIVE_READER_MAX_BACKLOG=256`. Typecheck, lint and formatting pass. Final
boundary probes follow that suite. No production instrumentation is retained.

The log is `wrangler-2026-09-05_02-48-29_694.log` in the local Wrangler log
directory; persistence is `/tmp/project-core-canonical-cost-Dpw4HM`. Wrangler
66295 and proxy 66297 stay fixed. Main PIDs are 66298 / 69541 / 73037 for A/B/A,
then 73775 for final reapplied B and its suite. Every performance case checks
its exact PID, parent and command. Full compact rows, project IDs and inline
probe commands are in the agent session; this is a methodology/result record,
not a checked-in executable benchmark.

The complete log audit classifies 24 source exception reports: 12 deliberate
processor retries, three broken-worker failures, three mounted rejections,
and six reports from three intentional Date-padding native-RPC probes. The
last group includes source and membrane reports of the same rejected values;
Wrangler/Inspector display duplicate observations, not additional outcomes.
Two expected lending/disposal peer-disconnect records are separate from those
24 source reports. No extra hung-request, cancellation, alarm/scheduler or
unexpected stream-callback diagnostic is found. Deliberate
source reloads are separate from application failures. After verification,
manual SIGINT stops the owned runtime with exit 130; all checked process-tree
members and port 8799 are gone. There is no graceful-teardown log claim, and
temporary persistence is retained.

Final SHA-256 values:

```txt
src/signatures.ts 350ee416a04a5554d518c6d5ec35d0d84afd81e6ef59cab5a02acfe26236ef25
src/stream.ts     28e891bf6f6abad2c19d145813e871fa81328dae5172d7f9e5401e5ec4fabd4d
e2e/core.test.ts  bc26a4d7ba16acec969b1f17fcaa3d069fab277f37c9e5e58bf8c8c3e47fa9b4
```

Deployed acceptance remains pending the outer access-policy choice. The
path-first document/build APIs remain designs; this change does not implement
them or turn a context-relative `cd()` handle into subtree-confined authority.
