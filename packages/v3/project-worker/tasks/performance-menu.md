---
status: parked
size: large
---

# Clean-room performance: the menu (parked 2026-09-04)

The whole performance picture for `packages/v3/project-worker` in one place: what shipped, the ranked
menu of what's left (big and small), the quantified ceilings for each named workload, the
measurements still to run, and the ideas already refuted so nobody re-files them. Parked here on
2026-09-04 after two rounds of measure → change → prove; nothing below is in progress.

Deep detail lives beside this in `docs/perf/`:
- `docs/perf/2026-09-03-autoresearch-log.md` — the running log of every change + numbers.
- `docs/perf/2026-09-03-stress-ceilings.md` — the quantified ceilings and the raises.
- `docs/perf/learnings-and-bigger-refactors.md` — sizing, platform facts, capability-dropping options.

## Ground rules (kept throughout)

- No capability dropped; LOC growth ≤ 10 % and only for meaningful gains.
- NO existing event made ephemeral — `stream/created` and `stream/woken` stay durable and unfiltered.
- A number only counts when measured against the DEPLOYED worker
  (`WORKER_BASE_URL=https://project-worker.iterate.workers.dev pnpm e2e`, `pnpm bench`, `wrangler tail`).
  Local workerd is for iteration only.
- The tooling exists: `pnpm bench` (tinybench over the e2e client, deployed-target aware) and
  `bench/tail-summary.ts` (summarise a `wrangler tail --format json` capture by lane).

## The headline finding

Almost every high-volume ceiling is hit by INDIVIDUAL appends and dissolved by MULTI-EVENT appends,
and `stream.append(...events)` already commits N events in one call / one commit / one fan-out pass.
So the single biggest throughput lever is CLIENT-SIDE frame/append coalescing — out of this worker's
code, in the client SDK. The server is already ready for it.

---

## A. Shipped this session (done + proved on the deployed worker — do not redo)

| # | Change | Proven effect |
|---|---|---|
| 1 | `/demo` page → Workers static asset | −255 KiB from every isolate |
| 2 | Built-in-rooted dispatch skips materializing the rules table (L4) | one allocation/call gone |
| 3 | Warm facet push memoizes its source hash (L1a, WeakMap) | O(source) loop/push gone |
| 4 | The mark IS the core cursor | −1 storage write per durable commit (−33 %) |
| 5 | Skip `CREATE TABLE` on a re-wake | −2 statement prepares per wake |
| 6 | Facet watchdog label built lazily | no `print()` over the batch per push |
| 7 | `limits.subrequests` + `cpu_ms` raised | long sessions survive; 10× CPU headroom |
| 8 | Fan-out target-head memo (per row + rule-table identity) | one target eval per generation, not per push |
| 9 | **zod deleted from the edge/DO script (W3b)** | **Worker Startup Time 18 → 7 ms; upload 1,226 → 695 KiB** |
| 10 | **M1: inline processor sources out of core state** | **SQLITE_TOOBIG facet ceiling ~20 → thousands; smaller memory + every core-change checkpoint** |

---

## B. The menu — open, ranked by judgment

### B1. Live-state per-type gating — RECOMMENDED FIRST (contained, high value for the many-processor case)

**Problem.** A facet pushes a live-state diff after every batch, as a stream event, through a full
loopback append + fan-out. With N processors changing state per event that is N loopback appends per
event — the storm. Live-state cost today is proportional to how many processors EXIST, not how many
are WATCHED.

**Change (the decided design).** Type each processor's live-state by its key:
`events.iterate.com/<key>/live-state-changed` (key = the processor slug, or a mini-app's LiveState
key), instead of one shared `events.iterate.com/live-state/changed` with `payload.key`. Then:
- A watcher subscribes `consumes: ["events.iterate.com/<slug>/live-state-changed"]` — exact-type
  match, precise gating and delivery through the EXISTING `consumesEvent`. No `where`, no JSONata, no
  per-key index beyond the consumed-types union.
- The parent passes `watched: boolean` (is that type in the consumed-types union, memoized by the
  subscriptions-object identity) to each facet on `processEventBatch`. `LiveState.set` skips the diff
  + loopback append when unwatched, still advancing the revision + base so a later watcher seeds from
  the door (`liveSnapshot`).

**Authoring surface: UNCHANGED.** The contract (`slug`, `stateSchema`, `events`, `consumes`, `emits`)
and the hooks (`reduce`, `projectLiveState`) do not change; live-state stays an automatic runtime
projection. The type is DERIVED from the slug on both ends by the SDK — nobody hand-writes it. The
watch side takes the slug through a helper (`liveStateChangedType(slug)` / `itx.watchLiveState(slug,
cb)`) and drops its client-side `payload.key` filter, so it gets simpler.

**Two small costs.** (1) The feedback-loop guard `processor.ts:119` goes from an exact-string check to
`!type.endsWith("/live-state-changed")` — one line, slightly widens the un-reducible namespace
(fine under trusted-client, worth a comment). (2) "Watch ALL live-state" (an inspector) loses its
single handle and must enumerate types (`*` never sweeps ephemerals); rare, the common
one-processor-watch case is served better than today. Also reserve the `…/live-state-changed` fact in
`defineProcessorContract` so an owned event can't collide.

- **Effect:** live-state CPU per event goes from O(changing processors) to O(WATCHED changing
  processors) — a 20-processor context with a UI watching 2 does ~2 loopbacks/event, not ~20. Est.
  2-5× per-event throughput at N=20 mostly-unwatched (~200-500 → ~1000 durable ev/s). ~0 for a few
  processors or when everything is watched.
- **Honesty:** the CONSTANT is unconfirmed — deployed fixtures show cpuTime p50 = 0, and the loopback
  invocations showed 0 cpuTime in the tail (their cost is RPC wall = free CPU, plus marshal +
  parent-append). Build the bench below to pin it.
- **Effort:** ~40 LOC — `live-state.ts` (typed emit + `watched` skip), `processor.ts` (the
  one-line guard + thread the flag), the flag on `processEventBatch`, `stream.ts` core LiveState,
  the client helper, tests. Capability-neutral (live-state is lossy by contract).
- **Prove:** the 20-processor bench in section D (watched vs unwatched, tail cpuTime delta), plus an
  e2e: "20 unwatched processors emit nothing; watch one and only its type flows."

### B2. Pager-WS direct send for the live-client lane — the audio/streaming lever (NOT doing now)

Explicitly deferred (2026-09-04). For the fire-and-forget lent-client-stub push lane only (a live
client watching a stream), send the delivery frame down the already-open pager WebSocket
(`ws.send({ deliver: [events, range] })`, the edge relay invokes the client's capnweb callback)
instead of a Workers-RPC subrequest per frame. Removes one subrequest + one marshal per push AND the
F-subreq accumulation on the fan-out side — the whole per-frame cost for a 10-person audio call.

- **Lane boundary (the ack rule):** ONLY the no-ack push lane. Facet pushes are AWAITED (ordering,
  quiesce safety) and cursor pushes are ACKED (at-least-once); both keep Workers-RPC. So the ws.send
  is the live-client lane exclusively — exactly the real-time case.
- **Effect:** halves per-push cost for streaming; a live audio session stops accumulating subrequests
  against its stateless pump invocation.
- **Effort:** protocol change to the pager (it carries data frames, not just lend-control) across
  `rpc-stub-relay.ts` + `rpc-stub-directory.ts` + the edge relay. Medium, and it touches the
  reconnect/hibernation path (inherently flaky — guard with the reconnect e2e).
- **Judgment:** likely the biggest lever for real-time throughput because it helps the WATCHED path
  that gating does not touch. Take it after B1 if audio throughput becomes a real requirement.

### B3. Precise `consumes` guidance + checkpoint-skip — free, overlaps the storm

Facets are permanent and many (decided: we will NOT collapse them to one isolate). The fan-out floor
is then "N awaited pushes per CONSUMED event." The lever is what each facet consumes: default
`consumes: "*"` is the anti-pattern at scale — a PCM frame typed `audio/frame` should reach only the
audio reducers, not all N. Plus: skip a facet's checkpoint cursor write when a push reduced nothing
(the facet then replies with its output gate open). Together, a facet pays ~nothing for an event it
does not want.

- **Effect:** turns "N pushes/event" into "the few that care"; large for the many-processor case IF
  processors use precise consumes.
- **Effort:** docs/guidance + ~+6 LOC checkpoint-skip in `processor.ts` (see
  `stress-ceilings.md`, the "facet checkpoint" note — helps catch-up/rebuild more than steady state,
  which is why it was not auto-shipped).

### B4. Client-side burst coalescing — the raw throughput answer (client SDK, out of this worker)

Coalesce frames/appends per cadence tick into one `append(f1..fN)`. Raises the inbound subrequest
ceiling AND the fan-out CPU ceiling ~Nx at once. Cost: up to (N−1) frame-periods of latency before
the first frame ships (~180-200 ms at N=10 @ 50 fps) — tune N to the latency budget. The server
needs no change.

### B5. Multi-row INSERT on the batched append path — small, confirmed

Collapse ~96 `sql.exec` dispatches into 4 multi-row INSERTs for a 100-event batch: ~0.3-0.5 ms of the
4.78 ms (~6-10 %). +10-14 LOC into the byte-identity chunking (the most correctness-sensitive code).
Zero for single-event appends (the dominant path). Low priority.

### B6. Bound the per-subscription delivery backlog — the OOM fix (safety, not throughput)

A slow subscriber's `.then()` chain captures each commit's events array and grows to 128 MB in
~35-47 s (a gentle +10 commits/s → ~35 min). Carry a RANGE, not per-commit event arrays, so a slow
subscriber costs O(subscriptions) memory not O(backlog). Care: for a FacetHandle target the closure
events ARE the awaited in-order payload, so the range-carry must keep ordered delivery. Protocol-ish;
do it if a real slow-subscriber crash shows up.

### Rejected by decision (do not pursue)

- **Multiplex N reducers into one facet isolate** — would give ~10× on all three facet ceilings, but
  DECIDED 2026-09-04: there will always be many userspace facets, we will not collapse them. Off the
  table.

---

## C. The ceilings (one DO = one single-threaded isolate)

| Workload | Individual-append ceiling | Batched | Fails by |
|---|---|---|---|
| durable appends, one context | ~100/s (output-gate confirm is PER-TURN, ~10 ms) | ~2,900/s (N=100) | output-gate stall |
| 60k ephemeral PCM frames/s | impossible: ~43k/s at K=1 subscriber, ~6k/s at K=10 | feasible at N=10/tick | 100 % CPU + subrequest cap |
| 10-person audio (5,000 deliveries/s) | ceiling ~8-10k/s | — | 100 % CPU |
| 20 default (`*`) facets | ~200 ev/s (~5 ms/event; ~4 ms is the live-state storm) | — | 100 % CPU |

**DO OOM (128 MB):** the slow-subscriber backlog (B6). **DO CPU (30 s default, 5 min max — raised):**
a cold re-reduce over a long log, or the O(rows) fan-out at many rows. Ephemerals touch zero SQLite.

---

## D. Measurements still to run

1. **The 20-processor live-state bench (pins B1).** A context with 20 default processors, durable
   appends at a steady rate; read the deployed tail's cpuTime-per-append in two conditions — no
   watcher (gated) vs one watcher per processor (full storm). The delta at N=20 is B1's real number.
   Add it as a `bench/` scenario; it does not exist yet.
2. **Append RTT under facet fan-out, attributed, in workerd** — time `kv.get(memo)`, the marshal,
   `LOADER.get`, `getDurableObjectClass`, `ctx.facets.get`, the RPC, the checkpoint separately at
   500 B and 300 KB sources.
3. **The wake bill** — one read-only probe every 5 min for an hour on a context with default
   processors: billed duration, facet materializations, log rows added.
4. **The SQLITE_TOOBIG cliff on deployed DO SQLite** (M1 moved it; confirm the cell cap on the edge).
5. **A re-wake bench lane** — evicted context, first call; ~150-250 ms re-wake vs ~20-40 ms warm
   expected. Needed before any further wake-side change is provable.

---

## E. Refuted by the adversarial verify pass — do NOT re-file

- `allowUnconfirmed` on `transactionSync` / `kv.put` — no such option in workerd's JS bindings.
- Defer the post-commit fan-out to a macrotask — drops the synchronous alarm-arm that recovers a
  stranded cursor row; breaks at-least-once.
- Drop the UNIQUE index for keyless events — a schema migration, and the index append is amortized to
  the rightmost page for all-NULL keys anyway (~0 gain).
- "Kill the 20×20 storm" as a cheap onCommit early-out — the loop it skips is already cheap; the real
  cost is the loopback APPENDS, which B1 removes and the early-out does not.
- JSONata as the GATING filter — un-indexable, per-event evaluation is more expensive than the storm.
  Fine only as an opt-in delivery-time filter, never on the gate.
