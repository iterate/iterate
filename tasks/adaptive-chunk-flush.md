---
status: ready
size: medium
---

# Adaptive-window decoupling for agent chunk journaling

## Status

Spec settled via grill-you interview (transcript: [adaptive-chunk-flush.interview.md](./adaptive-chunk-flush.interview.md)),
2026-08-28 bedtime run. Implementation, specs, and explainer complete; all
checks green. Awaiting review.

## Problem

#2531 coalesced chunk journaling into ~150ms windows, but the flush append is
still **awaited inside `onChunk`** — the transport drain still shares fate
with the stream DO: throughput is `window/(window + append latency)` of
provider rate. Fine at today's 60ms appends; degrades linearly if the DO
degrades. Chunk events are forcibly ephemeral — a lane allowed to LOSE data
must not be allowed to SLOW the producer.

## Design (settled)

- **`pendingFlush: Promise<void> | null`, cap of one.** `flushChunkBuffer`
  fires the append **without awaiting**, `.catch(() => {})`-wrapped at
  creation (unhandled-rejection hazard), clearing `pendingFlush` in a
  `finally` (a rejected append must not wedge the lane).
- **Single buffer IS the merge.** The synchronous snapshot-and-reset in
  `flushChunkBuffer` means chunks arriving while an append is in flight
  accumulate in the fresh buffer. No second accumulator.
- **Only chunk arrival triggers a flush**: `pendingFlush === null` AND the
  window/size gate. No settle-triggered flush (else DO commit rate becomes
  the cadence), no timers. Invariant: flush cadence never exceeds ~1/window
  regardless of append speed.
- **Completion epilogue, identical on success and catch paths:**
  `await pendingFlush.catch(noop)` → tail `flushChunkBuffer().catch(noop)` →
  atomic settle. One-time cost (≤2 append latencies), keeps the
  no-chunk-after-settle invariant; the "never slow the producer" principle is
  about mid-stream delivery, not turn-end bookkeeping.
- **Abort path deliberately abandons a floating flush** (early return on
  `signal.aborted`): same accepted loss mode as eviction-mid-flush; the
  cancelled settle's `partialText` covers the UI. Do NOT "fix" by awaiting.
- **Rejected flush = lost window**: sequence number never reused, gap is
  legal (consumers dedupe/sort by sequence; eviction already creates gaps).
- **No memory ceiling while busy.** `CHUNK_FLUSH_MAX_BYTES` is a flush
  trigger when the lane is free, explicitly NOT a memory/payload bound while
  an append is pending. Bounded by the response itself (which
  `inFlight.partialText` already duplicates). An oversized merged window
  whose own append rejects is the same lost-window mode. Self-heal: the
  committed assistant context-added extends `responseWindows` to the full
  text at completion (#2531 reducer fix), so even total chunk-lane loss heals
  in the UI when the turn settles.
- **No `runInBackground`/keepalive changes**: the streaming closure's own
  wrapper structurally spans every `pendingFlush` (mid-stream via
  `await this.attempt(...)`, turn-end via the epilogue await).
  `abandonExpired` needs no separate treatment (same abort signal).
- **Ordering survives by construction** (cap-of-one serializes flushes:
  N+1 fires only after N settles) — one code comment, not a spec.

## Checklist

- [x] Spec: "a pending flush never blocks the drain: later chunks merge into the next window" (hold flush 0's append; chunks 2+3 consumed immediately, nothing new journals; release; next eligible chunk lands sequence 1 as one merged window in provider order)
- [x] Spec: "a rejected in-flight flush does not wedge the lane" (sequence gap, next window fires with next sequence, delivery never stalls, settle succeeds with full text)
- [x] Update the swallowed-tail spec for the new epilogue; retire the old "backpressures chunk flushes" spec (it pins the removed behavior)
- [x] Implement in `agent-llm-request.ts` `run()` per the design above
- [x] Explainer (committed, `explainers/`) covering the before/after under healthy and degraded DO
- [ ] `pnpm typecheck && pnpm lint && pnpm knip && pnpm format && pnpm test`
- [x] Draft PR linking this file + the interview transcript

## Out of scope

Fix-B unbounded pipelining, per-token events, contract/schema changes, UI
changes, voice/mobile, compaction, the watchdog's budget, transport module.

## Guesses and assumptions

- [guess] No-settle-triggered-flush over flush-on-settle: taste call between
  two workable designs; chose the leaner one with the cadence-floor
  invariant. Costs ≤1 inter-chunk gap (~20ms) of extra coarseness after a
  slow append settles.
- [guess] One folded story-shaped spec over two smaller ones — matches the
  repo's test-aesthetics preference for readable end-to-end stories.
