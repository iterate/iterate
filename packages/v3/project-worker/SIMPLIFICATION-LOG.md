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
- **Greenfield ideation landed** → `LAYERING-IDEATION.md` (the north star): 5 layers (EventLog →
  Stream → Context; Processor = reduce over a Stream _source_; SturdyRefTransport = pager/relay).
  Top-3 clean-ups: (1) real-typed uniform-async `Stream`/`Context` interfaces, (2) typed
  Expression AST + delete `boundaryArgs`, (3) `StreamSource` as a processor param.
- **Clean-up #1 DONE — the gross seam, fixed properly** (not named, _dissolved_). New
  `src/core/stream.ts`: `Stream` (append/read) + `Context extends Stream` (+ invoke) +
  `localContext(self)`, all **uniform-async and typed with the REAL event types**
  (`StreamEventInput`/`StreamEvent`/`StreamPage`). Because the arg/return types are real (not
  `unknown[]`), the contravariance that forced `as unknown as` vanishes: a `DurableObjectStub`, the
  own-path adapter, and a Pi RpcTarget all satisfy `Context` with **zero casts**. Deleted: the
  inline `ownContext` literal (→ `localContext(this)`), the `deps.context` `{append;read}` +
  re-cast, and both `as unknown as` casts in `contexts.get`. Typecheck clean; full suite
  **280 passed / 38 xf / 2 skip / 31 todo**; perf held (58824 ev/s, p50 9ms / p95 13ms, 50×) and
  the one-directional census is IDENTICAL (`{in:push 100, in:pull 100, out:resolve 100,
in:release 100}` — zero outbound initiations).
- **C-D (partial) — `print()` not string interpolation** in `#parkAsTarget`: the parked-connection
  target is now `print(["itx","connections",["get",connectionId]])`, which quote-escapes the id
  (injection-safe for non-numeric / off-platform ids). Canonical form identical for today's numeric
  ids. Typecheck + connections/dotted/perf green.
- **HONEST FINDINGS as I went to execute the rest** (recorded so we don't relitigate): several
  roadmap items are entangled with _deliberate_ design, so they are NOT the clean wins they seemed:
  - **Unguessable connectionId — SKIPPED.** It fights a documented doctrine: `connectionId =
String(connectedAtOffset)` because "the log names every connection; no synthetic ids"
    (`itx-connection-directory.ts:5-6`, Kenton-aligned). The guessable offset is defense-in-depth
    only (the scope is the gate, not the id); overriding the doctrine for it is a net loss.
  - **Typed Expression AST — a WASH, deferred.** The nested-array literals (`["itx","facets",
["get",slug],["snapshot"]]`, 14 sites) are _compact_; `{root,steps}` objects are verbose at
    construction. It's clarity-at-consumption vs verbosity-at-construction, plus match/walk hot-path
    risk. Not a clear muddiness win; only worth it with a clean builder, and even then marginal.
  - **Delete `boundaryArgs` — deferred.** It handles a real subtle case (`itx.notify(x)` — calling
    a mounted capability directly with args, which `prove_slack` exercises). Deletable only by
    unifying it with `runtimeArgs`; risks routing regression for −1 concept.
    Remaining CLEAN win: **B2 — the `StreamSource` decouple** (removes the processor↔own-log coupling,
    fights no doctrine, delivers the off-platform capability). Doing that next.
- **B2 finding — the decouple is ALREADY DONE.** The processor base class already takes its source
  as an injected parameter: `protected readonly stream: ProcessorStream` from `constructor(args: {
stream: ProcessorStream })` (`core/processor.ts:153,165-174`), and reads/appends through
  `this.stream` (`:377,402,446,531`). `ProcessorStream` (`{ append, read }`, `:73-79`) is the same
  concept as `core/stream.ts`'s `Stream` (its event types are literally `StreamEvent`/`StreamEventInput`
  import-aliased, `:45-46`), and its `append: Promise<…> | …` union DELIBERATELY spans a sync local
  source and an async foreign one. So "make the source a parameter (local vs foreign)" is not a
  refactor to do — it exists. Nothing to simplify here; forcing a `Stream`/`ProcessorStream` merge
  would only remove the deliberate sync-or-async flexibility. **What remains for off-platform is an
  ADDITIVE FEATURE** (construct a foreign `ProcessorStream` + wire it through enablement + cross-DO
  push), not a muddiness reduction — a separate, sizeable effort, flagged as the clear next step.

## Where this pass landed (honest summary)

The CLEAN simplifications available were: **Clean-up #1 (the gross seam, dissolved — the big win)**
and **the print() hygiene**. Both done, verified, committed, zero regression. On going to execute
the rest, each turned out to be entangled with _deliberate_ design or already-implemented:
unguessable-id fights the "log names connections" doctrine; the typed AST is a wash + hot-path risk;
`boundaryArgs` guards a real direct-call case; the processor-source decouple already exists. So the
muddiness the pass could cleanly remove has been removed. The **off-platform stream** is now a
well-scoped ADDITIVE feature (foreign `ProcessorStream` + enablement wiring + cross-DO push), sitting
on a codebase that (pleasingly) is already factored for it — the next focused build, not a cleanup.

## Off-platform feature — a processor that reduces a FOREIGN stream (DONE, end-to-end)

Built the additive feature (Jonas: "crack on"). A facet processor can now reduce a stream that lives
ELSEWHERE — another context, or an off-platform box — keeping only the derived state, never the raw
firehose. Reuses existing machinery (the injected `ProcessorStream` + the cross-DO read); the only
new transport is _none_.

- **`sourceStream` (a sturdy-ref itx-expression) threaded** through: `Itx.enableProcessor(slug, ref,
{ sourceStream })` → `ProcessorPolicy.sourceStream` (canonicalized via `print()`, not interpolated)
  → the capability-provided event schema (added `sourceStream` — it was being STRIPPED by the strict
  `z.object`, the bug that made the first run reduce the OWN log) → `FacetProcessorEntry` → the
  `FacetIdentity` at configure → `ProcessorFacet.#p()`.
- **`ProcessorFacet.#p()`**: when `identity.sourceStream` is set, the `ProcessorStream` reads/appends
  the FOREIGN stream by RESTORING the ref through `parent().invoke([...sourceExpr, ["read"/"append",…]])`
  — i.e. `contexts.get('/x').read(...)`, the cross-DO read that already existed. Absent = the own log.
- **The commit pump SKIPS a foreign-source facet** (`if (sourceStream) continue`): its events come
  from elsewhere, so pushing THIS DO's commits at it would fold the wrong events. It catches up from
  the foreign stream on snapshot/wake instead.
- **Legible end-to-end test** `__tests__/foreign-source-processor.test.ts`: appends sensor events to a
  SIBLING context `/sensors` (the same `contexts.get` addressing a Pi would use), enables `tally` on
  the ROOT pointed at `/sensors`, and proves the tally counts the SIBLING's events (`{motion:2,temp:1}`)
  while the root's OWN log stays empty of them. The raw snapshot shows offset 3 = the foreign stream's
  offset. Same mechanism for a real Pi: point `sourceStream` at `itx.homeassistant` (a provided live
  stream) instead of `contexts.get('/sensors')`.
- **Follow-on (flagged):** today the foreign-source processor is PULL (catches up on snapshot). Real-
  time delivery = the foreign stream PUSHES new events to it (a subscription from the foreign stream
  targeting the processor's wake), reusing the connected/forwarder lane. Additive, not yet wired.
- No regression: typecheck clean; full suite **281 passed / 38 xf / 2 skip / 31 todo**; perf held
  (66667 ev/s, p50 7ms / p95 11ms, 50×); one-directional wire census IDENTICAL.
