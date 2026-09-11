# Trust policy: one read, still one decision per event

5 September 2026. Local public-network evidence, not deployed capacity proof.

The next measured storage change combines the trust value and the offset of
the event that installed it. An ordinary new event now makes three SQL calls
(duplicate lookup, policy lookup, INSERT), down from four after the previous
[single-INSERT change](append-cost.md). Settings events still make their
additional settings write. No batch-wide policy cache was added:

```ts
// Inside the per-event commit loop and its synchronous transaction:
const policy = sql
  .exec<{ value: string; offset: number }>("SELECT value, offset FROM settings WHERE key = 'trust'")
  .toArray()[0];
const trust = Trust.parse(policy ? JSON.parse(policy.value) : { keys: [], minLevel: 0 });
// Stored verification uses this same row's offset, or 0 during bootstrap.
```

## Authorization proof before changing the query

The added public HTTP test describes one policy transition:

1. Bootstrap installs Alice as the required trusted signer at offset 1.
2. Alice signs a rotation to Bob. A batch containing that rotation followed
   by an Alice-signed note is rejected with `SIGNATURE_REQUIRED` and leaves
   exactly the bootstrap event: both event insertion and the policy change
   roll back.
3. The same rotation followed by a Bob-signed note succeeds at offsets 2/3.
   Their verification policy offsets are respectively 1/2, both at level 2.
   The rotation cannot authorize itself using its replacement policy.
4. Retrying the rotation returns its original verification envelope. Retrying
   bootstrap does not reinstall Alice's authority. A new Alice-signed event
   and an unsigned policy-setting event remain forbidden.
5. Public replay returns the original complete envelopes, not verification
   recomputed using the latest policy.

This characterization passed before and after the query change; it is not a
claim of a newly fixed authorization bug. Its first invocation failed because
the test omitted the raw JSON API's required read-options object; the typed
Capnweb wrapper normally supplies that object. That fixture error was corrected
before measuring or modifying the implementation.

The existing tampering test was also strengthened: `data`, `parents`, and
`producer` now change independently while the event ID stays fixed. Previously
each case changed the ID too, so rejection alone did not prove those other
fields were signed. The signature-byte corruption case also retains its ID.
The test response uses the public `EventRecord` type rather than a duplicate
local declaration; signature generation remains independent of server code.

## Matched before/after measurements

Same protocol as [append cost](append-cost.md): Apple M4 Max, arm64, Node
26.5.0, local Wrangler 4.127.1, Capnweb 0.12.2, debug logging. Three sequential
rounds, each JSON singleton, JSON batch, Capnweb singleton, Capnweb batch.
Fresh project per case; warm `inspect`; 500 × 1 or 100 × 100 appends with a
1,024-character ASCII `data.text`. Total timing includes payload construction;
request timing excludes it and ends at decoded receipts. Percentiles use
`floor(requestCount * p)`. All receipts have the expected count.

Each run replayed **all 63,000 events**, checking consecutive offsets and full
payloads in 100-event pages outside append timing. Client/server share a
machine; there is no deployed CPU, saturation, signed-event, or fanout claim.
Values below are rounds 1 / 2 / 3; latency is per request, not per event.

| Transport / change | Batch | Events/sec            | p50 ms                | p95 ms                | p99 ms                |
| ------------------ | ----: | --------------------- | --------------------- | --------------------- | --------------------- |
| JSON before        |     1 | 294 / 307 / 299       | 3.31 / 3.09 / 3.15    | 4.08 / 4.62 / 4.70    | 4.94 / 6.36 / 7.83    |
| JSON after         |     1 | 289 / 303 / 303       | 3.27 / 3.09 / 3.08    | 4.58 / 4.69 / 5.67    | 6.96 / 7.64 / 7.13    |
| Capnweb before     |     1 | 294 / 292 / 292       | 3.25 / 3.26 / 3.22    | 4.40 / 4.68 / 5.97    | 6.34 / 6.85 / 7.32    |
| Capnweb after      |     1 | 292 / 294 / 300       | 3.22 / 3.20 / 3.15    | 5.07 / 5.08 / 4.88    | 6.88 / 7.54 / 7.38    |
| JSON before        |   100 | 6,637 / 6,584 / 6,681 | 14.80 / 14.55 / 14.40 | 19.70 / 20.39 / 18.76 | 25.04 / 23.24 / 22.33 |
| JSON after         |   100 | 7,632 / 7,743 / 7,675 | 12.85 / 12.26 / 12.25 | 16.29 / 16.65 / 18.02 | 17.48 / 19.00 / 21.99 |
| Capnweb before     |   100 | 6,285 / 6,434 / 6,351 | 15.15 / 15.12 / 15.35 | 21.29 / 20.54 / 20.67 | 31.90 / 24.91 / 25.42 |
| Capnweb after      |   100 | 7,389 / 7,436 / 7,460 | 13.20 / 12.98 / 12.63 | 17.29 / 18.03 / 17.57 | 23.83 / 20.58 / 20.20 |

Median batch throughput rises 15.6% (JSON) and 17.1% (Capnweb). Singleton
differences are small and not a useful capacity conclusion. The previous
existing-core comparison remains much faster at about 17,500 batch events/sec;
it was not rerun in this pass and has the documented semantic differences.
No new CPU profile was taken. The performance branch is based on the previous
SQL-heavy profile and this matched elapsed-time experiment.

The read phase for batch cases took 374–382 ms JSON / 405–424 ms Capnweb
before, and 380–384 / 408–448 ms after, for 10,000 events each. This is not
evidence that read performance improved; singleton read phases are too short
to interpret.

Persistence: `/tmp/project-core-trust-cost-JhE6sT`. Before marker:
`538e9e2b-af3d-4c0f-8228-7d29930f4538`; after marker:
`3fdc21ff-4bb7-4cd1-a72f-449ff509bf39`. Project names:
`trust-<marker>-<round>-<json|capnweb>-<1|100>`. Benchmark process log:
`wrangler-2026-09-04_23-58-34_646.log` in the usual local Wrangler log directory.

After measurement, two equivalent WebCrypto byte copies were expressed with
`Uint8Array.from(...).buffer`; the unused `eventSigningBytes` wrapper was
removed (no callers, including the independent browser/test signers). Neither
changes the measured unsigned append path. No functional code or tests were
moved outside the line counter. Latest suite/count/log evidence is in
[local verification](local-verification.md).

## Lifecycle gap found at this checkpoint

A separate source audit found that raw `/events` clients can retain one of
64 subscription slots indefinitely without acknowledging their first page.
`Stream.send()` records `awaiting` and suppresses further sends, but has no
deadline. The Capnweb callback timeout does not apply to these raw sockets.
This is a source-confirmed missing lifecycle bound, not yet a timed network
reproduction. Required next proof: withhold ACKs, observe bounded closure,
then connect a replacement subscriber and replay without losing events.
The subsequent [ACK-lease implementation and network proof](stream-ack-deadline.md)
closes that slot-retention gap and records the remaining native transport
tail. Do not claim deployed hostile slow-reader/backpressure acceptance is complete.

A later [transaction-local policy read](transaction-trust-cost.md) removes
repeated SELECTs without freezing the policy for the batch: every actual
trust-setting write advances the call-local value before the next event.
