# Simplification log — stream/context/sturdy-ref clean-up (2026-08-20)

Goal (Jonas): do the roadmap we discussed as cleanly as possible, with legible well-explained
tests, **no regression to performance / websocket frames / delivery direction / latency /
throughput**. Commit frequently, keep this log so we can go back. Straightforward, fully-qualified
names — nothing abstract.

## The plan (ordered: pure-simplification first, capability last)

Each item is scored simplification (↓ muddiness) vs complexification (↑). See the discussion.

1. **B1 — name the `Stream` seam.** Extract an explicit `IterateStream` interface (the
   append/read/subscribe contract a bare stream is) at the `contexts.get(path)` seam. Naming an
   implicit thing → ↓ muddiness. No hot-path change.
2. **A1 — typed expression AST.** Replace `type Step = string | [method, ...args]` (nested arrays)
   with a discriminated union of named steps. Clarity ↓ muddiness; LOC ~flat. MUST NOT slow the
   match/parse hot path.
3. **A2 — dissolve `boundaryArgs`.** Fold the one boundary-call special case into matched-steps +
   remainder. −1 concept, ↓ muddiness.
4. **C-D — harden the connection arm.** Unguessable connection id (not the guessable offset), mint
   the target via `print()` not string interpolation, a `ConnectionRef` type that encodes "may be
   offline." Closes the one real ocap smell.
5. **B2 — decouple the processor source.** Today a facet processor's source is hard-coded to its
   own DO's log. Make the source a parameter (local = today's case, remote/foreign = a Pi stream).
   This is a DECOUPLE (removes hidden coupling), not a bolt-on. The delivery + read + reduce
   machinery already exists (cross-DO delivery via the subscription-forwarder + connected lane).

Deferred (not this pass): phantom-type the ref string (A), typed `SturdyRef` with kinds (C-B), the
arg-callback bridge (browser/full-duplex only), celld, row chunking.

## No-regression guards (run before committing each increment)

- **Frames / delivery:** `pnpm test` — the harness lane asserts the ONE `{type:"page"}` pager frame
  (`__tests__/failing-capnweb-wire.test.ts`), delivery lanes, connections, hibernation.
- **Throughput / latency:** `node proofs/prove_ephemeralflood.mjs` (against the live deployment
  after deploy). p50 < 500ms, p95 < 1500ms, sustained > 1000 ev/s.

## Baseline (2026-08-20, before any change)

- Tests: **279 passed | 38 expected-fail | 2 skipped | 31 todo** (33 files, ~56s).
- Perf (live, ephemeral flood 2000 events): **append 5479 ev/s | end-to-end 5479 ev/s | latency
  p50 203ms / p95 351ms / max 361ms | 40 callback invocations (50× batching)**. All perf guards
  pass.

## Increments (append one entry per commit)

- _(baseline)_ committed the BYO-stream artifacts from the design jam: `proofs/prove_byo_stream.mjs`
  (append/read off-platform works live) + `__tests__/failing-byo-context.test.ts` (the live-feed
  callback gap, `test.fails`), plus this log.
- **PIVOT (Jonas): "so gross — we want clean and elegant."** A first attempt at B1 (naming the
  `contexts.get` seam with an `IterateContextHandle` full of `unknown` returns + `as unknown as`
  casts) just papered over the mud. Reverted it. Dispatched a greenfield ideation (a fork with our
  full discussion) to design the clean target layering → `LAYERING-IDEATION.md`; will refactor
  toward that instead of incrementally naming the mud. Order below is now: land the ideation's
  target design, then execute it in clean increments.
- **Perf guard added** (`__tests__/throughput-latency-guard.test.ts`): the fast in-harness twin of
  `prove_ephemeralflood.mjs` — floods 1000 ephemeral chunks through the real capnweb→/api→DO→
  one-directional-delivery path and prints the numbers, so a throughput/latency/batching regression
  shows in seconds without a deploy. **In-harness baseline: append 62500 ev/s | end-to-end 62500
  ev/s | p50 8ms / p95 12ms / max 12ms | 50× batching | 0 loss.** (Local workerd ≫ live; the guard
  is the printed line compared across runs, plus the hard invariants.)
