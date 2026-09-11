# Transaction-local trust — 5 September 2026

**Median local batch throughput improved 18.1% over JSON and 17.3% over
Capnweb.** The change adds one authored line, bringing the core to **4,999**.
Singleton rates did not materially improve. This is shared-machine loopback
evidence, not deployed capacity or billable CPU evidence.

## Keep the policy current, not constant

The previous [combined trust read](trust-read-cost.md) still queried the same
policy for every event. The synchronous commit now reads its starting policy
once and advances that local value after each actual trust-setting write:

```ts
// Inside #commit, before its per-event loop:
let policy = sql
  .exec<{ value: string; offset: number }>("SELECT value, offset FROM settings WHERE key = 'trust'")
  .toArray()[0];

// Inside the loop, only after a new trust event's successful settings UPSERT:
if (setting.key === "trust") policy = { value: JSON.stringify(setting.value), offset };
```

The policy-setting event is checked against the previous policy; the next
fresh event is checked against the replacement. Each event still parses and
evaluates its policy and records the correct policy offset. Duplicates return
their historical receipts before changing anything. A failed batch discards
both its SQL writes and this call-local variable. There is no cross-request,
cross-transaction, or asynchronous cache.

An ordinary 100-event batch now performs one policy SELECT instead of 100,
without reordering events or adding a bulk-insert fast path. The tradeoff is
one unnecessary SELECT for an all-duplicate batch. Both the durable write and
the local update use the existing `JSON.stringify(setting.value)` serializer.

The seam requires **Stream to remain the sole writer of trust settings**.
Current repository callbacks write repo tables; approval callbacks write
`egress_pending`; detachment only deletes mount settings. Nested platform
appends can write only `itx.system.*`, never `itx.set`. A future callback with
direct trust-writing authority would violate this invariant and require a
different design.

All ten public provenance tests passed both before and after the change,
including within-batch Alice-to-Bob rotation, rollback, stale-key rejection,
plural signatures, and immutable historical receipts. This is a performance
refactor characterized by existing behavior tests, not a claim of a newly
fixed authorization bug. No tests were removed or weakened to meet the limit.

## Matched measurements

Apple M4 Max, arm64, Node 26.5.0, Wrangler 4.127.1, Capnweb 0.12.2, debug
logging. One fresh project per case; three rounds in this order: JSON
singleton, JSON batch, Capnweb singleton, Capnweb batch. Each case warms
`inspect`, then sends 500 × 1 or 100 × 100 unsigned events, each with a
1,024-character ASCII `data.text`. No processors, subscribers, or egress.

JSON calls `/api`; Capnweb creates an HTTP batch session at `/rpc` per request.
Total timing includes constructing payloads and checking receipt counts.
Request timing starts after payload construction and ends with decoded
receipts. Percentiles use `floor(requestCount * p)`. After every case, outside
append timing, public replay checks every event's ID, consecutive offset,
type, full payload, and level-0 verification envelope, plus page head/cursor.
**All 63,000 events before and all 63,000 after passed readback.**

Values are rounds 1 / 2 / 3; latencies are per request, not per event.

| Transport / change | Batch | Events/sec            | p50 ms                | p95 ms                | p99 ms                |
| ------------------ | ----: | --------------------- | --------------------- | --------------------- | --------------------- |
| JSON before        |     1 | 294 / 310 / 290       | 3.30 / 3.06 / 3.14    | 4.21 / 4.64 / 6.17    | 4.91 / 6.82 / 10.85   |
| JSON after         |     1 | 293 / 297 / 307       | 3.24 / 3.13 / 3.07    | 4.75 / 5.06 / 4.61    | 6.94 / 8.56 / 7.15    |
| Capnweb before     |     1 | 297 / 292 / 287       | 3.21 / 3.25 / 3.25    | 4.35 / 4.81 / 5.53    | 6.43 / 7.09 / 9.41    |
| Capnweb after      |     1 | 294 / 291 / 288       | 3.23 / 3.21 / 3.21    | 5.07 / 4.85 / 5.71    | 6.93 / 7.14 / 7.45    |
| JSON before        |   100 | 7,593 / 7,470 / 7,662 | 12.79 / 12.88 / 12.23 | 16.65 / 17.27 / 16.67 | 19.33 / 22.22 / 19.86 |
| JSON after         |   100 | 8,970 / 9,052 / 8,959 | 10.66 / 10.32 / 10.34 | 14.84 / 15.93 / 14.97 | 16.13 / 19.20 / 22.69 |
| Capnweb before     |   100 | 7,349 / 7,271 / 7,378 | 13.22 / 12.91 / 12.88 | 16.99 / 18.19 / 17.16 | 19.00 / 33.35 / 20.42 |
| Capnweb after      |   100 | 8,233 / 8,742 / 8,619 | 11.56 / 10.81 / 10.69 | 16.14 / 14.85 / 14.94 | 23.08 / 17.59 / 26.79 |

Median batch rates rose from 7,593 to 8,970 JSON and 7,349 to 8,619 Capnweb.
Three rounds do not establish tail-latency reliability. The earlier reference
core ran about 17,500 events/sec with a different protocol and envelope; it
was not rerun here and remains substantially faster. No new CPU profile was
taken; the previous SQL-heavy sample motivates this elapsed-time experiment,
but is not an after-change CPU measurement.

Reading 10,000 events took 368–381 ms JSON / 408–435 ms Capnweb before,
370–383 / 407–422 ms after. This is not a material read-speed improvement.

## Retained files

- Persistence: `/tmp/project-core-trust-transaction-WTbmUQ`.
- Before marker: `fee57a3a-5130-4f7d-92d2-1cbedf943fa1`.
- After marker: `c50b19e0-ed2c-489d-987a-6be72bc7c7e3`.
- Project names: `transaction-<marker>-<round>-<json|capnweb>-<1|100>`.
- Runtime log: `wrangler-2026-09-05_00-39-19_087.log` under the local Wrangler
  log directory. No uncaught exceptions, processor failures, extra async/hung
  cancellations, or alarm-manager mismatches appeared in this measurement run.

The isolated runtime was stopped normally after measurement. No deployed
worker or product state was touched. The [full-suite evidence](local-verification.md)
is a separate fresh-runtime checkpoint. The two [SIGKILL probes](abrupt-recovery.md)
preceded this storage optimization and have not been repeated on it.
