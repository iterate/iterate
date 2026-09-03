# The clean-room throughput ceilings, OOM/CPU limits, and how to raise them (2026-09-03)

A 6-agent analysis (read the source + workerd + the docs) quantified each named workload, then a
verify pass adversarially scrutinised every proposal. The verify killed several overstated or
capability-breaking ideas (kept below under REFUTED) — trust the confirmed numbers, not the raw
analysis.

## The one answer to almost everything: BATCH. The server already supports it.

Every high-volume ceiling is hit by INDIVIDUAL appends and dissolved by MULTI-EVENT appends, and
`stream.append(...events)` already commits N events in one call / one commit / one fan-out pass. So
the single highest-leverage change is CLIENT-SIDE: coalesce frames/appends per cadence tick into one
`append(f1..fN)`. It is out of this worker's code (client SDK), but it is THE architectural lever.

| workload                                                | individual-append ceiling                                                                            | batched (N/tick)      | why                                                                                                              |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| durable appends, one context                            | **~100/s**                                                                                           | **~2,900/s** (N=100)  | the output-gate durable confirm is PER-TURN (~10 ms), not per-append; batching collapses N rows into one confirm |
| 60k ephemeral PCM frames/s                              | **impossible** — ~43k/s at K=1 subscriber, ~6k/s at K=10, CPU-bound; and the inbound subrequest wall | feasible at N=10/tick | one DO = one JS thread; per-frame fan-out CPU × K, plus one inbound subrequest per frame against the WS pump     |
| 10-person audio (10×50fps×10 subs = 5,000 deliveries/s) | ~8-10k deliveries/s ceiling, CPU-bound                                                               | comfortable           | per-delivery ~50-60 µs DO CPU (target eval + marshal + clone)                                                    |

Cost of batching: up to (N-1) frame-periods of added latency before the first frame ships (~180-200 ms
at N=10 @ 50 fps) — tune N to the latency budget.

## The ceilings, quantified (one DO = one single-threaded isolate)

1. **Durable throughput** — output-gate confirm, PER-TURN. Awaited single appends ~100/s; batched
   ~2,900/s. Fails by output-gate stall (not CPU, not SQLite rate). `allowUnconfirmed` would skip the
   ~10 ms wait but is NOT available on `transactionSync` in workerd's JS API (verify REFUTED it).
2. **Ephemeral throughput** — DO JS CPU in the per-subscriber fan-out. ~43k/s at K=1, ~6k/s at K=10.
   Ephemerals touch zero SQLite (the fast path), so it is CPU + cross-worker RPC, never storage.
   Fails by 100% CPU; secondary OOM if a slow subscriber's delivery chain backs up (ceiling 6).
3. **20 facet processors** — the parent DO's single JS thread, NOT memory. Per durable event: ~0.3 ms
   own commit + ~1 ms 20-row fan-out + **~4 ms of 20 live-state loopback re-commits** ≈ 5 ms/event →
   ~200 ev/s. Memory is ~safe (20 isolates but the loader caps in-flight ~10/DO; RSS is the watch
   item at ~5 MB/isolate → ~100 MB near the 128 MB cap). Fails by 100% CPU first.
4. **DO OOM (128 MB) / CPU (30 s default, 5 min max)** — the OOM path is a SLOW SUBSCRIBER: onCommit
   chains a `.then()` per commit capturing that commit's events array (subscription-delivery.ts), so a
   subscriber behind by +450 commits/s × ~6 KB ≈ 2.7 MB/s → 128 MB in ~47 s (a gentle +10/s → ~35 min).
   The CPU path is a cold re-reduce over a long log, or the O(rows) fan-out at many rows.

## Landed this round (safe, deployed)

- **`limits.cpu_ms: 300000`** (wrangler.jsonc, +1 line) — 10× the 30 s CPU-time default before an
  abort, for cold re-reduce and large fan-out. Verify: do-now=True; it is CPU-time not wall, and a
  re-reduce that needs >30 s is itself a smell (see M1 / paged re-reduce below).
- **Memoize the evaluated target head per subscription row** (subscription-delivery.ts, +~22 LOC) —
  a row delivered every commit (a PCM stream, an audio call) re-walked its target and re-minted a
  Facet/RpcStub handle on EVERY push; now once per (row identity, rule-table) generation. Correctness:
  invalidated by BOTH `configuredAtOffset` (reconfigure) and the rewrite-rule table's object identity
  (any provide/un-set), so a re-pointed target never serves stale — the caveat the verify raised.
  Verify: real but single-digit-% of per-push CPU (the dominant per-push cost is the Workers-RPC
  marshal + structured-clone, which this does not touch); it helps the individual-append case most.

## The big structural levers (confirmed, on the menu — bigger than one loop step)

- **M1 — get the inline processor source OUT of core reduced state.** CONFIRMED by verify: the
  checkpoint blob (coreReducedState) shrinks from O(Σ source) to O(rows), lifting the SQLITE_TOOBIG
  reconfiguration ceiling from ~20 processors (at 100 KB sources) to **thousands**, shrinking resident
  memory and every core-change checkpoint write. The row keeps a reference; the source is recovered
  from the log event (already chunked) when the facet materializes. ~+40/−20 across core-processor.ts
  (reduce + row shape + a CoreContract version bump), iterate-context-durable-object.ts (memo-miss
  recovery), iterate-context.ts/subscriptions.ts (one shared spec-shape helper). THE top structural
  win for facet scaling and the OOM/checkpoint ceilings — do it next, carefully, with a version bump
  and a full deployed re-reduce proof.
- **Multiplex N reducers into ONE facet isolate** (one push, one loopback, one isolate) — ~10× ALL
  THREE facet ceilings: isolates 20→1 (RSS ~160 MB→~8 MB, the ~10-in-flight-per-DO loader cap becomes
  moot), parent fan-out 20→1, loopback 20→1. Large refactor (~+120/−40); a real architecture change to
  how processors are hosted. The single biggest lever for "20 processors", but a design decision.
- **Push frames DO→client directly down the pager WebSocket** (`ws.send`), skipping the edge
  LentRpcStub Workers-RPC hop — removes one subrequest + one structured-clone per push, halving
  per-push cost and removing the F-subreq accumulation on the fan-out side. Protocol change (relay +
  directory rework); the biggest single per-push saving for audio/streaming.
- **Bound the per-subscription delivery backlog** (the OOM fix) — carry a RANGE, not per-commit event
  arrays, so a slow subscriber costs O(subscriptions) memory not O(backlog). Verify: needs care — for
  a FacetHandle target the closure events ARE the awaited in-order payload, so the range-carry must
  keep the facet's ordered delivery. Protocol-ish.
- **Client-side burst coalescing** (the batching answer above) — client SDK, out of this package.

## Multi-row INSERT (confirmed, small, menu)

Collapsing ~96 `sql.exec` dispatches into 4 multi-row INSERTs saves ~0.3-0.5 ms of the 4.78 ms
100-event batched append (~6-10%), but +10-14 LOC into the byte-identity chunking — the most
correctness-sensitive code. Menu.

## REFUTED by the verify pass (do NOT re-file)

- `allowUnconfirmed` on `transactionSync`/`kv.put` — no such option in workerd's JS bindings.
- Defer the post-commit fan-out to a macrotask — drops the synchronous alarm-arm that lets an
  eviction recover a cursor row; breaks at-least-once.
- Drop the UNIQUE index for keyless events — a schema migration, and the index append is amortized
  to the rightmost page for all-NULL keys anyway (near-zero gain).
- Multiplex/early-out "kill the 20×20 storm" as a cheap onCommit early-out — the loop it skips is
  already cheap; the real cost is the 20 loopback APPENDS, which the early-out does not remove.
- Lazy CoreContract construction — CoreContract is already a plain object literal (no zod) since W3(b).
