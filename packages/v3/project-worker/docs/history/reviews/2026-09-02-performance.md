# Performance review — `packages/v3/project-worker`, 2026-09-02 (verified)

> Find → three-judge verify → synthesize. Five finders (latency, throughput, startup, memory/CPU,
> experiments) filed 20 findings; each was re-read against the tree by three judges who checked every
> `file:line`, re-derived or re-measured the gain, and voted do-now / menu / reject. 17 survived
> (2 do-now, 15 menu), 3 were rejected. This file supersedes the first synthesis at this path
> (`72378b0e5`). Tree: `wip/kernel-wayfinder-2026-07-30` @ `4af9b3f76`, working tree clean; every
> line number below is against that tree. Three no-brainers from the first pass are ALREADY LANDED in
> `72378b0e5` and are marked so; nothing under `src/` was changed by this pass.
>
> **Machine caveat, once for the whole file.** Every microsecond and millisecond below was measured on
> one Apple M-series laptop: pure-module benches in Node 24 (`scratchpad/bench.ts`, `bench.mts`,
> `bench.mjs`, `judge-bench.mjs`, `microtask.mts`, `mini.ts`, `t.mjs`), worker probes against local
> workerd through the vitest workers pool (`scratchpad/e2e-probe/{wire-sizes,amplification,followup}.probe.test.ts`),
> and one `pnpm e2e` run. None of it ran on Cloudflare's edge. Three node benches of the same hash
> disagreed 3–5× (see the table); treat every number as an order of magnitude and every dollar
> figure as a hypothesis until a production counter says otherwise.

---

## Summary (5 lines)

1. **The steady path is already fast and the fixtures are too small to show the taxes.** A built-in call is p50 0.3 ms round trip on local workerd, a durable append 0.41 ms, a 3-rule chain to a borrowed stub 0.39 ms; rewriting, printing, parsing and the rule scan are sub-microsecond at realistic rule counts. Every real cost found is **linear in bytes the e2e fixtures never carry** (the e2e fixtures are 0.3–1.8 KB; a bundled processor is hundreds of KB) or **per wake**, which no e2e runs long enough to feel.
2. **One structural fact drives half the menu: a processor's source text is parked in the core reduced state.** It is re-read, stringified three times and hashed per character on every facet push (~7 µs per KB per push, and — measured in workerd, contradicting the node microtask model — that CPU lands on the producer's append RTT: 0.54 → 10.6 ms with three 600 KB facets); it is re-written as ONE kv cell on every core change; and it hits SQLite's ~2 MB cell cap at 3–5 bundle-sized processors, after which **no rule, subscription or pause can be configured in that context** (reproduced by a judge).
3. **The most expensive thing per wake is what the wake fans out.** `stream/woken` is durable and unfiltered, so every default-subscribed processor gets a push (facet cold start + a checkpoint write for an event it never reduces) and every default live subscriber gets paged — which arms the 60 s quiet clock: a read-only probe on an idle context with one default processor buys ~70 s of billed, non-hibernating DO. ~15 source lines, but with a hard prerequisite (the cursor lane cannot re-arm itself — bugs-do-side #2) and 15 test files of shifted offsets: MENU, highest value.
4. **DO-NOW: one item open, three landed.** Open: reduce the core state into a local inside the commit transaction so a failed checkpoint write cannot leave a phantom subscription in memory that the loop then delivers to (correctness on the SQLITE_TOOBIG path, `stream.ts:358-372`, 3/3). Landed in `72378b0e5` and re-verified as done: the lent-stub relay no longer awaits call steps (capnweb pipelines them), the 372 KB SDK is injected only into isolates that import it, `LiveState.set` short-circuits on the identical object.
5. **Measurement beat first principles four times** (§ below): the fan-out's prefix DOES delay the append reply in workerd; the layering review's "source rides every delta" does not hold (the enable delta was 1,007 B); the throughput finder's "83 ms for 50 facets" measures loader lookup + facet RPC, not hashing; and the "10 commits/s ceiling at 50 × 300 KB processors" is unreachable because the cliff refuses the 4th such processor first. And the futures review's flag stands: **delivery has never been run at the 10,000-subrequest budget** that silently stopped apps/os — the first thing to measure.

---

## Measurements

Everything a finder or judge actually ran. "Node" = Node 24 on the laptop against the package's own
pure modules; "workerd" = local vitest workers pool on the same laptop. Unless a row says "judge
re-ran", the number is one finder's single run.

| What                                                                                        | Number                                                                                                                                           | How                                                                                                  | Feeds          |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | -------------- |
| Round trip, built-in call (`itx.whoami()`), dotted proxy; via `invoke([...])`               | p50 0.27 / 0.30 ms, p95 0.43 / 0.45 ms (n=150)                                                                                                   | workerd, `wire-sizes.probe` F, sequential                                                            | baseline       |
| Round trip, `itx.c.hello()` → 1 rule → warm borrowed stub; `itx.a.hello()` → 3-rule chain   | p50 0.41 / 0.39 ms                                                                                                                               | same                                                                                                 | baseline       |
| Round trip, `itx.append` durable / ephemeral (1 event); `itx.rewriteRules.list()`           | p50 0.41 / 0.27 ms; 0.27 ms                                                                                                                      | same                                                                                                 | baseline       |
| `itx.facets.get('core').snapshot()`, fresh context                                          | p50 0.28 ms                                                                                                                                      | same                                                                                                 | M1             |
| Wire bytes: `whoami` 146 B / 4 frames; `kv.get` via proxy 86 B; one 256 B ephemeral push    | 222 B / 4 frames (push 170 B); a 10 KB ephemeral push 10,471 B                                                                                   | workerd, `wire-sizes.probe` A, D                                                                     | context        |
| `enableProcessor(tally)` 0.7 KB source: row, core checkpoint, **live-state delta**          | 251 B, 1,223 B, **1,007 B**; a later unrelated `provide` delta 185 B                                                                             | workerd, `wire-sizes.probe` B                                                                        | M1, T2         |
| Core-checkpoint cliff, 600 KB sources                                                       | b1..b3 OK (snapshot 601 / 1,202 / 1,803 KB; 162 / 136 / 173 ms each); **b4 `SQLITE_TOOBIG`**; then `provide(expression)` FAILS, `append` OK      | workerd, `wire-sizes.probe` C                                                                        | M1, DO-NOW 1   |
| Amplification below the cliff: `provide(expression)` p50 for 0 / 1 / 3 × 600 KB sources     | 0.57 → 9.70 → 29.57 ms; **judge re-ran 0.59 → 9.67 → 29.73**                                                                                     | workerd, `amplification.probe` (30 provides after 5 warm-ups)                                        | M1             |
| Same, **plain durable `append` RTT** with those facets enabled (no `waitUntilProcessed`)    | 0.54 → 3.03 → 10.60 ms; judge re-ran 0.50 → 3.12 → 10.64                                                                                         | same                                                                                                 | L1, M1, §below |
| Facet call with a big memo: `facets.get('big').snapshot()` 600 KB vs `tally` 0.7 KB         | p50 1.63 vs 0.46 ms; `core` snapshot with one 600 KB row 4.21 ms; push path (`append → waitUntilProcessed`) 5.50 vs 4.25 ms                      | workerd, `followup.probe` 2                                                                          | L1, M1         |
| Phantom row after a failed checkpoint                                                       | log 5 rows, no b4; `subscriptions.list()` = [b1,b2,b3,b4]; core snapshot offset 16 vs durable head 11; `facets.get('b4').snapshot()` answers     | workerd, `followup.probe` 1                                                                          | DO-NOW 1       |
| Per-push facet-door CPU: 2× stringify compare / stringify+djb2 at 1.2 KB / 40 KB / 330 KB   | 1.9 / 26 / 285 µs and 7.9 / 237 / 2,029 µs (≈7 µs per KB of source per push)                                                                     | Node, `bench.ts` §3 on `e2e/support/sources.ts` + synthetic                                          | L1             |
| Same operation, other harnesses                                                             | djb2(400 KB) 2.33 ms, stringify(400 KB) 161 µs (`bench.mts` §5); 300 KiB compare+hash 1.93 ms (`bench.mjs`); judge: 0.64 ms                      | Node; **benches spread 3× at 300 KB**                                                                | L1             |
| Same, this pass's judge on `"x".repeat(kb)` (JIT-friendly string)                           | compare 1 / 28 / 279 µs; hash 5 / 66 / 394 µs at 1 / 40 / 330 KB — ~5× under the finders' figure on real JS                                      | Node, `judge-bench.mjs`                                                                              | L1             |
| WeakMap hit                                                                                 | 0.01 µs                                                                                                                                          | Node, `bench.ts` §3                                                                                  | L1             |
| Microtask order: does the fan-out's sync prefix delay the append reply?                     | Node model: no. **workerd: yes** — the append RTT row above grows ~3 ms per 600 KB facet                                                         | Node `microtask.mts` vs workerd `amplification.probe`                                                | L1, §below     |
| `Object.values(rules)` at R = 10 / 100 / 1000; the rule scan itself; `print(call)`          | 0.06 / 5.3 / 63 µs; scan 0.25 / 0.97 / 9 µs; ≥ 0.4 µs                                                                                            | Node, `bench.ts` §2                                                                                  | L4             |
| `LiveState.set(sameObject)` on a 50 KB state; `diff(a,a)`; one `JSON.parse(JSON.stringify)` | 312.5 µs; 312.5 µs; 133 µs (×2 sides)                                                                                                            | Node, `bench.mts` §4 — the cost the landed guard removes                                             | landed         |
| `LiveState.set` diff on a 2,000-key (89 KiB) state                                          | 1.45 ms per batch                                                                                                                                | Node, `bench.mjs`                                                                                    | T2             |
| `diff` with a 300 KB source in one row; `structuredClone` of that state                     | 556 µs; 50 µs                                                                                                                                    | Node                                                                                                 | M1             |
| 50 processors enabled: offsets consumed; fan-out to head; `whoami` mid-fan-out              | 1,379 offsets (~1,275 ephemeral deltas = M(M+1)/2); 83 ms (1.7 ms/facet); 27.7 ms vs 13 ms under a 200-stub fan-out                              | `pnpm e2e` push-delivery-throughput, 2026-09-03                                                      | T2, L1 (see §) |
| 200 live subscribers, warm fan-out of one append; one live-stub push                        | 17 ms; ~85 µs                                                                                                                                    | same e2e                                                                                             | baseline       |
| SDK bundle `processor.js`: size; cold compile + eval                                        | 381,061 chars (372.1 KiB; zod 303.1 + capnweb 59.4 + own 9.3); compile 3.2–3.6 ms + eval 2.2–2.7 ms; judge re-ran 4.4–5.0 + 1.7–2.4              | Node `vm.SourceTextModule`, 4 fresh contexts (`bench.mjs`); esbuild metafile on `src/sdk/index.ts`   | landed         |
| Eager compile of unreferenced modules in workerd                                            | CONFIRMED in source: the legacy module registry compiles every `source.modules` entry at isolate build; `new_module_registry` has no enable date | `workerd-api.c++:530-536`, `jsg/modules.c++:444-450`, `compatibility-date.capnp:514-516` @ dea490edc | landed         |
| Uploaded worker script                                                                      | 1,476.67 KiB (gzip 310.54); minified 1,082 KiB = SDK string 385.4 + zod 303.3 + demo 254.7 + capnweb 59.9 + own 47.1 + json5 31.3                | `wrangler deploy --dry-run --outdir`; esbuild metafile; judge re-bundled 1,108,339 B                 | W2, W3         |
| Generated modules on disk at HEAD                                                           | `processor-sdk.ts` 394,795 B; `demo-page.ts` 260,874 B (demo.html 254.4 KiB)                                                                     | `wc -c src/generated/*.ts`; `build-sdk.mjs` output                                                   | W2             |
| `zod/mini` build of the core's constructs; import cost                                      | 18,456 B minified (judge: 17,709 B); `import("zod")` 12 ms vs `zod/mini` 1.5 ms unbundled from disk                                              | Node, `mini.ts`, `t.mjs`                                                                             | W3             |
| Fetch lane, inline `workers.get({source})` in `x-itx-expression`                            | 648 B / 8 / 16 / 32 KB → HTTP 200; **64 KB and 128 KB → 431 "header too large"**                                                                 | workerd, `wire-sizes.probe` E                                                                        | T3             |
| `enableProcessor` calls in `e2e/`; test files naming `stream/woken`/`incarnation`           | 14 calls, 1 passes `consumes`; 15 test files                                                                                                     | `grep`                                                                                               | W1             |

**Where a measurement contradicted a first-principles claim:**

- **"The append reply escapes before the fan-out's heavy prefix" (first synthesis, from the node `microtask.mts` model).** Wrong in workerd. The `amplification.probe` measured the plain durable append RTT at 0.54 → 3.03 → 10.60 ms for 0 / 1 / 3 × 600 KB facets — ~3 ms per facet, the size of one facet door's kv read + three stringifies + djb2 over 600 KB. A `chat/message` append changes no core state (no checkpoint blob), so nothing else scales with the facets. The RPC reply is written by the KJ event loop only after V8's microtask queue drains, and the delivery closures' synchronous prefixes (`subscription-delivery.ts:145` → `#invokeFacet` up to `await loadConfinedWorker`, `iterate-context-durable-object.ts:449`) sit in that queue. L1 is therefore an append-latency item, not only a throughput item. Trust the workerd number; the node model modelled V8, not workerd.
- **Layering F5: the source "rides every live-state delta".** Measured: the enable delta for `tally` was 1,007 B and a later `provide` delta 185 B (`wire-sizes.probe` B). The diff emits `add /subscriptions/<name>` once; the amplification is the checkpoint WRITE (one kv cell, the whole state, `stream.ts:363-369`) and the JSON-normalizing diff, not the wire.
- **The throughput finder cited "83 ms for 50 facets, 1.7 ms/facet" as evidence for the hashing tax.** At 0.3–1.8 KB sources the hash is ~1 µs; that 1.7 ms is `LOADER.get` + `getDurableObjectClass` + `ctx.facets.get` + the awaited in-process RPC + the facet's checkpoint put — the cost `2026-09-02-workerd-idioms.md` F1 removes. The e2e cannot see hashing; only the node benches and the 600 KB probes can.
- **"A hard ceiling near 10 commits/s for a context with 50 realistic processors" (throughput filing).** Unreachable: the same source text is parked in the core reduced state and the checkpoint cell refuses the 4th ~600 KB processor (M1). The reachable worst case is 3–5 bundle-sized processors × ~2–3 ms ≈ 10 ms of DO CPU per commit, not 100 ms.
- **"1,275 ephemeral deltas burned at enable time" (T2).** Free: an ephemeral-only batch takes the fast path at `stream.ts:330-334` — no transaction, no row, no mark write. Offsets are the only thing consumed.
- **"The WeakMap hits 100 % on the push path" vs "it misses on every push" (two experiments judges).** The code decides: the row's target carries the spec (`iterate-context.ts:307`), so a push reaches `#invokeFacet` with `ref` = spec and `memo = spec` at `:441`; `loadConfinedWorker` then receives the row's own modules object (`built-ins.ts:298` forwards `spec.source` by reference) — the WeakMap HITS on pushes. On a bare-name call (`facets.get('big').snapshot()`) the memo is kv-fresh and it MISSES — which is why the experiments filing's part (b) (`hash(memo.source)`) is negative, see REJECTED.
- **Three node benches of "hash a 300 KB source" disagree 3–5× (0.39 / 0.64 / 1.93 / 2.3 ms).** Same laptop; the judge's `"x".repeat` string is JIT-friendly, the finders' real JS is not. The mechanism is per-character and linear; the constant is what is uncertain.
- **"IF workerd compiles unreferenced modules eagerly" (startup finder).** It does (source above), but module EVALUATION (zod's ~2 ms init) runs only on import, so a non-importer recovered compile only: ~4–5 ms, not 6–12. Landed anyway.
- **"~2.5 ms parse for the 255 KiB demo string" (W2).** A string literal is scanned, not parsed; a judge puts it under 1 ms.
- **"The first user append lands at 2, not 4" after an ephemeral `woken` (W1).** Wrong for the born case: `created`@1 still changes core state, so the core delta still fires. Only re-wakes shrink.
- **"A webhook wake pays the 60 s pin" (W1).** An append-driven wake materializes the default facets and arms the clock regardless; the pin saving is for wakes that land no durable event (reads, probes, pager closes, alarms).
- **M2's proposal as filed loses state.** `writeReduceCheckpoint(…, state !== stateBefore)` (`processor.ts:476`) compares against the state at the start of THIS batch; staged over 8 pages it can persist the cursor without the blob. Caught by a judge; corrected in M2.
- **Two sizes were undercounted 3–10×.** L2 "~15 lines, 2 files" → 30–60 lines across 4–8 files (the edge `IterateContext` holds no `env`, `iterate-context.ts:122-133`); W3 (a) "~6 lines" → 30–100 lines (`zod/mini` has no chained builders; `core-processor.ts:39-140` is written in them).

---

## DO-NOW

Decision = do-now from the judges. Each is ≲ 30 lines, one or two files, no new abstraction. Neither
changes what is delivered, to whom, or in what order; neither pins the DO.

- [ ] **1. Reduce the core state into a local inside the commit transaction; move the fields only after SQLite committed.**
      `src/stream/stream.ts:358-372` (the commit block), `:393-402` (`#reduceEventIntoCoreReducedState`),
      `:178` (the constructor's re-reduce caller). **Correctness, not speed** — filed here because the
      SQLITE_TOOBIG probe (M1) exposed it; it is SYNTHESIS bug 13, still without a red proof. Inside
      `transactionSync` (`:335`), `:359` assigns `this.#coreReducedState` per event, `:360` sets
      `#coreReducedThroughOffset`, `:362` sets `#coreReducedStateChangedAtCommit`, and only THEN
      `:363-369` `writeReduceCheckpoint` puts the whole state as ONE unchunked kv cell
      (`reduce-checkpoint.ts:59`). When that put throws (the ~2 MB cell cap the file's own header knows
      at `:51-52` — it chunks EVENT bodies for it, not the checkpoint), SQLite rolls the rows and the
      mark back, `append` rethrows before `:371-372`, and memory keeps the state the log rejected.
      Measured (`followup.probe` 1): after `b4` failed, `subscriptions.list()` showed b4, the core
      snapshot offset was 16 against a durable head of 11, the next append pushed to b4,
      `#invokeFacet` wrote `facet:b4` from the phantom row and `facets.get('b4').snapshot()` answered
      with reduced state — a facet fed from an event that never existed, until eviction; the stale
      flag also ships a ~600 KB phantom core delta on the next good commit (`:385`). The two marks at
      `:371-372` already follow the right rule; the comment at `:362` ("never inside the txn") applied
      it to the flag's publication but not to the state. The constructor's invariant comment at
      `:157-162` ("after any commit the two cannot disagree") is false for a failed one.

  ```ts
  let coreReducedState = this.#coreReducedState; // reduce into a LOCAL
  this.#storage.transactionSync(() => {
    … rows (:336-346) and `maxAssignedOffset` (:349) unchanged …
    for (const event of freshEvents)
      coreReducedState = this.#reduceEventIntoCoreReducedState(event, coreReducedState);
    writeReduceCheckpoint(this.#storage.kv, contract.slug,
      { reducerVersion: contract.version, reducedThroughOffset: nextOffset },
      coreReducedState, coreReducedState !== this.#coreReducedState);
  });
  // Memory moves only after SQLite committed — the two marks below already obey this rule.
  if (coreReducedState !== this.#coreReducedState) this.#coreReducedStateChangedAtCommit = true;
  this.#coreReducedState = coreReducedState;
  this.#coreReducedThroughOffset = nextOffset;
  this.#highestAssignedOffset = this.#highestDurableOffset = nextOffset;
  ```

  `#reduceEventIntoCoreReducedState(event, state): CoreState` returns `reduce(...) ?? state` (the
  `catch` returns `state`); the constructor caller becomes
  `this.#coreReducedState = this.#reduceEventIntoCoreReducedState(event, this.#coreReducedState)`;
  move `#coreLiveState ??=` (`:353-357`) out of the transaction with the rest (it seeds from the
  pre-batch state either way). ~12–15 lines, one file. Pin it with one workers-test reusing the
  probe's recipe (four ~600 KB `enableProcessor` sources; the fourth throws) asserting
  `subscriptions.list()` and `facets.get('core').snapshot().offset` equal the durable head — no
  mock of `kv.put` needed. Gain: none on the green path; removes a memory/log divergence that
  persists until eviction and causes deliveries to, and materialization of, a facet the log never
  enabled. It is the precondition for M1's cliff being a clean refusal instead of silent
  corruption. **At-least-once: n/a — nothing lost, nothing duplicated; a delivery that should never
  have happened stops happening.** 3/3 do-now.

- [x] **2. Un-await the call steps in the lent-stub relay — landed in `72378b0e5`.**
      `src/context/rpc-stub-relay.ts:62-80`: no `await` inside the loop, one `return await value` at
      `:80`, a four-line comment at `:63-66`. Capnweb pipelines property access AND calls on an
      un-awaited `RpcPromise`, so an N-call chain on a client's stub is now ONE client round trip
      where it was N — the pipelining doctrine `dispatch.ts:13-23` already applied to native RPC
      promises. A rejection anywhere lands at the terminal await, inside the callers' `try` →
      `#recodeIfBroken` (`:86-90`). Gain: (N−1) client RTTs (1–5 ms same-colo, 20–200 ms internet)
      per N-call chain; **zero today** — every delivery push and every call site in `src/`/`e2e/` is
      a single-call chain. **At-least-once: n/a — edge request/response plumbing; no cursor, no DO
      state.** 2/3 do-now, 1 menu ("no caller pays it today"). Residue, optional: one ~15-line pin in
      `e2e/session-wire-frames-one-round-trip.e2e.test.ts` for a two-call provider chain, which also
      covers the anonymous call step (`method === ""`) invoked on an `RpcPromise` — no test exercises
      call-returns-function-then-call.

**Landed before this pass, re-verified as done (no action):**

- **Inject the 372 KB processor SDK only into isolates whose modules import `./processor.js`** —
  `src/context/worker-loader.ts:153-163` (`importsProcessorSdk`, conditional spread; a forgotten
  import fails loudly at module link by name). ~4–5 ms compile + ~0.4–0.8 MB resident less per cold
  stateless isolate (`runScript` lambdas, plain `WorkerEntrypoint`s); zero warm; zero for facets. The
  in-workerd delta is still unmeasured (measure #7). Two comments are now stale and should be reworded
  (2 lines): `src/stream/processor.ts:8` ("bundled … into every loaded isolate") and
  `docs/clean-room-api-walkthrough.md:642-643` ("injected … into every load").
- **`LiveState.set` returns at once when handed the identical object** — `src/stream/live-state.ts:77`,
  unit row `live-state.test.ts:40-48`. Removes the two JSON round trips per unchanged batch per
  processor (~0.3 ms at 50 KB of state, tens of µs at typical states). 2/3 "keep as done", 1 reject
  ("already done").

---

## MENU

Grouped by what they buy; within a group ordered by gain per line changed. Duplicate filings from
different finders are merged into one entry and say so.

### Latency

**L1 — The facet door recomputes, on every push, a value that cannot change while the row lives — and in workerd that CPU is on the producer's append RTT.**
_Three filings merged (latency, throughput, experiments); 9/9 judges menu._
`src/iterate-context-durable-object.ts:430` (kv memo read — the whole source, deserialized), `:439`
(`JSON.stringify(memo) !== JSON.stringify(spec)`, two O(source) passes), `:441` (`memo = spec`),
`:449` (`loadConfinedWorker` per call), `:462-463` (racing-delete re-read), `:471-482` (version
marker read/compare/put), `:483` (`ctx.facets.get`); `src/context/worker-loader.ts:116-119`
(`JSON.stringify(modules)` + a per-character djb2 loop on EVERY call, warm or cold; `sourceVersion`
is consumed only by the DO). Every processor push evaluates
`itx.facets.get(name, spec).processEventBatch` (`subscription-delivery.ts:199`, awaited at `:218`)
with the SAME `spec` object — the row's parsed target in core state (`core-processor.ts:218`;
`built-ins.ts:298` forwards `spec.source` by reference). Measured: ~7 µs per KB of source per push
(Node), +1.2 ms per bare-name call and +3 ms per facet on the append RTT at 600 KB (workerd).

- Proposal (a), standalone and landable now: `const sourceVersionByWorkerModules = new WeakMap<WorkerModules, string>()`
  at module scope in `worker-loader.ts`; compute djb2 only on a miss. ~5–6 lines, one file, zero
  behaviour change; `worker-loader.test.ts` pins `sourceVersion` VALUES, unchanged. Two judges would
  land it today; the decision is menu because it belongs inside (b) and touching `:449-483` twice is
  churn.
- Proposal (b): fold into `2026-09-02-workerd-idioms.md` F1 (`:22-60`) — the load moves inside the
  `ctx.facets.get` startup callback, the platform's own memo. In F1's shape: compute `sourceVersion`
  from the spec WITHOUT loading (the WeakMap from (a), exported as `sourceVersionOf(source, cacheKey)`
  — two callers), read only the small `facet:<name>:version` key on the warm path, touch the big memo
  only when version or `className` differs, keep the marker write and the abort AFTER a successful
  load (as `:471-482` do today — a spec whose load throws must not advance the marker). Per warm
  push: 1 small kv read + 1 WeakMap hit + 2 string compares + the RPC; the LOADER.get, the class mint
  and the `:462` re-read leave the warm path with F1.
- Gain: ≈7 µs per KB of literal-module source per push per processor row on the DO thread — noise
  at the fixtures, ~0.25 ms/push at 40 KB, ~2 ms/push at 330 KB — and, per the workerd probe, the
  same amount off the producer's append RTT (×N facets). Zero for `cacheKey` producer sources
  (`sourceVersion = cacheKey`, no hash, `worker-loader.ts:121-126`) — the shape apps/os is expected
  to ship. With F1: −2 kv reads, −1 LOADER.get, −1 class mint per push.
- Size: (a) ~6 lines / 1 file. (b) ~25–40 lines net deletion across `worker-loader.ts` and the DO as
  F1's addendum; one e2e pinning "a source change within a deploy restarts the facet in place"
  (unpinned today — grep for "source changed" hits only `src/`); one BUILD-LOG line.
- Trade-off: n/a for CPU. Semantic note for (b): comparing `className`/`cacheKey`/`sourceVersion`
  instead of the full stringify means a source that changes under an UNCHANGED `cacheKey` no longer
  rewrites the memo — defensible under the loader's own "same key ⇒ same code" (`worker-loader.ts:14`,
  `:55`) but say so.
- Dissent: 9/9 menu. One throughput judge's bench put the 300 KB cost at 0.64 ms (finders 1.93–2.3)
  and called the "10 commits/s ceiling" overstated; two experiments judges said the WeakMap misses on
  pushes (wrong — see the contradictions list; right for bare names). Both sub-proposals that keep or
  add an O(source) operation on the warm path are REJECTED below.

**L3 — Pager lookup deserializes every pager's attachment per call; an attach does it twice plus once per drop; a cold invoke does it twice — a reconnect storm is O(P²).**
`src/context/rpc-stub-directory.ts:276-280` (`getWebSockets(tag)` + readyState filter), `:286-290`
(`#rpcStubPagerFor`: linear `find` with `deserializeAttachment()` per socket, `:299`). Call sites:
`:137` (a NOT-borrowed `invokeRpcStub` — the first call per key after each 60 s quiesce) and again
at `:318` inside `#pageRpcStub` (re-finds the socket `:137` just found); `:201` + `:210-212`
(attach: `hadPager` scan, the replace scan, and `dropRpcStubPager` at `:233` scanning by
`transportId` per drop); `:226` (close); `:248` and `:267` (views). The steady path never touches it
(`#borrowedRpcStubs.get`, `:136`). Under-sold by the finder: the first delivery after EVERY idle
quiesce hits `:137` once per lent key — 200 subscribers = 200 × O(200) deserializes per idle→active
transition, not only on redeploys.

- Proposal, cheap and deletion-shaped (one judge; no new state): read `#rpcStubPagerRecords()` ONCE
  in `acceptRpcStubPagerWebSocket` and derive both `hadPager` and the replace list from that array;
  pass the socket found at `:137` into `#pageRpcStub` instead of re-finding it at `:318`. ~6–10
  lines; halves the storm and the cold invoke.
- Proposal, full: an in-memory `Map<rpcStubKey, Set<WebSocket>>` (name it
  `#rpcStubPagerSocketsByKey`, never `#index`) built lazily once per incarnation from
  `getWebSockets`, maintained at accept (`:204-206`), close (`:220-229`), drop (`:232-242`); the
  attachments stay the hibernation-surviving truth. Needs a readyState re-check on hit (the filter at
  `:279` excludes CLOSING sockets before any close event fires), a second index or a scan for
  `dropRpcStubPager`'s `transportId`, and a rewrite of the doc comment at `:281-283` ("DERIVED from
  the surviving sockets … nothing to reconcile"), which the index contradicts. Can absorb
  `#closedRpcStubPagerSockets` (`:100`).
- Gain: O(P) → O(1) per lookup. Nil at P ≤ 10; ~0.2–2 ms per cold-after-quiesce first call at
  P = 200, before the page round trip that dominates; a 200-client reconnect storm ~100–500 ms of DO
  CPU total, once. Estimated (1–5 µs per deserialize; `getWebSockets` also allocates P wrappers per
  call), not measured in workerd.
- Size: cheap variant ~6–10 lines; full 30–60 lines, one file, plus a new sync invariant.
- Trade-off: n/a for delivery; nothing pins. Sequence after SYNTHESIS bug 8 (the pager swap rejecting
  the in-flight page, same lines `:210-242`) and with bugs-edge-side #3 (splitting `dropRpcStubPager`).
- Dissent: 3/3 menu; two prefer the cheap variant first; gate the index on a 15-line workers-test
  bench of 200 pagers × one cold invoke.

**L4 — The resolver materializes `Object.values(rules)` on every dispatch before checking whether the root is already a built-in.**
`src/context/itx-expression-rewriting.ts:194` (`this.#rewriteRules()` evaluated eagerly as an
argument), `:126-128` (a built-in root returns before the first `pickItxExpressionRewriteRule` at
`:131`); the DO's thunk is `Object.values(this.#stream.coreReducedState.itxExpressionRewriteRules)`
(`iterate-context-durable-object.ts:251`). Every delivery-loop evaluation, every `append`, `read`,
`kv.*` builds and drops the array.

- Proposal: make the parameter a thunk — `rules: () => readonly ItxExpressionRewriteRule[]` at
  `:120`, call `rules()` at `:131`, pass `this.#rewriteRules` at `:194`; one test call site
  (`itx-expression-rewriting.test.ts:30`, `table(rules)` → `() => table(rules)`); `dispatch.test.ts`
  already hands the resolver a thunk. Alternative from one judge, tests untouched: a 2-line built-in-root
  short-circuit inside `resolve` before calling the thunk.
- Gain: ~0 at realistic rule counts (0.06 µs at R = 10); 5 µs per dispatch at R = 100, 63 µs at an
  implausible R = 1000. Dwarfed by the RPC hop and, for appends, the durable write.
- Size: ~4 lines, 2 files.
- Trade-off: n/a. The pure "rules 3–5" function takes a thunk instead of plain data — a small dent in
  the table test's plainness.
- Dissent: 2 menu, 1 do-now ("materialize-then-ignore on the hot path is an unambiguous smell; the
  thunk already exists as the resolver's field at `:177`"). Bundle with any other touch of the file.
  NOT recommended (finder and judges agree): a rule-pick cache keyed by the printed call (printing
  costs more than the scan) or precomputed specificity.

**L2 — `itx.kv.*` and `itx.whoami()` ride the edge→DO hop, and wake a hibernated DO, though no rule can apply to them and they read no DO state.**
`src/iterate-context.ts:164-177` (`invoke`: the fetch fork, then `this.#durableObject.invoke` at
`:177`); the header promise at `:14-17` ("every built-in root … rides it with ZERO code here");
`src/context/built-ins.ts:240-263` (`whoami` and `kv` close over `projectId` and `env.ITX_KV` only);
`itx-expression-rewriting.ts:128` (a built-in root returns before any rule — unshadowable). On an
idle context the hop is a full wake: constructor → durable `woken` → W1's fan-out → the kv read; the
DO side also pays `#recordActivityForQuietClock` (`iterate-context-durable-object.ts:555`). apps/os
reads `itx.kv` per request "with no DO in the path" (`2026-09-02-futures.md:171`).

- Proposal: a second root-only fork in `invoke` beside the fetch fork, for the root `kv` (drop
  `whoami` — its value as a cheap "did I reach the DO" probe outweighs 1 ms), evaluating an extracted
  `kvBuiltIn(projectId, ITX_KV)` the DO's `buildBuiltIns` also uses (two callers). The parsed root
  step is `["itx", ["whoami"]]` / `["itx", "kv", ["get", k]]`, so test
  `Array.isArray(step) ? step[0] : step`, not `itxExpression[1] === "kv"`.
- Gain: 1–3 ms per call same-colo (tens of ms cross-colo — the DO does not follow the client) and no
  DO wake for kv-only traffic (a billed wake + one SQLite transaction + W1's fan-out, 10–50 ms).
  **Today ≈ 0**: every `itx.kv` caller in the package is LOADED code inside an already-awake DO
  (`e2e/cursor-delivery-halts-ladders-and-resumes.e2e.test.ts:92-105` via `env.ITX.get()`), where the
  saving is one loopback RPC; the per-request routing-knob reader needs ingress (futures §3.3).
- Size: the finder said ~15 lines / 2 files; all three judges corrected it — the edge `IterateContext`
  holds NO env (`iterate-context.ts:122-133`), so `ITX_KV` threads through `UnauthenticatedSession` →
  `Session.projects.get` → `IterateContext` → `cd` (`:140-152`) → `ItxEntrypoint.get` (`itx-entrypoint.ts:27-33`)
  → `worker.ts:62` plus the e2e support constructors: **~30–60 lines, 4–8 files**, plus the header
  rewrite, the root table in `docs/itx-surface-as-built.md`, one e2e pin ("a kv call does not wake or
  warm the DO"), and a BUILD-LOG line for the behaviour change (kv-only traffic stops counting as
  activity for the 60 s quiesce — correct, but a change).
- Trade-off: n/a for delivery; hibernation improves. Doctrine: a second evaluation site for one root
  against "one door" and the file's own "ZERO code here" — an owner decision, parked behind "ingress
  reads `itx.kv` per request".
- Dissent: 3/3 menu; unanimous that the size was undercounted.

### Throughput

**T2 — Every facet batch appends a live-state delta back into the parent whether or not anyone can chain onto it; M changing processors turn one commit into M outbound pushes plus M inbound appends.**
`src/stream/processor.ts:486` (`publishLiveState()` after EVERY batch; also `:430`, the version-bump
heal), `:253-262`; `src/stream/live-state.ts:87-108` (diff, then an ephemeral `live-state/changed`
append, `void`-ed); `src/sdk/stream-processor-durable-object.ts:98` (the facet's sink is
`this.env.ITX.get().append(…)`), `src/itx-entrypoint.ts:27-33` (a fresh `IterateContext` +
`SessionTeardown` per `get()`). Two RPC legs + one parent `append` per changing facet per commit.
Bounded: the parent's work per delta is the EPHEMERAL fast path (`stream.ts:330-334` — no
transaction, no row), and `consumesEvent` (`processor.ts:115`) delivers an ephemeral only to rows
that name its type, so a delta does NOT re-fan-out to the other M−1 facets: the cost is M, not M².

- Proposal as filed: emit the FIRST delta of an incarnation unconditionally, then only while someone
  has read the seed door (`liveSnapshot()`, `processor.ts:245-248`, sets a flag); `LiveState.set`
  returns a boolean. **Rejected as written by one judge, hedged by two** (see REJECTED): it breaks the
  shipped subscribe-without-seed contract (`e2e/stream-woken-and-inline-live-state.e2e.test.ts:50-96`
  waits for later `core` deltas with no seed; the stream's inline core state is a SECOND `LiveState`
  holder, `stream.ts:353-357`, `:385`, with the same contract); it makes a WRITE-side effect depend
  on whether a READ verb was ever called this incarnation; and "emitted" must count only when the
  sink's append RESOLVES (`live-state.ts:100-108` fires and forgets — a paused parent refuses the
  delta), else a stale client stays stale for the whole incarnation. The better lever for the same
  cost is the SINK, not the semantics: the delta rides `env.ITX.get().append` with a fresh
  `IterateContext` per call — idioms F4 / layering F11.
- Gain: parent DO CPU per commit ~1.2–1.7× under M ≥ 20 all-changing processors with no watcher; ≈ 0
  for typical M ≤ 5; zero with a watcher attached; the enable-time offset burn is free. The facet-side
  diff (1.45 ms per batch measured on an 89 KiB projection) is microseconds for a counter. The
  `whoami` 27.7 vs 13 ms measurement conflates the 50 pushes with the deltas and cannot be attributed.
- Size: not ~10 lines / 2 files — ~15–35 src lines across `live-state.ts`, `processor.ts`,
  `stream.ts`, plus rewrites in 4–5 test files (`processor.test.ts:644-659` "revisions chain"
  appends with no seed and expects two chained deltas; `processor-rules.test.ts:405-432`;
  `__workers-tests__/stream.test.ts` offset pins; the woken e2e) and 3–4 doc sites stating
  emit-on-every-change (`live-state.ts` header, `processor.ts:143-150`, `:481-485`). Realistically
  80–120 lines touched.
- Trade-off: deltas are lossy by contract, so no durable delivery is affected — but a
  subscribe-without-seed consumer is silently downgraded to one delta per incarnation.
- Dissent: 1 reject (as written), 2 menu. Owner decision on the doctrine sentence before anything
  lands; do the sink first.

**T3 — The fetch lane caps an inline `workers.get({source})` expression between 32 and 64 KB; the runtime answers 431 with no hint.**
`src/worker.ts:78` (`?itx=` copied into `x-itx-expression`), `src/iterate-context.ts:174` (the
terminal-fetch fork puts the JSON expression in the same header), lane comment at
`src/fetch/rpc-stub-fetch.ts:42-45`. Measured: 32 KB → 200, 64 KB → 431.

- Proposal: no code. Two comment lines at `worker.ts:64-68` and `rpc-stub-fetch.ts:42-45`: the
  header is size-bounded — tens of KB locally, TIGHTER at the edge (Cloudflare documents ~16 KB per
  header / 32 KB total) — so name the source with a rule (`itx.site ⇒ itx.workers.get({…})`, the
  tour's shape) and keep the header at `itx.site`. Do not pin the locally measured number.
- Gain: none in speed; one opaque-431 hunt saved. Size: 2–3 comment lines.
- Dissent: 1 do-now (doc-only, an undocumented hard limit at a public door), 2 menu (zero perf gain).

### Startup and wake

**W1 — Every hibernation wake appends a durable `stream/woken`, rewrites the whole core checkpoint, pushes the wake into every default-subscribed processor, pages every default live subscriber — and that arms the 60 s quiet clock.**
_Two filings merged (startup; the latency filing was rejected for its at-least-once analysis and folded in here)._
`src/iterate-context-durable-object.ts:157-176` (constructor → `appendCreatedAndWokenEvents` at
`:175`; the comment at `:171-174` says the fan-out "re-establishes deliveries after hibernation" —
load-bearing text), `src/stream/stream.ts:190-203` (durable `woken` at `:201`), `:335-370` (one
`transactionSync`: events row, `maxAssignedOffset`, the core cursor, and — because `incarnation` is
core state and moves every wake, `core-processor.ts:54`, `:176-177` — the FULL `reduce:core:state`
blob, which carries every processor's inline source, M1), `:385` (a core live-state delta every
wake); `subscription-delivery.ts:136-151` with `processor.ts:115-116` (a durable matches every
`consumes: undefined` row — 13 of 14 `enableProcessor` calls in `e2e/`) → `#invokeFacet` per
processor (load + class mint + `facets.get` + RPC; the facet engine then writes a checkpoint for an
event none of them reduces, `processor.ts:470-477`) and a page + borrow per default live-stub row
(`rpc-stub-directory.ts:137`); `#liveFacetNames.add` (`:484`) and the borrow make
`#recordActivityForQuietClock` (`:347-355`) arm the alarm, so the DO is pinned non-hibernatable for
60 s (workerd#6800; `__workers-tests__/support.ts:64-73` documents the pin), then the alarm aborts
everything, then ~10 s to hibernate. `2026-09-02-workerd-idioms.md` F3 (`:120-162`) proposed the same
change for constructor-work reasons; this adds the fan-out, the pin and the at-least-once analysis.

- Proposal (F3(a), one step further): `ephemeral: true` at `stream.ts:201`; delete the `incarnation`
  field and the `woken` case from `CoreContract` (`core-processor.ts:54`, `:98-102`, the `consumes`
  entry at `:141-…`, `:176-177`); serve it from the kv counter that already exists —
  `coreReducedStateSnapshot()` returns `{ offset, incarnation: this.#incarnation, state }`
  (`stream.ts:227-229`). Ephemerals reach only rows that NAME the type (`processor.ts:115`), so the
  default fan-out disappears; a watcher that wants wakes says `consumes: [..., "events.iterate.com/stream/woken"]`.
  Keep `created` durable. Prefer the ephemeral over deleting the event: the hibernation tell stays
  observable. Precedent: `rpc-stub/attached` is ephemeral so "the log never claims a socket is open".
- **Hard prerequisite: `2026-09-02-bugs-do-side.md` #2 (`:60-90`; SYNTHESIS bug 3).** Today the
  unfiltered durable `woken` is the accidental wake-time trigger that re-pushes into a stream-kept
  cursor row an eviction left mid-delivery; `alarm()` (`:367-373`) runs
  `deliverEveryCursorSubscription` but `#recordActivityForQuietClock` arms NO alarm with no live
  facets and no borrowed stubs — exactly the state after a wake. Shipped alone, an ephemeral `woken`
  strands such a row until the next commit matching its `consumes` — on a quiet stream, never. That
  is the lost-delivery window the doctrine forbids; two judges marked the standalone filing
  `violatesDoctrine`. Land bug 3's fix first (drive the alarm pass off the rows; arm the quiet clock
  while a cursor row is behind), then this — or the one-line companion: kick
  `deliverEveryCursorSubscription()` once per incarnation from the first door.
- Second design decision the finders did not surface: a FACET row whose push a crash cut short is
  today healed by the wake push's gap repair; after the change it heals on the next durable push or
  read — unbounded delay on a quiet stream. Mitigants: the quiesce never aborts a facet mid-call
  (`#facetWorkInFlight`), so this needs a crash or redeploy mid-push; filtered facet rows already
  behave this way. Say it in BUILD-LOG.
- Gain, per wake that lands NO durable event (reads, probes, pager closes, alarms) on a context with
  ≥ 1 default-subscribed processor or live subscriber: −60 s pinned DO (128 MB × 60 s ≈ 7.5 GB-s ≈
  1e-4 $ per wake; ~$1/day per 10k such wakes; a sparse read-only caller every 5 min goes from ~23% to
  ~3% awake — ~7× less billed duration), −N facet cold starts (each ≥ LOADER.get + class mint +
  `facets.get` + 1 RPC; tens of ms cold), −M pager round trips. Per ANY wake: −1 SQLite transaction
  including the full core blob (~N × source bytes), −N facet checkpoint writes, −1 core delta, −1
  permanent log row per incarnation (a context waking 100×/day carries 36k rows a year that every
  version-bump re-reduce rescans). **Zero pin saving for append-driven wakes** — those materialize the
  facets and arm the clock anyway. Unmeasured in workerd; the dollar figure is a hypothesis
  (measure #3).
- Size: ~12–15 src lines across `stream.ts`, `core-processor.ts`, the DO constructor comment; PLUS
  bug 3's fix (~15–30 lines in `subscription-delivery.ts` + the DO); PLUS **15 test files** name
  `stream/woken`/`incarnation` (7 workers-tests, 5 e2e, 3 unit), ~23 absolute-offset pins shift
  (`do-doors.test.ts:97-124` pins woken@2 and first append@4; `stream.test.ts:219-263`;
  `ephemeral-offset-reuse.test.ts:90-110` uses woken as its durable landmark;
  `core-processor.test.ts:29` pins "EXACTLY its eight" consumes; `hibernation-at-scale` reads
  `snap.state.incarnation` → `snap.incarnation`); PLUS 4–6 docs that name the durable wake record
  (`stream.ts:15-25` "what is worth reaching is worth recording" is explicit owner doctrine being
  reversed). A half-day change with a full e2e run.
- Trade-off: no lost delivery once bug 3 is fixed; no duplicate introduced; hibernation strengthened.
  `CoreState.incarnation` becomes a non-reduced field on the snapshot envelope, next to `offset` —
  one fact through a second door; acceptable with a docstring.
- Dissent: 6/6 menu across both filings; two `violatesDoctrine` if shipped alone. The highest-value
  item on this menu; sequence it directly after bug 3.

**W2 — The 255 KiB React demo page is a string literal inside the API worker script, resident in every `/api` AND every DO isolate.**
`src/worker.ts:13` (import), `:49-52` (`/demo` route); `build-sdk.mjs:45-73` writes
`src/generated/demo-page.ts` (260,874 B, committed). 24% of the minified script, 17% of the upload,
for a page the product worker never uses.

- Proposal: Workers Static Assets — `build-sdk.mjs` writes `public/demo.html`; `wrangler.jsonc`
  gains `"assets": { "directory": "./public" }`; delete the route, the import and the generated
  module. `html_handling` serves `/demo` for `demo.html`, so `specs/live-state-demo.spec.ts`
  (`page.goto("/demo")`) is unchanged; the Playwright lane boots `wrangler dev`, which serves assets.
  The vitest e2e lane never fetches `/demo`, but `e2e/support/solo-config.ts:22` absolutizes `main`
  and `assets.directory` needs the same line. Gitignore `public/`. **No KV fallback** (one judge):
  parking a host page in `ITX_KV` smears the product's namespace and adds a deploy-time write.
- Gain: −255 KiB of script (−17% upload, −24% minified; ~60–80 KiB gzip); under 1 ms per cold isolate
  (a string literal is scanned, not parsed); zero warm; `/demo` stops invoking the worker at all. The
  remaining ~690 KiB of inlined strings (SDK, zod) dominate cold start, so the latency effect is
  unmeasurable; the win is shape.
- Size: ~−15 lines + 1 config line + 1 harness line + ~3 doc lines (`clean-room-api-walkthrough.md:91-93`,
  `ARCHITECTURE.md`), 1 file deleted, 1 added; 5–6 files touched.
- Trade-off: n/a. Dissent: 3/3 menu (unverified harness compatibility; small absolute gain).

**W3 — zod is in the worker script twice: 303 KiB as code for eight core schemas plus 303 KiB inside the SDK string — 56% of the minified script.**
`src/stream/core-processor.ts:27` (`import { z } from "zod"`, schemas at `:39-140`),
`src/stream/events.ts:6, 70, 98, 107` (`z.ZodType` bound, `.parse`), `src/stream/processor.ts:39, 58`
(type-only), `src/stream/subscriptions.ts:24`. Classic zod does not tree-shake; every cold `/api` or
DO isolate parses and evaluates it to validate `{ match: string, target: string | null }` at
configuration time. Judge re-bundled from the package cwd: zod 310,583 B of 1,108,339 B.

- Proposal (a): `zod/mini` in the main worker, `parse`/`$ZodType` from `zod/v4/core` in `events.ts`
  (both flavours share the v4 core, so the SDK's classic schemas still pass; mini's `ZodMiniType`
  still has `.parse`/`.safeParse`, so `subscriptions.ts:24` and `events.ts:88/100` are untouched).
  The core's constructs bundle to 18 KiB. **Not ~6 lines — all three judges corrected it:** mini has
  no chained builders, and `core-processor.ts:39-140` is written in them (22–32
  `.optional()/.default()/.nullable()/.regex()/.int().positive()` sites become `z.optional(…)`,
  `z._default(…)`, `.check(z.regex(…))`): a wholesale rewrite of the most-read declaration in the
  package, and a second zod dialect in one package. Proposal (b): delete zod from the main worker — a
  literal `initialState()` plus the hand checks the doors already half do (`subscriptions.ts:24-34`,
  `itx-expression-rewriting.ts:147-161`); ~−40 lines but retires the "built-ins get schemas, same as
  userspace" symmetry (`events.ts:67-68`, `processor.ts:55`). Owner's call; re-measure the bundle
  after either.
- Gain: −285 KiB (−26%) of edge script; ~3–8 ms per genuinely cold isolate (V8 lazy-parse of ~300 KiB
  - classic zod's top-level init, ~1.6 ms measured in node); zero per request, per commit, per warm
    DO wake or hibernation wake. Proportionally large, absolutely modest.
- Size: (a) 30–100 changed lines across 3–4 files; (b) ~−40 lines plus splitting
  `defineProcessorContract` so the SDK keeps zod.
- Trade-off: n/a. Dissent: 3/3 menu.

### Memory and CPU

**M1 — Inline processor sources parked in the core reduced state: a hard SQLITE_TOOBIG cliff at ~2 MiB aggregate; 50× slower rule changes and 20× slower appends below it.**
`src/iterate-context.ts:297-312` (`enableProcessor` embeds the module map in the target, `:307`),
`src/stream/core-processor.ts:213-223` (the reduce stores the parsed target, source included, `:218`),
`src/stream/stream.ts:363-369` → `reduce-checkpoint.ts:59` (the ENTIRE core state re-put as ONE kv
value on every core change — every `provide`, every un-set on a pager close, every pause),
`live-state.ts:87` → `lib/patch.ts` (the whole state JSON-normalized twice per change), plus L1's
per-push passes. `stream.ts:51-52` documents the ~2 MB cell cap and chunks EVENT bodies for it; the
checkpoint is one cell. Measured and **reproduced by a judge**: three 600 KB processors enable
(snapshot 1.8 MB); the fourth fails `SQLITE_TOOBIG`; afterwards `provide('itx.alias2','itx.kv')`
FAILS with the same error while a plain `append` succeeds — a project with 3–5 bundle-sized inline
processors can no longer take a live stub from any session, subscribe, or pause. Below the cliff:
`provide` p50 0.57 → 9.70 → 29.57 ms and append 0.54 → 3.03 → 10.60 ms for 0/1/3 × 600 KB; `core`
snapshot 0.28 → 4.21 ms with one 600 KB row. A session connect + disconnect that lent a stub is TWO
core changes = 2 × 1.8 MB of SQLite writes per client today. Correction from a judge: the SDK is NOT
in the row — `worker-loader.ts:153-163` injects it loader-side — so an SDK-importing processor's row
is tally-sized (0.7 KB); the cliff bites producers that bundle their dependencies inline.

- Proposal (the structural fix — layering F5's "structural alternative" made concrete): keep the
  source OUT of the reduced state; the log row stays the truth (already chunked, `stream.ts:498-540`).
  The reduce stores the target with the spec elided (`itx.facets.get(name).processEventBatch`) plus
  `hostedFacet: { className, cacheKey? }` on the row (fully qualified — not `hosts`); `#invokeFacet`
  on a bare name with no memo finds the row hosting `name`, reads `stream.read(configuredAtOffset - 1, 1)`
  (`read` is after-EXCLUSIVE) to recover the source from the raw event, writes `facet:<name>` once,
  proceeds; `#deleteFacetsWhoseHostingSubscriptionWasRemoved` (`:215-233`) tests `row.hostedFacet`
  instead of sniffing the target (fixes layering F2 as a side effect). Bump `CoreContract.version`
  (`core-processor.ts:45`) — the reduced shape changes. **One hole to close (~5 lines):** a re-enable
  under the same name without a disable today ships the new spec on every push, so `:439` rewrites
  the memo and `:471-482` restarts the facet on new code; with a bare-name row a stale memo would run
  the OLD code forever — so in the DO's post-commit hook (`append`, `:197-205`, beside the delete check), on a
  `subscription-configured` whose row hosts a facet, write `facet:<name>` from the event payload.
  Variant worth weighing: carry the spec as a named payload field so the reduce elides a FIELD rather
  than pattern-matching an expression shape; and keep the whole spec shape for a producer-EXPRESSION
  source (`cacheKey` path) — elide only inline module maps.
- Gain: above the cliff, correctness (`provide`/`subscribe`/`pause` work again). Below it, per core
  change at 1.8 MB inline: 29.7 → ~0.6 ms; snapshot 4.2 → 0.3 ms; the checkpoint from MB to KB on
  every core change; per durable append with 3 such facets 10.6 → ~0.6 ms together with L1. Zero for
  `cacheKey`-loaded and SDK-sized processors.
- Size: ~50–120 lines across `core-processor.ts` (reduce + row type + version), `iterate-context-durable-object.ts`
  (memo-miss recovery with a row-by-facet-name lookup, delete check, memo refresh),
  `iterate-context.ts`/`subscriptions.ts` (one shared spec-shape helper, not two sniffs),
  `e2e/support/client.ts:145` (`processorNames`), `core-processor.test.ts`, plus
  `docs/itx-surface-as-built.md`, `LAYERS.md`, and a sweep of the ~8 test files that read `.target`.
  A new row field and a memo-miss read — a mechanism, not a deletion.
- Trade-off: n/a for delivery; one SQL read per facet materialization (memo miss), never per push;
  hibernation helped (smaller checkpoint).
- Dissent: 3/3 menu. **The 3-line stopgap (refuse an inline source over 64 KB) is rejected** — see
  REJECTED.

**M2 — A processor catching up from the log checkpoints (and publishes a delta) on every 500-event page; only the last checkpoint is useful.**
`src/stream/processor.ts:470-477` (checkpoint whenever `sawDurable && advanced` — every page of
`catchUpFromLog` `:309-334` and every gap-repair page `:284-293`, not only the at-head one);
`reduce-checkpoint.ts:59` puts the STATE blob whenever the reduce changed it (every page for any
counting/mapping processor); `#rereduceIfVersionChanged` (`:418-424`) already writes once at the end —
the two catch-up paths disagree.

- Proposal: stage the checkpoint during catch-up, apps/os-style ("staged checkpoint every 8 pages",
  `2026-09-02-futures.md:103`): `if (sawDurable && advanced && (atHead || ++this.#catchUpPagesSinceCheckpoint >= 8))`.
  **Two corrections from the judges, the first mandatory:** (1) as filed it is UNSAFE — the
  `state !== stateBefore` compare at `:476` is against the state at the start of THIS batch (`:445`);
  with staging, pages 1–7 may change state and page 8 not, so the cursor is written at page 8 while
  the blob keeps its pre-page-1 value → on rehydrate the engine believes 1–8 are reduced but the state
  lacks them: a LOST reduction, silent. Compare against the state at the last PERSISTED checkpoint
  (`#reducedStateAtLastCheckpoint`, updated only inside the write), or put the blob unconditionally
  on a staged write. Also the exact-page-multiple at-head pass (`:321`) carries `events = []`, so
  `sawDurable` is false and a staged-but-unflushed checkpoint never lands — fold a pending flag into
  the write condition. (2) "pushes are unaffected" is false — a queued-behind push has
  `atHead === false` (`:301`), so under a burst earlier pushes defer too; scope the staging to the two
  log loops (pass the decision in), not a shared counter. Drop the optional
  `if (atHead) this.publishLiveState()` half. Rewrite the Rule 4 comment (`:461-466`, "ONE persist
  per range") and `reduce-checkpoint.ts:46-47`.
- Gain: ~8× fewer state-blob puts and delta appends during a multi-page catch-up or gap repair — a
  once-per-processor-lifetime cost (first enable on a long log, a slug change; post-eviction the
  checkpoint is READ and only the tail pages). Per page saved: one JSON serialize + kv put of the
  state (200 KiB ≈ 1–3 ms) against a page that already costs a 500-row read + 500 reduces + 500
  `processEvent` calls (5–20 ms) — ~10–25% of a rare rebuild's wall clock. Steady state: zero. No log
  or fixture in the package exceeds one page.
- Size: ~10–20 lines in `processor.ts` (counter scoped to the log loops, a last-persisted-state field
  or unconditional blob put on staged writes, pending flag, two comment edits) + two table rows in
  `processor-rules.test.ts` (exact-multiple flush; dirty-state carry across staged pages).
- Trade-off: **DUPLICATE, bounded, acceptable under the performance doctrine** — an eviction
  mid-catch-up re-reduces ≤ 8 pages (≤ 4,000 events, pure) and re-runs their `processEvent` effects
  (per-event idempotency keys, `processor.ts:156`), the at-least-once contract processors already
  sign. Never lost — once correction (1) is applied; one judge marked the filing `violatesDoctrine`
  as written for exactly that.
- Dissent: 3/3 menu; unanimous that the gain is unobserved in this codebase and the Rule 4 invariant
  change needs the owner's nod.

---

## REJECTED

Whole filings (three), one line each:

- **"Pushes to a facet that is behind are never coalesced — merge `#pushedEventBatches` and enqueue one chain step per name" (throughput).**
  As written it take-and-clears the entry `#deliverFromCursor` (`subscription-delivery.ts:260`) reads
  to hand ephemerals to a caught-up cursor target — a LOST delivery ("one push, unredeliverable",
  `processor.ts:294-295`); it lacks the row-identity guard against a stale chain step delivering the
  replacement row's merged batch to the old target; the "10×" assumes a 100 ms facet turnaround (a
  warm one is 3–10 ms, so ~2×); and event memory stays O(backlog). Rebuild on layering F10 if ever.
- **"Every hibernation wake appends a durable `stream/woken` and pushes it to every unfiltered processor" (latency).**
  Mechanism right, at-least-once analysis wrong: it claimed no lost delivery, but the durable `woken`
  is today's only recovery trigger for a cursor row an eviction stranded (bugs-do-side #2). Folded
  into W1 with that prerequisite.
- **"The 372 KiB processor SDK is injected into — and eagerly compiled by — every loaded isolate" (startup, second filing).**
  Already applied at `72378b0e5` (`worker-loader.ts:153-163`); nothing left to do but two comment
  rewords (see the landed list).

Parts of accepted findings that were rejected:

- **M1's 3-line stopgap — refuse an inline `source` over 64 KB at `enableProcessor`/`facets.get`.**
  An indirection constant; a speculative guard against trusted clients; converts the cliff into an
  early error without removing the amplification below it. If a stopgap is wanted it is a docs pointer
  to the `cacheKey` producer path.
- **L1 (experiments filing) part (b): `hash(memo.source) === hash(spec.source)` in place of the two stringifies.**
  On a bare-name call `memo` is kv-fresh, so the WeakMap misses and this ADDS a 2.3 ms/400 KB djb2
  where today's compare costs 0.3 ms — negative by the finding's own numbers.
- **L1 (throughput filing) part (2): fold `sourceVersion` into the big `facet:<name>` memo and compare after reading it.**
  Keeps the O(source) kv read + deserialize on the hot path (the "~0 after" claim is ~3× overstated),
  requires a two-phase memo write because `sourceVersion` is only known after the load, and deletes
  the version key idioms F1 relies on.
- **T2 as written: "first delta of an incarnation unconditional, the rest only while seeded".**
  Breaks the shipped subscribe-without-seed contract (the woken e2e; `live-state.ts` header); makes an
  emit depend on whether a read verb was ever called; counts a REFUSED delta as emitted.
- **M2's optional half: publish the live-state delta only on the at-head page during catch-up.**
  Contradicts `:481-485`, drops a watcher's rebuild-progress ticks, no measured gain.
- **L4 alternatives: a rule-pick cache keyed by the printed call; precomputed specificity.**
  Printing costs more than the scan it would save; the scan is sub-µs at realistic R.
- **W1 variant: delete `stream/woken` outright (the kv counter is the truth).**
  ~10 lines fewer, but the hibernation tell stops being observable to a watcher naming the type.
- **W2's fallback: `ITX_KV.put("demo.html", …)` at deploy + a 2-line route.**
  Smears the product's kv namespace; a runtime KV read per hit is slower than today's in-memory string.
- **L2 as sized ("~15 lines, 2 files") and W3 (a) as sized ("~6 lines").** Mechanisms stand; the
  sizes do not (30–60 lines / 4–8 files; 30–100 lines). Re-filed at their real sizes.
- **The throughput filing's e2e evidence ("83 ms for 50 facets, `whoami` 27.7 ms") as support for the hashing tax.**
  At sub-2 KB sources it measures loader lookup + class mint + `facets.get` + RPC + checkpoint (idioms
  F1), not hashing; it stays in the table as a measurement of F1's cost.

---

## What to measure next

Ordered by how much a surprise would force a redesign. Every number in this file came from one
laptop; these are the runs that would make them real.

1. **Delivery at the 10,000-subrequest budget** (`2026-09-02-futures.md` §3.9, `:505-525`). apps/os
   measured a SILENT stop at exactly 10,000 deliveries over one `/api` WebSocket (12,000 events at
   120/s; appends kept succeeding, the socket stayed open, only a new physical socket recovered). The
   clean room's lent stub is still invoked over a Workers-RPC leg from the DO
   (`rpc-stub-directory.ts:160`). Run one connected subscriber past 12,000 pushes on one incarnation
   and count subrequests; establish whether the pager/re-lend cycle (a fresh leg) resets the budget,
   as the design hopes. Same run, the depth limit: a facet's live-state delta is exactly an
   `append → deliver → append` chain (facet → `ItxEntrypoint` → DO append → N-row fan-out); apps/os
   hit `Subrequest depth limit exceeded` on that shape and skipped an event permanently.
2. **Append RTT under facet fan-out, attributed, in workerd.** The probe says ~3 ms per 600 KB facet
   lands on the producer's append reply. Time `kv.get(memo)`, the two stringifies, the djb2,
   `LOADER.get`, `getDurableObjectClass`, `ctx.facets.get`, the RPC and the checkpoint put
   separately, at 500 B and at 300 KB sources. This settles L1's rank against idioms F1, the 3–5×
   spread between the node hashing benches, and the microtask question for good.
3. **The wake bill.** One read-only probe every 5 min for an hour on a context with three
   default-subscribed processors: billed duration, facet materializations, log rows added. W1's
   "~$1/day per 10k wakes" and "7× duty cycle" are hypotheses until this runs. Repeat with `consumes`
   set on the rows to see the ceiling.
4. **Reconnect storm at P = 200 pagers** (L3): DO CPU per attach and total, in workerd. Under 1 ms
   per attach and the index is not worth its second source of truth; the 6-line variant still is.
5. **The cliff on the edge, not locally.** M1's SQLITE_TOOBIG at ~2 MB reproduced on local workerd;
   confirm the same cell cap on deployed DO SQLite before designing around the number.
6. **A rebuild of a 200 KiB-state processor over a 100k-event log** (M2): pages, seconds, kv bytes
   written. No fixture in the package exceeds one page today.
7. **Cold `LOADER.get` with and without `processor.js`**, in the workers pool — the landed change's
   gain rests on node numbers plus workerd source reading. If the difference is < 2 ms, the comment at
   `worker-loader.ts:153-156` should say so; if > 5 ms, `runScript`'s per-lambda cold isolate deserves
   a line in the docs.
8. **Live-state deltas at M = 20–50 changing processors with no watcher** (T2): parent DO CPU per
   commit with and without the deltas, so the `whoami`-mid-fan-out number can be attributed before
   anyone touches the emit semantics.
