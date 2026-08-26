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

## UNDO — the foreign-source/`sourceStream` feature is reverted (2026-08-20)

Jonas: "this is dumb — which bits can we undo? I'm happy to not have any streams on my Raspberry Pi
for now if we can reduce complexity." Done. Reverted both feature commits (`b70284800` the feature,
`c3745018a` the live proof) and deleted the BYO-stream exploration artifacts
(`proofs/prove_byo_stream.mjs`, `__tests__/failing-byo-context.test.ts`). `sourceStream` is gone from
the whole tree — `Itx.enableProcessor`, `ProcessorPolicy`, the capability-provided event schema,
`FacetIdentity`, `ProcessorFacet.#p()`, and the pump skip all back to their pre-feature shape.
Typecheck clean; suite **279 passed / 37 xf / 2 skip / 31 todo** (the 38→37 xf is the removed
`failing-byo-context` expected-fail — the feature's own paths are simply gone). Zero regression.

## The REAL finding behind "enableProcessor is dumb" (the layering already exists)

Jonas' target layering — _a context with capabilities; run arbitrary code in it; that code is a
stateless worker, or a durable class under a runner, or a facet; addressed via `itx.load(ref)` where
ref is inline/repo/callback + cache-key + stateful-vs-stateless_ — **already exists** as
`itx.workers.get({ source, className? })` (`built-ins.ts:100-133`):

- ONE loader, `confinedWorker(env, {kind, owner, contentHash}, …)` (`core/agent-runtime.ts:75-100`),
  keyed on DEPLOY (not a per-invocation nonce — the $7.8k apps/os gotcha, avoided here by design).
- `source` is an itx-`Expression` that evaluates to module code — so "inline code" (a literal),
  "point at repo" (an expr that calls a fetch cap), "callback" (an expr resolved through `invoke`)
  are all just different `source` expressions. The polymorphism Jonas wants is the Expression
  indirection, already there.
- `className` ABSENT → stateless confined worker (`run(...args)`/`fetch`, kind `code`).
- `className` PRESENT → the class hosted as a FACET of this stream (kind `stateful`), the "durable
  object under a runner" case.

So `itx.load` ≈ `itx.workers.get`. The naming differs; the shape is exactly Jonas' vision.

**Where enableProcessor is genuinely the odd one out** (Jonas is right):

1. It is ALREADY event-sourced sugar. `enableProcessor(slug, ref, props)` (`stream-durable-object.ts:899`)
   just calls `capabilityTableProcessor().provide({ path:'itx.processors.<slug>',
target:"itx.facets.get('<slug>')", processor:{source,export,props} })` — i.e. it APPENDS A MOUNT
   EVENT and warms a snapshot. "We'd normally just append events that mean the processor runs in a
   facet" — that is literally what it does.
2. But it duplicates the load path instead of reusing it. A userspace processor loads through a
   SEPARATE loader kind `procfacet` (`:864`) with a SEPARATE ref shape `{source, export}`, while a
   stateful worker loads through kind `stateful` (`:987`) with ref `{source, className}` — **same
   `confinedWorker` + `versionedFacet`, two names for "load a class as a facet."** The only real
   distinguisher is: a processor is DRIVEN BY THE COMMIT PUMP (a reduce) and registers a mount at
   `itx.processors.<slug>`; a stateful worker is called directly.

**The clean collapse (proposed, not yet done):** unify `{source, export}` and `{source, className}`
into one ref, merge loader kinds `procfacet`→`stateful`, and make "is a processor" = a fact in the
log ("drive this facet with commits") rather than a separate code path. Then `enableProcessor`
becomes either thin sugar over `workers.get({source, className}) + append(drive-fact)`, or nothing at
all. Awaiting Jonas' steer on naming (`itx.load` vs keep `workers.get`) and whether the sugar survives
before touching the loader kinds / pump.

## Executing the collapse — what's SAFE vs what would erase a real distinction

Went to do the collapse. Reading the actual seams changed the plan on ONE point, honestly:

- **The loader kinds are NOT redundant — do NOT merge them.** `code`/`procfacet`/`stateful` load
  genuinely DIFFERENT module sets (`code` = no SDK, stateless `run`/`fetch`; `procfacet` = SDK +
  `runner.js` adapter so the author writes a `StreamProcessor` reduce, commit-driven; `stateful` =
  a raw DO class loaded directly, call-driven). The kind is also the **cacheKey namespace**, which
  `wave2-sweep.failing.test.ts:47` proves is a live **authority boundary** with an OPEN collision
  defect on the `stateful` lane (unescaped `:` in `${context}:${className}`). Merging kinds there
  erases a real authoring/drive distinction ON a security-sensitive, already-vulnerable seam — the
  wrong place to save a concept. So my earlier "merge procfacet→stateful" was wrong; corrected here.
- **The REAL redundancy was the ref WORD + the framing** — and that's the safe, high-value fix.

### Increment — unify the processor ref word `export` → `className` (DONE, green)

The processor ref was `{ source, export }` while a stateful `itx.workers.get` takes
`{ source, className }` — two words for "which exported class to instantiate." Unified on
`className` (matches `workers.get` + apps/os). Renamed at every site: `Itx.enableProcessor` +
`StreamDurableObject.enableProcessor` signatures, `FacetProcessorEntry.ref`, `ProcessorPolicy`, the
capability-provided event's zod schema, `FacetIdentity`, and `runner-entry.ts`
(`identity.className ?? "default"`, rebuilt into `generated/processor-runner.ts`). `enableProcessor`
docstrings now state the relationship plainly: **enabling a processor == loading a class as a facet
(the same `{source, className}` ref `workers.get` takes) + appending the `itx.processors.<slug>`
mount the commit pump drives** — no second "enablement" concept. The one difference from
`workers.get({source, className})`: a processor's class extends `StreamProcessor` (behind the
`runner.js` adapter) and is commit-driven; a `workers.get` class is a raw DO you call directly.

Concrete evidence this removed real inconsistency: the live proofs already used `className` for
`workers.get` (hibernate/restore/livestate targets) but `export` for `enableProcessor`
(userfacet/ephemeral/livestate:162). Now ALL use one word — updated those three proofs too.

No regression: typecheck clean; suite **279 passed / 37 xf / 2 skip / 31 todo** (identical to the
post-undo baseline — the userspace-processor path is Worker-Loader-only, so it's the live proofs, not
the harness, that exercise the rename end to end).

### Live proof (deploy `c4bd6cff`) — the rename works end to end, no regression

Deployed and ran the proofs that exercise the `className` rename through the real Worker Loader:

- **`prove_userfacet.mjs` — ALL PASS.** A userspace processor enabled with `{ source, className:
"UserTally" }` loads through the loader and reduces side-by-side with the built-in `tally`. This is
  the full thread proven live: `enableProcessor` → provide (event schema `className`) →
  `#facetEntries` (`policy.className`) → configure (`FacetIdentity.className`) → runner
  (`identity.className` export lookup).
- **`prove_ephemeral.mjs` — ALL PASS.** Second userspace path (`chunky`, `className: "Chunky"`).
- **`prove_ephemeralflood.mjs` — ALL PASS, perf HELD.** 2000-event flood: p50 **213ms** / p95 365ms,
  **5168 ev/s**, **40 invocations for 2000 events** (50× batching), zero dup / zero loss / zero pulls.
  Baseline was 5479 ev/s / p50 203ms / 40 invocations — within noise. No throughput/latency/frames
  regression.
- **`prove_slack.mjs` — ALL PASS.** The mounted-capability direct-call lane (dotted spelling, alias
  mount `itx.notify`, `boundaryArgs`, revoke/default-deny) intact — delivery direction unchanged.

## Where this landed (honest summary of the collapse)

Jonas' "enableProcessor is dumb" was right, and the fix is now in: enabling a processor is spelled and
documented as **loading a class as a facet (the same `{source, className}` ref `itx.workers.get`
takes) + appending the one mount the commit pump drives** — no separate "enablement" vocabulary, one
ref word across the whole surface. What I deliberately did NOT do, with evidence: merge the loader
kinds. They are not redundant (different module sets: stateless-no-SDK / SDK+runner-adapter /
raw-DO-direct) and the kind is a cacheKey **authority-boundary** namespace with an OPEN collision
defect on the `stateful` lane (`wave2-sweep.failing.test.ts`). Reducing that concept would mean first
fixing a security defect (escape/length-prefix the owner seam) — a separate, security-touching effort
outside "reduce complexity." The clean, safe simplification has been made; the rest is honestly
documented, not papered over.

## MAXIMAL CONSOLIDATION (Jonas: "do it all") — the plan

Jonas asked for the maximum reduction without losing capabilities. Target: 3 nouns
(`itx.workers.get({type})`, `itx.facets.get(slug)`, `itx.subscribe(...)`), one source producer
primitive (inline/repo/callback sugar over one resolve+cache path), one subscribe verb. Deletions:
`itx.processors.*` namespace, `enableProcessor` verb, ProcessorPolicy-as-separate-field, `#facetEntries`,
the second commit loop, one per-commit derivation, source variant branching, `#facet`+`#statefulFacet`
→ one `#durableFacet`, loader kinds 3→2 (after the wave2 owner-collision fix), `className?` polymorphism

- dead `type` field. Three delivery lanes (facet-reduce / connected-fastpath / absent-forwarder) LIFTED
  verbatim — no capability lost, hot path untouched, perf-gated by prove_ephemeralflood.

Order: (1) loader mirror + workers.run + one-producer source; (2) #durableFacet + collision fix + kinds
3→2; (3) the fold (.processors → subscribe, delete enableProcessor). Each committed + typecheck + suite

- live-proven.

### Inc 1a DONE — `itx.workers.get` discriminated union + `itx.workers.run` (mirror apps/os)

`workers.get(ref)` now takes the apps/os `DynamicWorkerRef` shape: `{type:"stateless", source, props?}`
→ a `{run, fetch}` handle, `{type:"stateful", source, className}` → the facet method proxy. The
`className`-presence polymorphism is gone (discriminate on `type`); the previously-dead `type` field is
revived with meaning; `props` threads to `getEntrypoint(undefined, {props})` (apps/os parity). Added
`itx.workers.run(source, ...args)` — one-hop sugar for `get({type:"stateless"}).run(...)` (the runScript
composition: `loadModules` → `confinedWorker` kind "code" → `.run`, three labeled lines, no helper
functions). Extracted `statelessHandle()` so the stateless primitive has a name. Updated callers (the
proofs already used `type` in several places — this aligns code with them; converted two `.run()` sites
to `workers.run`). Typecheck clean; suite 279 passed / 37 xf / 2 skip / 31 todo (identical baseline).

### Inc 1b DONE — one-producer source (`resolveSource`) + `inline` sugar

The three load sites each inlined `asModules(await invoke(source), what)` — built-ins' stateless
worker, `#facet` (processor), `#statefulFacet` (stateful worker). Extracted the ONE
`resolveSource(invoke, source, what)` in agent-runtime.ts and routed all three through it. The
realisation that made this small: **source is ALREADY a producer** — every existing proof uses
`source: "itx.kv.get('src/x.js')"`, which is literally a callback expression that fetches the code.
So there was never a per-variant fan-out to collapse; the consolidation is one resolve path + naming
it. Added the ONE shape that isn't a producer expression: `{ type:"inline", files }` (apps/os
`WorkerFileSource` inline) — code handed over literally, no `kv.put` first. `type:"repo"` is
deliberately NOT a branch: it's sugar that compiles to a producer expression (`itx.repo.get(...)`),
honouring Jonas' "repo compiles to the callback variant." Deleted the stale `workers.get({source,
className?})` docstring. Typecheck clean; suite 279 passed / 37 xf / 2 skip / 31 todo (identical).

### Inc 2 DONE — `#durableFacet` merge + `facetLoaderOwner` collision fix + loader kinds 3→2

Three moves, one increment:

- **`#durableFacet`** — `#facet`'s userspace branch and `#statefulFacet` were near-duplicate
  `resolveSource → hashSource → confinedWorker → versionedFacet` skeletons (the S5 divergent-dup
  pair). Merged into ONE `#durableFacet({ source, role, discriminator, loadedClassName, facetName,
markerKey, what })`. The two roles ("processor" = StreamProcessor behind the `runner.js` adapter
  - SDK, commit-driven; "stateful" = a raw DO class, called) now differ in exactly ONE place — the
    mainModule + whether the SDK/adapter ride the module set.
- **`facetLoaderOwner(context, discriminator)`** closes the wave2 owner-collision defect: the naive
  `${context}:${disc}` aliased across a different `:` split (a documented silent cross-context
  authority transfer). Length-prefixing the context makes the split unambiguous. The
  `wave2-sweep` test flips from `test.fails` → passing (**36 xf, was 37**) — the fix is proven by
  its own test.
- **Loader kinds 3→2** (`code | facet`). `procfacet`+`stateful` were only ever different module
  sets + a cacheKey prefix; with the collision fixed they merge safely. `confinedWorker` no longer
  auto-injects `processor.js` by kind — the CALLER includes it only for the processor role, so a
  raw stateful DO isolate now DROPS the ~330KB SDK it never used (pure win).

Typecheck clean; suite **280 passed / 36 xf / 2 skip / 31 todo**. Live proof next.
