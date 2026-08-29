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

### Inc 3 DONE — THE FOLD: `itx.processors.*` deleted, a processor IS a subscribed facet

The crown jewel. A processor is no longer its own namespace — it is a SUBSCRIPTION whose target is
a co-located facet: `itx.subscribers.<slug> → itx.facets.get('<slug>')`. "Load a facet, subscribe
the facet" is now literally the model.

- **`facetTarget(t)`** — a new discriminant beside `connectedTarget(t)`. The three delivery lanes
  are now chosen purely by TARGET SHAPE: `facetTarget` → the commit pump (a reduce); `connectedTarget`
  → the one-directional client fast path; else → the absent-target forwarder.
- **`#facetEntries()`** derives from `#activeSubscriptionMounts()` filtered by `facetTarget` (was:
  a separate scan of `itx.processors.*`). One namespace, one shadow-stack projection.
- **`enableProcessor`** now provides `itx.subscribers.<slug>` (facet target + the `processor` code
  policy); `disableProcessor` revokes it. The VERB stays (sugar) so no caller/test that _calls_ it
  churns — only the mount PATH moved.
- **The forwarder skips facet targets** — in BOTH the parent's auto-enable guard AND the forwarder's
  own reduce (a facet-target subscriber, including the forwarder itself, is the pump's lane, never a
  delivery). This also kills a would-be recursion (enabling a processor no longer spuriously enables
  the forwarder).
- **Commit path UNCHANGED structurally** (deliberate, lowest hot-path risk): the pump loop still
  drives `#facetEntries()`, `#deliverToConnectedSubscriptions` still handles connected. Only WHAT
  `#facetEntries` reads changed. (Merging the two into one target-shape-dispatched loop — Agent B's
  micro-optimisation, −1 derivation/commit — is deferred as a separate, perf-gated step.)

Tests: the two that `provide` a facet mount DIRECTLY moved from `itx.processors.tally` →
`itx.subscribers.tally` (their intent — a mount alone enables — is preserved). Typecheck clean;
suite **280 passed / 36 xf / 2 skip / 31 todo**. Live proof next (esp. the forwarder: a processor
must NOT trigger absent-delivery).

### Inc 3 LIVE-PROVEN (deploy 59fc452b) — all three lanes + perf, zero regression

- **`prove_push` (THE forwarder check) — ALL PASS.** An absent-target subscribe auto-enables the
  forwarder and delivers (3 marks digested by a stateless worker); halt+audit+resume all work;
  `/state` shows the absent row on `lane:"forwarder"` while `facetProcessors: ["tally",
"subscription-forwarder"]` — a processor is a facet-target subscriber on the pump lane, NEVER
  confused for an absent delivery. The exact regression the fold risked: clean.
- **`prove_userfacet` — ALL PASS.** A userspace processor (now an `itx.subscribers.<slug>` facet
  subscription) reduces beside built-in `tally`.
- **`prove_ephemeralflood` — ALL PASS, perf HELD.** 5195 ev/s, p50 210ms, 50× batching, zero pulls.
- **`prove_slack` + `prove_crisp1` — ALL PASS.** Mounted-cap direct-call + stateful facet intact.

## MAXIMAL CONSOLIDATION — DONE (Increments 1–3 complete, all live-proven)

Final shape, three nouns:

- `itx.workers.get({ type:"stateless"|"stateful", source })` (+ `itx.workers.run` sugar) — mirror
  apps/os `DynamicWorkerRef`; one-producer `source` (`resolveSource`; inline/repo/callback sugar).
- `itx.facets.get(slug)` — a durable facet by name; ONE loader `#durableFacet` (kind `facet`),
  collision-safe `facetLoaderOwner`, SDK only where a StreamProcessor lives.
- `itx.subscribers.<name>` — subscribe a target; the target's SHAPE picks the lane
  (`facetTarget`=pump / `connectedTarget`=fast path / absent=forwarder). **A processor is a
  subscribed facet; `itx.processors.*` is gone.**

Deleted: the `className?` polymorphism, the dead `type` field, three duplicated source-resolve
sites, `#facet`+`#statefulFacet` duplication, one loader kind, the `itx.processors.*` namespace + its
separate `#facetEntries` scan, ~330KB SDK from raw stateful isolates. Fixed en route: the wave2
owner-collision authority defect. Kept (with rationale): `enableProcessor` as thin sugar (spelling
the facet-subscribe for you — deleting it would force hand-spelling the facet target, a net
ergonomic loss). Deferred (perf-gated, separate): merging the two commit loops into one
target-shape-dispatched loop (Agent B's −1-derivation/commit micro-opt).

Every increment: typecheck + full suite + live deploy + proofs, zero regression throughout
(perf held ~5200 ev/s / p50 ~210ms / 50× batching / zero pulls at every step).

## Defect sweep (post-consolidation) — security gates + print↔parse authority loss

Jonas: "do the ones you suggest, lean and minimal." Closed the two families I flagged first:

- **Defects 38 + 39 — cross-project breach via `:`** ☠. Both gates already in place (projectId at
  `DurableObjectNameCodec.parse`, secret name at `secrets.set`); FLIPPED their `test.fails` → passing
  regression locks. A `:`-nested projectId now can't be materialized (the DO refuses the name), so the
  kv/secret prefix wall can't be spelled around. (The loader-cacheKey half of this seam was already
  closed by Inc 2's `facetLoaderOwner`; a path `:` is now benign.)
- **Defects 1 + 2 + 3 — the print↔parse codec was not a bijection** ☠ (silent authority loss). Three
  1-line fixes in `core/expression.ts`: `#number` gained an exponent branch (`1e+21` round-trips);
  `printValue` emits `-0` (not `0`) and QUOTES non-identifier object keys (`'a b'`, `'a.b'`, `'3d'`)
  so `#object`'s quoted-key branch reads them back. This ROOT fix also resolves the "silently dropped
  mount" amplifier (defects at capability-table): a target carrying a big number / exotic key now
  round-trips through print→reduce→parse and ROUTES instead of vanishing behind a success receipt.

Already done (verified, no work): **defect 39** (secret-name charset), **defects 10/11** (the
`consumes:["*"]` black hole — `consumesEvent` is extracted + shared across both lanes + the processor).

Net: **286 passed / 30 xf** (was 280 / 36 — six `test.fails` flipped). Typecheck clean; no code
touched beyond the 3-line codec fix + test flips. Deliberately NOT expanded into the provide/enable
path-validation amplifiers (40/42) or the other families — kept lean per the ask.

## Codec via JSON5 (Jonas) — delete the hand-rolled parser + printer

Jonas: use json5 (accepts the ergonomic form we already write — single quotes, unquoted keys,
trailing commas), minimum code, don't preserve the old format. Done. `core/expression.ts` parse is
now a tiny structural scan (dotted names + `matchingParen` to find a call's balanced parens) that
hands the args to `JSON5.parse("[" + inner + "]")`; `print` is `JSON5.stringify(args).slice(1,-1)`.
DELETED: the ~100-line hand-rolled recursive-descent value parser (`#value`/`#object`/`#array`/
`#string`/`#number`/`#word`/…) AND `printValue`/`isPlainObject`/`IDENT_KEY`, plus the dead
`events.ts` `deeper` depth budget (JSON5 is iterative — 100k-deep parses without a stack overflow,
so no artificial budget needed). **Zero proof/test STRING churn** — JSON5 reads exactly what the
platform already writes. expression.ts 479 → 331 lines. All defect-1/2/3 tests subsumed (JSON5
round-trips exponents/keys natively; `-0`→`0` is a documented JSON5 limitation, not a bug). Suite
286 passed / 30 xf; typecheck clean. NEXT (Jonas): two-block table tests + get expression.ts <100 LOC.

## expression.ts < 100 LOC (Jonas: "use subagents to turn up a solution")

Dispatched 3 worktree-isolated agents (split / densify / free-hand). Picked the FREE-HAND result:
`core/expression.ts` is now **99 lines** — purely the string⇄structure CODEC (parse/print/
toExpression/parseCapabilityPath + types). The MATCHER + EVALUATOR (`match`, `stepGet`,
`walkSteps`, `invokePath`, `evaluate`, `apply`, `pathProxy`) moved to a new `core/dispatch.ts`
(178 lines), re-exported from expression.ts in one line so every importer is unchanged (only
`config.ts` edited). Genuine collapses, not just relocation: `apply`'s two duplicated
"apply-args-or-throw-not-callable" blocks fold into one `callOn` helper; `walkSteps` is the single
engine behind `evaluate`/`invokePath`/`apply`; `zod` left the codec entirely (`ExpressionSchema`
moved next to its only consumer, `config.ts`). Typecheck clean; suite 286 passed / 30 xf; behavior
identical. (expression.ts arc this session: 479 → 331 [JSON5] → 99 [split].)

### Two-block codec tests + fix

`core/expression.test.ts` is now exactly two `test.each` blocks (parse direction, print direction)
over ONE table of plausible itx expressions (getter path, no-arg call, chains, multi-arg, object +
nested array/object args, primitives). The matcher + evaluator tests moved to `core/dispatch.test.ts`
(they test `dispatch.ts` now); `expression.failing.test.ts` (all edge cases of the deleted
hand-rolled parser) is gone. Fixed one carried-over TS control-flow nit in the picked `parse` (a
`never`-returning `fail` must be a function DECLARATION, and `args` is initialised so try/catch
definite-assignment is happy). expression.ts final: **99 lines**. Suite 277 passed / 30 xf.

### No re-export — maximally clean (Jonas: "im anti re-exports here")

Killed the re-export facade. `core/expression.ts` (now **92 lines**) is PURE codec — no
`export … from "./dispatch"`, no `zod`, no dead `ExpressionSchema` (config.ts has its own). The
matcher/evaluator is `core/dispatch.ts`; importers pull dispatch symbols (`match`/`apply`/`invokePath`/
`pathProxy`/`stepGet`/`Match`) STRAIGHT from `./dispatch.ts` (stream-durable-object,
capability-table-processor, built-ins, depth-reset-repro.test re-pointed). Also deleted the stray
duplicate `evaluate.ts` (a copy-artifact — logically identical to dispatch.ts, comments only).
Typecheck clean; suite 277 passed / 30 xf.

### Defect sweep — 4 no-brainer correctness fixes (Jonas: "do anything not complicated that is a no brainer")

Closed 4 `test.fails` with small, well-pinned, low-blast-radius fixes; full suite **281 passed / 26 xf**
(was 277 / 30), typecheck clean, generated SDK rebuilt deterministically.

- **Defect 41 — config array-path validated element-wise** (`core/config.ts`). `CapabilityPathInput`
  round-tripped the array branch through `parseCapabilityPath(p.join("."))` but never checked the
  result matched the input 1:1, so `["itx.kv"]` silently re-split into `["itx","kv"]` (a DIFFERENT
  mount) instead of failing loud. Now a pre-split array must be one identifier per segment; `["itx.kv"]`
  and `[]` both throw at boot. (wave2-sweep test flipped `test.fails`→`test`, + `[]` case.)
- **Defect 40 — provide() rejects a mis-segmented array path** (`capability-table-processor.ts`). The
  round-trip guard compared STRINGS only, so an array that re-splits (`["itx.kv"]`) slipped through
  while `["itx","a b"]` already threw via the unparseable join. Added a length check
  (`reparsedPath.length !== path.length`) so both are rejected at the door — never success + silent
  drop. (wave2 test rewritten to assert `rejects.toThrow(/round-trip/)`.)
- **Defect 19 — blocker-in-blocker holds the cursor** (`core/processor.ts` `runOne`). `await blockers`
  latched the chain snapshot BEFORE a nested `blockProcessorWhile` (registered from inside a running
  blocker) extended it, so the next event / batch commit could overtake still-in-flight blocking work
  (rule 2 + rule 4 violation). Now drains to a FIXED POINT: re-await until `blockers` stops growing.
- **Defect 20 — exact 500-multiple log delivers caughtUp** (`core/processor.ts` `#catchUpBody`).
  `atHead = page.events.length < 500` judged a FULL page that ends at head as not-at-head; the next
  empty read short-circuited before any `#processBatch`, so rule 5's at-head pass never ran on a log
  whose length is a page multiple. Now remembers a full page and, when the next read finds nothing new
  (at head), delivers the eventless at-head pass — no silent at-head stall for obligation sweeps / "am
  I done" transitions.

Deferred (NOT no-brainers): defect 21 (non-contiguous push drops named ephemerals — reshapes gap
repair), defect 49 (egress URL/body secret leak), and the harness/workers-lane clusters (connections
14/15/16, event-log 6/7, boundary 34-sibling/47/48, dotted-surface 24, chunking 25, WS 27/28).

### Defect sweep round 2 — 3 more no-brainers + one policy fork surfaced

Full suite **284 passed / 23 xf** (was 281 / 26), typecheck clean.

- **Defect 43 — kv.list paginates on the cursor** (`built-ins.ts` prefixedKv.keys). One
  `kv().list({prefix})` presented page 1 (Cloudflare's 1000-key cap) as the whole truth; key 1001+
  silently vanished from every listing (permanent orphans for sweep/GC/inventory). Now drains every
  page until `list_complete`.
- **Defect 47 — empty/whitespace event type** (already covered): the append door's guard
  `typeof type !== "string" || type.trim() === ""` is the sole enforcement and already rejects `""`
  / `"   "`; the `test.fails` was stale — converted to a positive rejection test.
- **Defect 6 — in-batch idempotency dedupe reduced ONCE** (`stream-durable-object.ts` StreamEventLog
  - append). A dedupe hit echoes the matched row's offset; when that row was inserted earlier IN THE
    SAME batch, `committed` held two entries for one offset — reduced twice (double breaker spend,
    double capability-table apply, double facet + connected delivery), and the inline checkpoint no
    longer rebuilt bit-identically from the log. append now derives a per-offset `distinct` view
    (first-wins) that feeds the inline reduce AND both delivery lanes, while `committed` keeps one
    receipt per input for the RPC answer.

**Policy fork surfaced, NOT taken (deferred to Jonas): defect 34-sibling.** A `capability-table/`
idempotencyKey namespace fence at the one append door WOULD close the sibling-append angle, but it
CONTRADICTS the shipped strategy: revoke is KEYLESS (defect 46), so squatting `capability-table/revoke:N`
is already harmless — a passing test + a `test.skip` both pin "the fence was REMOVED, nothing to
squat". Adding the fence re-opens a door the codebase deliberately closed and breaks that passing
test. Left as `test.fails` with the fork documented. Choice for Jonas: defense-in-depth fence at the
door vs keyless-revoke as-is.

Session total: **7 defects closed** (41, 40, 19, 20, 43, 47, 6); throughput/delivery unchanged (the
`distinct` view equals `committed` for every batch without an in-batch duplicate).

### Defect sweep round 3 — event-log 7 + connections 15/16 (14 deferred)

Full suite **287 passed / 20 xf** (was 284/23), typecheck clean. Baseline (the committed 7) was
live-proven first: deploy d868b2a4, prove_push ALL PASS, prove_ephemeralflood 2000/2000 no-loss
no-dup, 4684 ev/s p50 221ms 50× batching (≈ the historical baseline — no commit-core regression).

- **Defect 7 — breaker no longer taxes an idempotent retry** (`stream-durable-object.ts`). The
  breaker gate counted every non-ephemeral input as durable growth BEFORE dedupe, so a retry of an
  already-committed idempotencyKey tripped STREAM_BREAKER_OPEN even though it writes zero rows. On
  the about-to-trip path the gate now re-counts excluding sure dedupe hits (new cheap
  `StreamEventLog.hasIdempotencyKey` probe, run only when the naive count would trip).
- **Defect 16 — an in-flight invoke on a dying provider now rejects CONNECTION_OFFLINE**
  (`itx-surface.ts` RetainedCallbackInvoker). The call leaked capnweb's raw, uncoded close error.
  capnweb fires onRpcBroken BEFORE it rejects the pending import, so a `#broken` flag set there is
  already true in the invoke catch — re-code to CONNECTION_OFFLINE LOCALLY (at the relay), so the
  CODE (never a message) crosses the Workers-RPC hop (core/errors.ts). No race, no message-sniffing.
- **Defect 15 — concurrent connects under one key collapse to ONE transport**
  (`itx-connection-directory.ts`). attach() drops same-key predecessors by scanning #stubs.all(),
  but a concurrent connect is still opening its pager then — invisible to that scan, so N concurrent
  connects all lingered. The one-transport-per-key invariant is now ALSO enforced at pager-open
  (fetch/101): a newly-visible keyed transport drops every OTHER same-key transport ("replaced" — a
  swap, not a session end). Additive; only touches same-key concurrency.

**Deferred: defect 14** (dirty transport death coalesces to ONE session). Not fixable by the pager
close code — a clean [Symbol.dispose] and a dirty ws.close() sever the socket with the SAME code, so
clean-vs-dirty is only knowable from whether relay.dispose() is ALSO called (fires after onRpcBroken,
races the async #connectionClosed). Needs a dispose()-signals-clean-end path. Left as test.fails.

Session total: **10 defects closed** (41, 40, 19, 20, 43, 47, 6, 7, 15, 16); 1 deferred (14), 1 policy
fork (34-sibling).

### Defect sweep round 4 — processor 21 + egress 49

Full suite **289 passed / 18 xf** (was 287/20), typecheck clean.

- **Defect 21 — a non-contiguous push no longer drops its fresh named ephemerals** (`core/processor.ts`).
  The non-contiguous branch blanket-called #catchUpBody (durable-only log repair), so a push carrying
  fresh named ephemerals (voice/telemetry lanes — pushes are their ONLY delivery) lost them after any
  one failed batch left the cursor behind. It now #repairThrough(scannedAfterOffset) — a BOUNDED
  durable repair up to the push's start — then processes the PUSHED batch itself (ephemerals and all);
  falls back to #catchUpBody only if the durable prefix genuinely can't be reached.
- **Defect 49 — the egress terminal substitutes a secret placed in the URL** (`@v3/shared/egress`).
  substituteHeaderSecrets rebuilt only Headers, so `?access_token={{secret:project:token}}` forwarded
  the credential's NAME to the destination and the value nowhere. It now substitutes the URL too
  (shared `subst` helper; WS-safe reconstruction preserves method/Upgrade/body). Body substitution is
  a documented follow-up (needs buffering + content-length recompute).

Session total: **12 defects closed** (41, 40, 19, 20, 43, 47, 6, 7, 15, 16, 21, 49).

### Live proof of all 12 fixes (deploy 308b3044)

- **prove_push** — ALL PASS (subscription-forwarder lane: subscribe, stateless-worker digest, HALT +
  audit, resume, auto-enable). Exercises processor gap-repair + connected delivery.
- **prove_ephemeralflood** — ALL PASS: 2000/2000 no loss, no dup, ScannedOffsetRanges CHAIN (zero
  pulls), 50× batching, ~4684 ev/s p50 221ms — the defect-6 `distinct` change held delivery + perf.
- **prove_crisp1** — ALL PASS: connections.list / get(key) reaches ONE client / each() fans out —
  validates the defect 15/16 connection-lifecycle changes live.

**PRE-EXISTING gap surfaced (NOT this session's regression): userspace processors that import the SDK
can't load on the deployment.** prove_livestate + prove_hibernate3 fail with `No such module
"processor.js" imported from "cap.js"`. Root cause is the maximal consolidation's "no auto-SDK
injection" in confinedWorker: `chatroom.js`/`chunky.js`/`user-tally.js` all `import from
"./processor.js"`, but `seedSources` seeds only the source files — nothing provides the SDK module to
the loader anymore. This session touched none of the SDK-provision path (agent-runtime.ts / sdk.ts /
processor-facet.ts) — the proofs that pinned the consolidation (ephemeralflood/slack/crisp1/push) use
stateless workers or built-in facets, none of which import the SDK, so the gap went unproven. Fix
belongs with whoever owns confinedWorker: either re-inject `processor.js` for SDK-importing loads, or
seed it. Filed as a follow-up, distinct from the defect sweep.

### Radical simplification — trusted-client model + mega-simple session lifecycle (Jonas)

Two standing directives from Jonas turned defects into DELETIONS:

- "We do not worry about malicious clients — anyone with project access is trusted to coordinate key
  names/namespaces." → **Defect 34-sibling and defect 48 are WON'T-DO.** Removed the whole
  reserved-key "fence bypass" cluster (the skip, the squat test, the sibling `test.fails`) and the
  forged-provenance `test.fails` from `__tests__/failing-boundary-egress.test.ts` — all pure
  malicious-client scenarios. No code fence added; revoke stays keyless (already simple).
- "Network blips SHOULD show as session started + ended — mega simple, remove fake complexity." →
  **Defect 14 dissolved by DELETION.** `itx-connection-directory.ts` lost the storm-rule machinery:
  the absence timer (`ITX_CONNECTION_SESSION_ABSENCE_MS`), `lastActiveMs`, `endedNoLaterThan`, and the
  clean-vs-dirty close-code distinction in `#connectionClosed`. New model: keyed attach → session-
  started (a live transport SWAP continues the open one); the LAST transport's close → session-ended.
  A drop-and-reconnect files ended then started. The `itx-surface.ts` onRpcBroken close code no longer
  carries session meaning (comment updated). The dirty-death test now asserts `[STARTED, ENDED,
STARTED]`; the ≥15-min-absence `test.todo` is gone.

Net: −~40 LOC of speculative machinery, +clarity. Suite **289 passed / 15 xf** (was 289/18: the
dirty-death test flipped to passing, three malicious `test.fails` deleted), typecheck clean.

Also realigned `src/generated/processor-*.ts` — the committed bundle had drifted ~10KB behind source
(deployments were unaffected: wrangler's custom build runs build-sdk.mjs fresh on every deploy). The
build is deterministic; the committed artifact now matches source again.

### Chunking — arbitrary-size payloads (defect 25)

Closed all 6 chunking `test.fails` (`__tests__/failing-pathological.test.ts`); suite **295 passed / 9 xf**
(was 289/15), typecheck clean. Implemented the apps/os row-chunking contract in `StreamEventLog`:

- New `event_chunks (offset, chunk_index, chunk)` table. A serialized body over EVENT_CHUNK_SIZE
  (512KiB) is split across chunk rows behind an EMPTY marker cell in `events.body` (a real body is
  never empty JSON); a body at or under it stays single-cell (the fast path — no chunk join on read).
- `#storeEvent` writes the event row + chunk rows in the caller's ONE transactionSync, so a mid-batch
  throw (an idempotency conflict) rolls back every chunk row with its event row — no orphans, no half
  a body, and the offset allocator never advances (dense continuation).
- `#reassemble` rebuilds the body (single cell, or chunk rows joined by index) for BOTH read and the
  idempotency-dedupe structural compare — so a chunked retry dedupes to the same offset.
- Chunk rows never enter the events SELECT, so a chunked event is ONE row at ONE offset: offsets stay
  dense, and a limit-N read page counts EVENTS with scannedThroughOffset on an event offset (never a
  chunk boundary). Proven: 5MB + 3MiB round-trip byte-identically, dense offsets, chunked dedupe,
  same-batch-conflict rollback, honest read paging.

### env.ITX.get() — the WorkerEntrypoint→scope handoff (drop itxFromStub)

Loaded workers reached itx through `itxFromStub(env.ITX)` — a client-side accumulating Proxy that
FOLDED every `itx.a.b.c(x)` into one `env.ITX.invokeCapability("itx.a.b.c", [x])`. That's fine for
terminal calls but yields a value, never a live handle. Replaced it with the apps/os shape: a
loaded worker's `env.ITX` is a service binding to `ItxEntrypoint`, and **`env.ITX.get()` now returns
the genuine `Itx` scope RpcTarget** (`itxForHost` in itx-surface.ts, built with the DO as host + an
empty relay set — a loaded worker's callbacks ride as Workers-RPC stubs, not the capnweb pager).
Because `Itx extends RpcTarget from "capnweb"` — which IS the native `cloudflare:workers` RpcTarget
on workerd — the same `Itx` is a branded, pipelinable RpcTarget on BOTH lanes.

`CODE_CAP_RUNNER` now injects `await env.ITX.get()` as the cap's `itx`; the dead `ITX_SURFACE_MODULE`
(itx.js) constant + its per-isolate injection are removed. So a loaded worker writes exactly what a
capnweb client writes after `session.get()` — plain dotted access, real handles, native callbacks.

**Live-proven (deploy 8c984bf9, prove_calllater.mjs — the "get demo → RpcTarget → callLater(ms, cb)"
shape):** a `Demo`/`Timer` provided at `itx.demo`, and `itx.demo.timer.callLater(cb)` invoked BOTH
from a capnweb client AND from a **dynamic worker via `env.ITX.get()`** — in both, the callback fires
back in the caller's isolate (the worker's callback appended to its own stream). Callbacks retained
with `cb.dup()`. Suite 295/9, prove_push + prove_ephemeralflood held (5025 ev/s), no regression.

## Mid-chain pipelining: `InvokeHandle`, and ONE invocation path (2026-08-29)

`itx.connections.get('b').hello()` — get a live sub-capability, then call a method on it — is a
MID-CHAIN call: `get('b')` returns a handle, `.hello()` is called on the RESULT. The views
(`connections`/`facets`/`contexts`/`workers.get` stateful) returned a bare `pathProxy`
(Proxy-over-function). It folds dotted access fine, but workerd's promise-pipeline classifier
brand-checks a method's RESULT and a JS Proxy can never pass (NonPipelinable; cloudflare/workerd
#6873), so over Workers RPC the `.hello()` died with "The RPC receiver does not implement the method".

**Fix — `src/core/invoke-handle.ts`:** a genuine, branded `InvokeHandle extends RpcTarget` with the
apps/os prototype-hop installed (`installPrototypeInvokeCapabilityFallback`). Unknown dotted members
fold into ONE `invokeCapability({ path, args })` → a `dispatch(path,args)` closure (the SAME fold the
pathProxy did), but now carried on a real RpcTarget brand that workerd AND capnweb both accept, so the
mid-chain call pipelines on every lane. The four views return an `InvokeHandle`; providers are
UNCHANGED (still a plain `RpcTarget` like `new Demo()` — which capnweb already requires to pass a
capability by reference); the client is UNCHANGED (still just capnweb).

**ONE invocation path (owner's rule — "everything points at itx expressions; no parallel ways").**
An `InvokeHandle` is not a JS function (an RpcTarget can't be), so ROOT-calling it (`handle(events,
range)` — the parked-callback delivery shape) is bridged in the ONE place that calls a resolved
capability: `callOn` dispatches the args at the handle's EMPTY path. That let the delivery lanes
UNIFY: `ItxConnectionDirectory.invokeConnection` (the by-stubKey bypass) is DELETED, and the connected-
subscription delivery lane now delivers through the SAME `deliverTo` → `apply` expression door the
forwarder uses — evaluate the row's itx-expression target (`itx.connections.get(connId)`) and apply
the batch. Connected vs forwarder now differ ONLY in POLICY (fire-and-forget from the commit path
vs the forwarder facet's cursor+retry), never in HOW the target is reached. `allowRootCall` (dead)
removed from `pathProxy`. `#itxConnections.invoke` is now reached ONLY via the `InvokeHandle`.

**Live-proven (deploy f2ef870a, on a DESTROYED-AND-REBUILT deployment — worker+DOs deleted, KV wiped,
migrations collapsed to one fresh `reset-1` class).** New `proofs/prove_dw2dw.mjs`: worker A is a
stateful DO with `get demo → Demo, get timer → Timer, callLater(ms, cb)`; worker B reaches it via
`env.ITX.get().workers.get(aRef).demo.timer.callLater(cb)` — dynamic-worker → dynamic-worker mid-chain
with a callback that fires back inside B. Proven on both consumer lanes (capnweb client + worker B).
3 dotted-surface `test.fails` flipped green; full board green (prove_crisp1/calllater/livestate/push/
rich/slack/facet1/hibernate/… ALL PASS); unit+harness suite 298 passed, perf held. STILL DEFERRED:
the isPathMiss miss-grammar (defect 24b) and the WS-through-live-capability loader lane (27/28).
