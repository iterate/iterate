# Performance review — `packages/v3/project-worker`, 2026-09-02

> Produced by a find → three-judge verify → synthesize workflow: five finders (latency, throughput,
> startup, memory/CPU, experiments) filed 20 findings; every one was re-read against the tree by
> three judges who verified each `file:line`, re-derived or re-measured the gain, and voted
> do-now / menu / reject. This file is the synthesis. Tree: `wip/kernel-wayfinder-2026-07-30` @
> `2665e0125` (the working tree differs only in the two regenerated bundles). Nothing under `src/`
> was changed by this review; the four DO-NOW items below are proposals, not applied here.
>
> **Machine caveat, once for the whole file.** Every microsecond and millisecond below was measured
> on one Apple M-series laptop: the pure-module benches in Node 24 (`scratchpad/bench.ts`,
> `bench.mts`, `bench.mjs`, `microtask.mts`), the worker probes against local workerd through
> `wrangler dev` / the vitest workers pool (`scratchpad/e2e-probe/{wire-sizes,amplification,followup}.probe.test.ts`).
> None of it ran on Cloudflare's edge. Two node benches of the same operation disagreed by 3×
> (see the table); treat every number as an order of magnitude, and every dollar figure as a
> hypothesis until a production counter says otherwise.

---

## Summary (5 lines)

1. **The steady path is already fast and the fixtures are too small to show the taxes.** A built-in call is p50 0.3 ms round trip on local workerd, a durable append 0.41 ms, a 1-rule and a 3-rule chain to a borrowed stub 0.4 ms — rewriting, printing, parsing and the rule scan are all sub-microsecond at realistic rule counts. Every real cost found here is **linear in bytes the e2e fixtures never carry** (0.3–1.8 KB processor sources vs the 372 KB SDK bundle a real processor would be), or **per wake**, which no e2e runs long enough to feel.
2. **One structural fact drives half the findings: a processor's source text is parked in the core reduced state.** It is re-serialized on every facet push (three O(source) passes + a per-character hash, ~7 µs/KB/push), re-written as ONE kv cell on every core change (a pager close, a `provide`, a pause), and it hits SQLite's ~2 MB cell cap at ~3–5 bundle-sized processors — after which **no rule, subscription or pause can be configured in that context** (measured, reproduced by a judge). Below the cliff a rule change is 50× slower and a plain append 20× slower at 1.8 MB of sources.
3. **The most expensive thing per wake is not the wake — it is what the wake fans out.** `stream/woken` is durable and unfiltered, so every default-subscribed processor gets a push (a facet cold start + a checkpoint write) and every default live subscriber gets paged, and that arms the 60 s quiet clock: a read-only probe on an idle context with one default processor buys ~70 s of billed, non-hibernating DO. Fixing it is ~12 source lines but has a hard prerequisite (the cursor-lane arming bug, synthesis bug 3) and ~15 test files of shifted offsets — MENU, high.
4. **Four DO-NOW items, all deletion-shaped, none touching delivery semantics:** un-await the call steps in the lent-stub relay (capnweb pipelines them; 3 lines), inject the 372 KB SDK only into isolates whose code imports it (4 lines; workerd compiles every module eagerly, confirmed in its source), an identity guard in `LiveState.set` (1 line; today it JSON-round-trips a 50 KB state twice to diff an object against itself on every unchanged batch), and — a correctness item the SQLITE_TOOBIG probe exposed — reduce the core state into a local inside the commit transaction so a failed checkpoint write cannot leave a phantom subscription in memory that the loop then delivers to.
5. **Two claims from earlier reviews were corrected by measurement:** the layering review's "source rides every live-state delta" (it does not — the enable delta was 1,007 B; the amplification is the checkpoint WRITE and the diff), and the throughput finder's own e2e evidence (83 ms for 50 facets at 500 B sources measures loader lookup + facet RPC, i.e. idioms F1, not hashing). And the futures review's flag stands: **delivery has never been run at the 10,000-subrequest budget** that silently stopped apps/os; that is the first thing to measure.

---

## Measurements

Everything a finder or judge actually ran. "Node" = Node 24 on the laptop against the package's own
pure modules; "workerd" = local `wrangler dev` / vitest workers pool on the same laptop. Unless a
row says "judge re-ran", the number is the finder's single run.

| What                                                                                          | Number                                                                                                                                 | How                                                                                                  | Where it matters |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------- |
| Round trip, built-in call (`itx.whoami()`), dotted proxy                                      | p50 0.27 ms, p95 0.43 ms (n=150)                                                                                                       | workerd, `wire-sizes.probe` F, sequential                                                            | baseline         |
| Round trip, `itx.c.hello()` → 1 rule → warm borrowed stub; 3-rule chain                       | p50 0.41 / 0.39 ms                                                                                                                     | same                                                                                                 | baseline         |
| Round trip, `itx.append` durable / ephemeral, 1 event                                         | p50 0.41 / 0.27 ms                                                                                                                     | same                                                                                                 | baseline         |
| `itx.facets.get('core').snapshot()`, fresh context                                            | p50 0.28 ms                                                                                                                            | same                                                                                                 | M1               |
| Wire bytes: `whoami` 146 B/4 frames; `kv.get` via proxy 86 B; one 256 B ephemeral push 222 B  | as stated                                                                                                                              | workerd, `wire-sizes.probe` A, D                                                                     | context          |
| `enableProcessor(tally)` 0.7 KB source: row 251 B, core checkpoint 1,223 B, **delta 1,007 B** | as stated; later unrelated `provide` delta 185 B                                                                                       | workerd, `wire-sizes.probe` B                                                                        | M1, T2           |
| Core-checkpoint cliff: 600 KB sources                                                         | b1..b3 OK (snapshot 601 / 1,202 / 1,803 KB); **b4 `SQLITE_TOOBIG`**; then `provide` FAILS, plain `append` OK                           | workerd, `wire-sizes.probe` C                                                                        | M1, DO-NOW 3     |
| Amplification below the cliff: `provide(expression)` p50 for 0 / 1 / 3 × 600 KB sources       | 0.57 → 9.70 → 29.57 ms (finder); **judge re-ran: 0.59 → 9.67 → 29.73 ms**                                                              | workerd, `amplification.probe`                                                                       | M1               |
| Same, plain durable `append` with those facets enabled                                        | 0.54 → 3.03 → 10.60 ms (finder); judge re-ran 0.50 → 3.12 → 10.64 ms                                                                   | same                                                                                                 | M1, L1           |
| Facet call with a big memo: `facets.get('big').snapshot()` 600 KB vs `tally` 0.7 KB           | p50 1.63 vs 0.46 ms; `core` snapshot with one 600 KB row 4.21 ms; push path 5.50 vs 4.25 ms                                            | workerd, `followup.probe` 2                                                                          | L1, M1           |
| Phantom row after a failed checkpoint                                                         | log 5 rows, no b4; `subscriptions.list()` = [b1,b2,b3,b4]; core snapshot offset 16 vs durable head 11; `facets.get('b4')` answers      | workerd, `followup.probe` 1                                                                          | DO-NOW 3         |
| Per-push facet-door CPU: 2× stringify compare / stringify+djb2, at 1.2 KB / 40 KB / 330 KB    | 1.9 / 26 / 285 µs and 7.9 / 237 / 2,029 µs (≈7 µs per KB of source per push)                                                           | Node, `bench.ts` §3 on `e2e/support/sources.ts` + synthetic                                          | L1               |
| Same operation, second finder / a judge                                                       | djb2(400 KB) 2.33 ms, stringify(400 KB) 161 µs (`bench.mts` §5); 300 KiB compare+hash 1.93 ms (`bench.mjs`); **judge: 0.64 ms**        | Node; **three benches spread 3× at 300 KB** — the per-KB linearity is what to trust                  | L1               |
| WeakMap hit                                                                                   | 0.01 µs                                                                                                                                | Node, `bench.ts` §3                                                                                  | L1               |
| Microtask order: does the fan-out's sync prefix delay the append reply?                       | No — the awaiting caller resumes before the fan-out's heavy prefix runs                                                                | Node, `microtask.mts` (models `Stream.append` → `onCommit` → `.then(deliver)`)                       | L1               |
| `Object.values(rules)` at R = 10 / 100 / 1000; the rule scan itself                           | 0.06 / 5.3 / 63 µs; scan 0.25 / 0.97 / 9 µs; `print(call)` ≥ 0.4 µs                                                                    | Node, `bench.ts` §2                                                                                  | L4               |
| `LiveState.set(sameObject)` on a 50 KB state; `diff(a,a)`; one `JSON.parse(JSON.stringify)`   | 312.5 µs; 312.5 µs; 133 µs (×2 sides)                                                                                                  | Node, `bench.mts` §4                                                                                 | DO-NOW 4         |
| `LiveState.set` diff on a 2,000-key (89 KiB) state                                            | 1.45 ms per batch                                                                                                                      | Node, `bench.mjs`                                                                                    | T2               |
| `diff` with a 300 KB source in one row; `structuredClone` of that state                       | 556 µs; 50 µs                                                                                                                          | Node                                                                                                 | M1               |
| 50 processors enabled: offsets consumed; fan-out; `whoami` mid-fan-out                        | 1,379 offsets (~1,275 ephemeral deltas = M(M+1)/2); 50 facets reached head in 83 ms (1.7 ms/facet); `whoami` 27.7 ms vs 13 ms          | `pnpm e2e` push-delivery-throughput, 2026-09-03                                                      | T2, L1 (see §)   |
| 200 live subscribers, warm fan-out of one append; one live-stub push                          | 17 ms; ~85 µs                                                                                                                          | same e2e                                                                                             | baseline         |
| SDK bundle (`processor.js`): size; cold compile+eval                                          | 381,061 chars (372 KiB; zod 303.1 + capnweb 59.4 + own 9.3); compile 3.2–3.6 ms + eval 2.2–2.7 ms; **judge re-ran: 4.4–5.0 + 1.7–2.4** | Node `vm.SourceTextModule`, 4 fresh contexts (`bench.mjs`); esbuild metafile on `src/sdk/index.ts`   | DO-NOW 2         |
| Eager compile of unreferenced modules in workerd                                              | CONFIRMED by source: legacy registry compiles every `source.modules` entry at isolate build; `new_module_registry` has no enable date  | `workerd-api.c++:530-536`, `jsg/modules.c++:444-450`, `compatibility-date.capnp:514-516` @ dea490edc | DO-NOW 2         |
| Uploaded worker script                                                                        | 1,476.67 KiB (gzip 310.54); minified 1,082 KiB = SDK string 385.4 + zod 303.3 + demo 254.7 + capnweb 59.9 + own 47.1 + json5 31.3      | `wrangler deploy --dry-run --outdir`; esbuild metafile; judge re-bundled: 1,108,339 B                | W2, W3           |
| `zod/mini` build of the core's constructs                                                     | 18,456 B minified; `import("zod")` 12 ms vs `zod/mini` 1.5 ms unbundled from disk                                                      | Node, `mini.ts`, `t.mjs`                                                                             | W3               |
| Fetch lane, inline `workers.get({source})` in `x-itx-expression`                              | 648 B / 8 / 16 / 32 KB → HTTP 200; **64 KB and 128 KB → 431 "header too large"**                                                       | workerd, `wire-sizes.probe` E                                                                        | T3               |
| `enableProcessor` calls in `e2e/`                                                             | 14 calls, 1 passes `consumes` (the rest take the default = every durable)                                                              | `grep`                                                                                               | W1               |

**Where a measurement contradicted a first-principles claim:**

- **Layering F5 said the source "rides every live-state delta".** Measured: the enable delta for `tally` was 1,007 B and a later unrelated `provide` delta 185 B (`wire-sizes.probe` B). The diff emits an `add /subscriptions/<name>` op ONCE; the amplification is the checkpoint write (one kv cell, the whole state) and the JSON-normalizing diff, not the wire.
- **The throughput finder cited "83 ms for 50 facets, 1.7 ms/facet" as evidence for the hashing tax.** At 500 B sources the hash is ~1 µs; that 1.7 ms is `LOADER.get` + `getDurableObjectClass` + `ctx.facets.get` + the awaited in-process RPC + the facet's checkpoint put — the cost `2026-09-02-workerd-idioms.md` F1 removes, not this one. The e2e cannot see the hashing at all; only the node benches and the 600 KB probe can.
- **Three node benches of "hash a 300 KB source" disagree 3× (0.64 / 1.93 / 2.3 ms).** Same laptop, different harnesses and warm-up. The mechanism is per-character and linear; the constant is what is uncertain.
- **The startup finder asked "IF workerd compiles unreferenced modules eagerly".** Two judges settled it by reading workerd: it does (legacy module registry). But module EVALUATION (zod's ~2 ms top-level init) runs only on import, so a non-importing isolate recovers compile only: ~4–5 ms, not 6–12.
- **"~2.5 ms parse for the 255 KiB demo string" (W2).** A string literal is scanned, not parsed; a judge puts it at ~1 ms per cold isolate.
- **"The first user append lands at 2, not 4" after an ephemeral `woken` (W1).** Wrong for the born case: `created` at 1 still changes core state, so the core delta still fires — `created`@1, `woken`@2 ephemeral, delta@3, first append@4. Only re-wakes shrink.
- **"A webhook wake pays the 60 s pin" (W1).** An append-driven wake materializes the default facets and arms the clock regardless; the pin saving is for wakes that land no durable event (reads, probes, pager closes, alarms).

---

## DO-NOW

Each is ≲ 30 lines, one or two files, no new abstraction, and either the smell is unambiguous or the
gain is clear. Decision = do-now from the judges (2/3 or 3/3). None changes what is delivered, to
whom, or in what order; none pins the DO.

- [ ] **1. Un-await the call steps in the lent-stub relay — capnweb pipelines them; the relay re-serializes them.**
      `src/context/rpc-stub-relay.ts:70-73` (the two `await`s), `:76` (`return value`), docstring `:59-60`.
      The docstring already says "a property step pipelines through the stub"; the code awaits every
      CALL step, so `itx.slack.conversations.open(u).postMessage(t)` on a lent stub costs 2 client
      WebSocket round trips where capnweb would do 1 — the exact anti-pattern `dispatch.ts:13-23, 51-56`
      documents avoiding for native RPC promises. Verified against the fork (`@iterate-com/capnweb`
      0.12.2 `PROXY_HANDLERS`: `apply` on an un-awaited `RpcPromise` issues a pipelined `doCall`; a
      rejection propagates to every pipelined call, so the terminal `await` still lands in `invoke`'s
      `try` and `#recodeIfBroken` (:110-116) keeps working).

  ```ts
  async #walkItxExpressionSteps(itxExpressionSteps: ItxExpression): Promise<unknown> {
    let value: unknown = this.#clientRpcStub;
    for (const step of itxExpressionSteps) {
      if (typeof step === "string") value = (value as Record<string, unknown>)[step];
      else {
        const [method, ...args] = step;
        value =
          method === ""
            ? (value as (...a: unknown[]) => unknown)(...args)
            : (value as Record<string, (...a: unknown[]) => unknown>)[method](...args);
      }
    }
    return await value; // ONE flush — every call step above is pipelined on the un-awaited RpcPromise
  }
  ```

  Gain: (N−1) client RTTs (20–200 ms each over the internet, 1–5 ms same-colo) per N-call chain on
  a lent stub; **zero today** — every delivery push and both DO→client call sites are single-call,
  and no multi-call chain on a lent stub exists in `src/`, `e2e/` or the surface doc. The win is
  removing a contradiction between the relay and the dispatch doctrine before someone pays for it.
  At-least-once: n/a — edge request/response plumbing; no cursor, no DO state, stub stays edge-side.
  Add one table row in `rpc-stub-relay.test.ts`: a two-call chain issues both `apply`s before any
  `then` (a fake stub proxy counting them). Dissent: one judge voted menu ("no caller pays it").

- [ ] **2. Inject the 372 KB processor SDK only into isolates whose code imports it.**
      `src/context/worker-loader.ts:153-156`; reword `src/stream/processor.ts:8` ("bundled … into every
      loaded isolate") and `docs/clean-room-api-walkthrough.md:642-643` ("injected … into every load").
      Every cold `LOADER.get` hands the isolate `"processor.js": PROCESSOR_SDK_MODULE` (381,061 chars,
      81% zod). workerd's legacy module registry compiles every module at isolate build whether imported
      or not (confirmed in source, table above). `runScript` lambdas (`built-ins.ts:44-53` import only
      `cloudflare:workers`) and plain `WorkerEntrypoint`s never import it; every `runScript` is a cold
      isolate keyed by its content hash, so every distinct ad-hoc script pays it. Every importer in the
      tree spells the literal `"./processor.js"` (6 of 12 `cap.js` fixtures, two e2e, two workers-tests,
      `demo.tsx`); no dynamic `import(` anywhere.

  ```ts
  const modules = await getModules();
  // The SDK rides a load whose code imports it ("./processor.js", or "../processor.js" from a
  // sub-path). A stateless worker or runScript lambda that never does would otherwise compile
  // 372 KB of zod at isolate build (workerd compiles every module eagerly). A spelling this regex
  // misses fails LOUDLY at module link, naming "./processor.js" — trusted clients.
  const importsProcessorSdk = Object.values(modules).some((code) =>
    /["'](\.\.?\/)*processor\.js["']/.test(code),
  );
  return {
    …,
    modules: importsProcessorSdk ? { ...modules, "processor.js": PROCESSOR_SDK_MODULE } : modules,
  };
  ```

  Gain: ~4–5 ms CPU (compile only; eval is not paid by a non-importer), 372 KiB less copied through
  `getCode`, ~0.4–0.8 MB less resident, **per cold stateless isolate**; zero warm, zero for facets
  (they import it). Roughly 10–20% of a cold dynamic-worker load. At-least-once: n/a.
  Dissent: one judge on this filing and all three on the latency finder's duplicate filing voted
  menu ("small, cold-only, measure in workerd first") — the do-now rests on the unambiguous smell
  and four lines, not on the magnitude. Keep the measurement: one workers-test timing a cold
  `LOADER.get` with and without the module (see "what to measure next").

- [ ] **3. Reduce the core state into a local inside the commit transaction; assign the fields only after SQLite committed.**
      `src/stream/stream.ts:358-372` (the commit block), `:393-402` (`#reduceEventIntoCoreReducedState`),
      `:178` (the constructor's re-reduce caller). **Correctness, not speed** — filed here because the
      SQLITE_TOOBIG probe (M1) exposed it. Inside `transactionSync`, line 359 assigns
      `this.#coreReducedState` per event, 360 sets `#coreReducedThroughOffset`, 362 sets
      `#coreReducedStateChangedAtCommit`, and only THEN 363 `writeReduceCheckpoint` puts the whole state
      blob as ONE unchunked kv cell (`reduce-checkpoint.ts:58-60`). When that put throws (the ~2 MB cell
      cap the file's own header knows about at `:50-53` — it chunks EVENT bodies for it, not the
      checkpoint), SQLite rolls the rows and the mark back, `append` rethrows before `:371-372`, and
      memory keeps the state the log rejected. Measured: after `b4` failed, `subscriptions.list()`
      showed b4, the core snapshot offset was 16 against a durable head of 11, the next append pushed to
      b4, `#invokeFacet` wrote the `facet:b4` memo from the phantom row and `facets.get('b4').snapshot()`
      answered with reduced state — a facet fed from an event that never existed, until eviction. The
      two offset marks at `:371-372` already follow the right rule; the comment at `:362` ("never inside
      the txn") shows the author applied it to the flag's publication but not to the state.

  ```ts
  let coreReducedState = this.#coreReducedState;
  this.#storage.transactionSync(() => {
    … rows, mark, `#coreLiveState ??=` unchanged …
    for (const event of freshEvents)
      coreReducedState = this.#reduceEventIntoCoreReducedState(event, coreReducedState);
    writeReduceCheckpoint(this.#storage.kv, contract.slug,
      { reducerVersion: contract.version, reducedThroughOffset: nextOffset },
      coreReducedState, coreReducedState !== this.#coreReducedState);
  });
  // Memory moves only after SQLite committed — the two marks below already follow this rule.
  if (coreReducedState !== this.#coreReducedState) this.#coreReducedStateChangedAtCommit = true;
  this.#coreReducedState = coreReducedState;
  this.#coreReducedThroughOffset = nextOffset;
  this.#highestAssignedOffset = this.#highestDurableOffset = nextOffset;
  ```

  `#reduceEventIntoCoreReducedState(event, state): CoreState` returns `reduce(...) ?? state` (the
  `catch` returns `state`); the constructor caller becomes
  `this.#coreReducedState = this.#reduceEventIntoCoreReducedState(event, this.#coreReducedState)`.
  ~12–15 lines, one file; plus one workers-test in `__workers-tests__/stream.test.ts` that appends a

  > 2 MB core-consumed durable (a rewrite-rule target or a processor source) and asserts
  > `subscriptions.list()` and the core snapshot offset equal the durable head afterwards (~25 lines).
  > Gain: no speed change on the green path. Removes a memory/log divergence that today persists until
  > eviction and causes deliveries to, and materialization of, a facet the log never enabled, plus one
  > oversized phantom core delta to every watcher. It is the precondition for M1's cliff being a clean
  > refusal instead of silent corruption. At-least-once: n/a — nothing lost or duplicated; a delivery
  > that should never have happened stops happening. 3/3 do-now; re-file the area as correctness.

- [ ] **4. Identity guard at the top of `LiveState.set`.**
      `src/stream/live-state.ts:82` (the `diff` call), contract at `:69` ("Build a NEW value (don't
      mutate `next` in place) — the diff is over JSON"). `ProcessorEngine.#reduceAndCommitEventBatch`
      calls `publishLiveState()` after EVERY batch (`processor.ts:486`; the comment at `:483-485` says
      so on purpose); the default `projectLiveState` returns `state` verbatim (`:151-153`); a batch whose
      reduces all returned `undefined` keeps object identity (`:414`). So `set(next)` receives the very
      object it holds as `#lastSerializedState` and `diff` (`lib/patch.ts:46-50`) JSON.stringifies AND
      JSON.parses BOTH sides, then walks them, to conclude `undefined`. Output-identical today in every
      reachable case: same object ⇒ `diff` returns `undefined` ⇒ `:90` returns with no rev bump and no
      append. The engine already treats identity as the change signal (`state !== stateBefore`,
      `processor.ts:476`).

  ```ts
  set(next: S): void {
    // Same object ⇒ same JSON ⇒ no delta. The engine re-projects after EVERY batch and the default
    // projection is the reduced state itself, so a batch that moved nothing arrives here as the very
    // object last serialized. The contract above forbids in-place mutation, so identity is proof; a
    // caller who mutates in place and re-sets the same object gets no delta — today it gets none either.
    if (next === this.#lastSerializedState) return;
    let patch;
    try {
      patch = diff(this.#lastSerializedState, next);
    …
  ```

  Gain: 100% of the per-batch diff on unchanged batches — ~0.3 ms per batch per processor at 50 KB
  of state (measured), tens of µs at typical few-KB states, ~3 ms at 500 KB; zero on batches that
  changed; nil for a `projectLiveState` override that builds a fresh object (it should — it pays
  the diff on purpose). The finder's "150 ms of DO CPU per second" assumes 5 processors × 100
  batches/s × 50 KB, a hypothetical load. At-least-once: n/a — no delta and no rev move in either
  path. One row in `live-state.test.ts` (`set(sameObject)` appends nothing, rev unchanged — passes
  today too; it is a guard, not red→green). 3/3 do-now.

---

## MENU

Grouped by what they buy. Within a group, ordered by gain per line changed. Each entry: where,
mechanism, proposal, gain, size, trade-off, dissent. Duplicate filings from different finders are
merged into one entry and say so.

### Latency

**L1 — The facet door recomputes, on every push, a value that cannot change while the row lives.**
_Three filings merged (latency, throughput, experiments)._
`src/iterate-context-durable-object.ts:430` (kv memo read, the whole source), `:439`
(`JSON.stringify(memo) !== JSON.stringify(spec)`, two O(source) passes), `:449` (`loadConfinedWorker`
per call), `:462` (racing-delete re-read), `:471` (version-marker read); `src/context/worker-loader.ts:116-119`
(`JSON.stringify(modules)` + a per-character djb2 loop on EVERY call, warm or cold; `sourceVersion`
is returned at `:161` and consumed only by the DO). Every processor push evaluates
`itx.facets.get(name, spec).processEventBatch` (`subscription-delivery.ts:199`, awaited at `:218`)
with the SAME `spec` object — the row's parsed target in core state (`core-processor.ts:218`;
halted/resumed spreads keep the `target` reference; `built-ins.ts:294-303` forwards `spec.source` by
reference; `:441` sets `memo = spec`). So on the push path a WeakMap keyed by the modules object hits
every time after the first; on a bare-name call (`facets.get('big').snapshot()`) the memo is
kv-fresh and it misses — one experiments judge generalized that miss to the push path, which is
wrong (`memo = spec` at `:441`), but right for bare names.

- Proposal (a), standalone: `const sourceVersionByWorkerModules = new WeakMap<WorkerModules, string>()`
  in `worker-loader.ts`; compute djb2 only on a miss. ~5–6 lines, one file, zero behaviour change.
  Two judges rated (a) alone as do-now-sized; the decision is MENU because it belongs inside (b).
- Proposal (b): fold into `2026-09-02-workerd-idioms.md` F1 (the load moves inside the
  `ctx.facets.get` startup callback, the platform's own memo). In F1's shape: compute
  `sourceVersion` from the spec WITHOUT loading (the WeakMap), read only the small
  `facet:<name>:version` key, touch the big memo only when version or `className` differs. Per warm
  push: 1 small kv read + 1 WeakMap hit + 2 string compares + the RPC. Do NOT fold `sourceVersion`
  into the big memo and compare after reading it (the throughput filing's part 2) — that keeps the
  O(source) kv read on the hot path and deletes the version key F1 relies on. Do NOT compare
  `hash(memo.source) === hash(spec.source)` (the experiments filing's part b) — `memo` is kv-fresh
  there, so it ADDS a djb2 (2.3 ms/400 KB) where today's two stringifies cost 0.3 ms.
- Gain: ≈7 µs per KB of source per push (measured), i.e. noise at the 1 KB fixtures, ~0.25 ms/push
  at 40 KB, ~2 ms/push at 330 KB, × N processor rows per commit, on the DO thread. Throughput /
  next-caller CPU, not append-reply latency (the reply escapes before the fan-out's prefix —
  `microtask.mts`). Zero for `cacheKey` producer sources (`sourceVersion = cacheKey`, no hash;
  `worker-loader.ts:121-131`) — which is the shape apps/os is expected to ship. With F1 the two
  extra kv reads and the class mint go too.
- Size: (a) ~6 lines / 1 file; (b) ~25–40 lines net deletion across `worker-loader.ts` and the DO,
  as F1's addendum; one e2e pinning "source change within a deploy restarts the facet in place"
  (currently unpinned — grep for "source changed" hits only the two src files).
- Trade-off: n/a for CPU. Semantic note for (b): comparing `className`/`cacheKey`/`sourceVersion`
  instead of the full stringify means a PRODUCER source whose expression changes under the same
  `cacheKey` no longer rewrites the memo — defensible under the loader header's "same key ⇒ same
  code" (`worker-loader.ts:12-15`) but say so in BUILD-LOG.
- Dissent: 9/9 judges menu on the three filings; two would land (a) now; one throughput judge's
  bench put the 300 KB cost at 0.64 ms (finders: 1.93–2.3 ms) and called the claimed "hard ceiling
  near 10 commits/s" overstated 3×.

**L2 — `itx.kv.*` and `itx.whoami()` ride the edge→DO hop, and wake a hibernated DO, though no rule can apply to them and they read no DO state.**
`src/iterate-context.ts:164-178` (`invoke`: one fetch fork, then `this.#durableObject.invoke`),
header promise at `:14-17` ("every built-in root … rides it with ZERO code here");
`src/context/built-ins.ts:240-265` (`whoami`/`kv` close over `projectId` and `env.ITX_KV` only);
`itx-expression-rewriting.ts:126-128` (a built-in root returns before any rule is consulted —
unshadowable). On an idle context the hop is a full wake: constructor → durable `woken` → fan-out
(W1) → the kv read. apps/os reads `itx.kv` per request "with no DO in the path"
(`2026-09-02-futures.md:171`, `docs/remote-apps.md:104-161`).

- Proposal: a second root-only fork in `invoke` beside the fetch fork for roots `kv` and `whoami`,
  evaluating an extracted `kvBuiltIn(projectId, ITX_KV)` that the DO's `buildBuiltIns` also uses
  (two callers). Unwrap the step: the parsed form is `["itx", ["whoami"]]`, so the check is on
  `Array.isArray(step) ? step[0] : step`, not `itxExpression[1] === "whoami"`.
- Gain: 1–3 ms per call same-colo (tens of ms cross-colo — the DO does not follow the client) and
  no DO wake for kv-only traffic (a billed wake + one SQLite transaction + the W1 fan-out, 10–50 ms).
  **Today ≈ 0**: no first-party edge caller of `kv`/`whoami` exists in this package; the
  per-request routing-knob reader is a future that needs ingress (futures §3.3).
- Size: the finder said ~15 lines / 2 files; all three judges corrected it — the edge
  `IterateContext` holds NO env (`iterate-context.ts:121-132`), so `ITX_KV` threads through
  `UnauthenticatedSession` → `Session.projects.get` → `IterateContext` → `cd` → `ItxEntrypoint.get`
  → `worker.ts:62` plus the e2e support constructors: **~30–60 lines, 4–8 files**, plus the header
  rewrite and the root table in `docs/itx-surface-as-built.md`.
- Trade-off: n/a for delivery; hibernation improves. Doctrine: adds a second evaluation site for
  two roots against "one door" and the file's own "ZERO code here"; BUILD-LOG ~2352 records the
  owner choosing to show built-ins on the edge type "without moving execution to the edge" — an
  owner decision, not a mechanical refactor. The `cd` precedent (surface doc §5) is pure
  addressing; `kv` is a side-effecting store.
- Dissent: 3/3 menu; unanimous that the size was undercounted.

**L3 — Pager lookup deserializes every pager's attachment per call; a pager attach does it twice (plus once per drop), so a reconnect storm is O(P²).**
`src/context/rpc-stub-directory.ts:276-280` (`getWebSockets(tag)` + readyState filter), `:286-290`
(`#rpcStubPagerFor`: linear `find` with `deserializeAttachment()` per socket at `:298-300`). Call
sites: `:137` (a NOT-borrowed `invokeRpcStub` — the first call per key after each 60 s quiesce),
`:201` and `:210-212` (attach: `hadPager` scan + the replace scan; each `dropRpcStubPager` at `:233`
scans again), `:226` (close), `:252` and `:265` (views). The steady path never touches it
(`#borrowedRpcStubs.get`, `:136`).

- Proposal: an in-memory `Map<rpcStubKey, Set<WebSocket>>` (name it `#rpcStubPagerSocketsByKey`,
  never `#index`) built lazily once per incarnation from `getWebSockets`, maintained at accept
  (`:204-206`), close (`:220-229`), drop (`:232-242`); the attachments stay the hibernation-surviving
  truth. It can absorb `#closedRpcStubPagerSockets` (`:100`) — a socket absent from the map is by
  definition closed — making it near net-zero LOC. Cheaper deletion-shaped alternative from one
  judge, no new state: read `#rpcStubPagerRecords()` ONCE in `acceptRpcStubPagerWebSocket` and
  derive `hadPager` and the replace list from that array; pass the socket found at `:137` into
  `#pageRpcStub` instead of re-finding it at `:318`. ~6–10 lines; halves the storm.
- Gain: O(P) → O(1) per lookup. Nil at P ≤ 10; ~0.2–1 ms per cold-after-quiesce first call at
  P = 200, dwarfed by the page round trip that follows; a 200-client reconnect storm (an edge
  redeploy) ~100–200 ms of DO CPU total, once. Estimated (1–3 µs per deserialize), not measured in
  workerd; the finder's 80k figure is ~2× high (P grows 0 → 200 during the burst).
- Size: 25–60 lines, one file (two indexes if `dropRpcStubPager` keeps looking up by
  `transportId`), a per-incarnation rebuild, a readyState re-check on hit (the filter at `:279`
  excludes CLOSING sockets before any close event fires), plus the doc comment at `:281-283`
  ("DERIVED from the surviving sockets … nothing to reconcile") which this contradicts.
- Trade-off: n/a for delivery; the index pins nothing. Must be sequenced after synthesis bug 8
  (the pager swap rejecting the in-flight page, same lines `:210-242`).
- Dissent: 3/3 menu; one judge prefers the one-scan-per-attach variant; one notes a tag-per-key
  (`getWebSockets(keyTag)` IS the index, zero state) but `rpcStubKey` is opaque and unbounded, so
  it needs a hash or length guard.

**L4 — The resolver materializes `Object.values(rules)` on every dispatch before checking whether the root is already a built-in.**
`src/context/itx-expression-rewriting.ts:194` (`this.#rewriteRules()` evaluated eagerly as an
argument), `:126-128` (built-in root returns before the first `pickItxExpressionRewriteRule` at
`:131`); the DO's thunk is `Object.values(this.#stream.coreReducedState.itxExpressionRewriteRules)`
(`iterate-context-durable-object.ts:251`). Every delivery-loop evaluation, every `append`, `read`,
`kv.*` builds and drops the array.

- Proposal: make the parameter a thunk — `rules: () => readonly ItxExpressionRewriteRule[]`, call
  `rules()` at `:131`, pass `this.#rewriteRules` at `:194`. One test call site changes
  (`itx-expression-rewriting.test.ts:30`, `table(rules)` → `() => table(rules)`); the finder said
  two, there is one. Explicitly NOT recommended by the finder and the judges: a rule-pick cache
  keyed by the printed call (printing costs more than the scan) or precomputed specificity.
- Gain: ~0 at realistic rule counts (0.06 µs at R = 10, 0.5 µs at R = 20); 5 µs per dispatch only
  at R = 100, 63 µs at an implausible R = 1000. Dwarfed by the per-dispatch print/parse and the RPC
  hop.
- Size: ~4 lines, 2 files.
- Trade-off: n/a. Mild doctrine cost: the pure "rules 3–5" function takes a thunk instead of plain
  data, muddying the table test's plainness a little.
- Dissent: 2 menu, 1 do-now ("materialize-then-ignore on the hot path is an unambiguous smell;
  the thunk already exists as the resolver's field"). Bundle with any other touch of the function.

### Throughput

**T1 — Pushes to a facet that is behind are never coalesced: one awaited RPC + one facet checkpoint write per commit, and an unbounded closure queue when the facet is slower than the commit rate.**
`src/stream/subscription-delivery.ts:136-150` (`onCommit`: one `.then(() => #deliverEventBatch(…))`
closure per commit per matching row, each capturing its own filtered `events`), `:217-218` (facet
push awaited — `processEventBatch` returns the facet's serial chain, which ends in the per-range
checkpoint put, `processor.ts:470-477`), `:68-73` (`#pushedEventBatches`: the cursor lane's
"freshest pushed batch", latest-wins — the shape half-built). The facet already accepts a 900-event
batch in one call (bigbatch e2e), and `{after, through}` windows merge trivially.

- Proposal: make `#pushedEventBatches` THE per-name queue for every lane and MERGE instead of
  replace (`queued.events.push(...events); queued.through = nextOffset`), enqueue ONE chain step per
  name while an entry is pending. **Two corrections from the judges, both mandatory:** (1) do NOT
  take-and-clear the entry at chain-step start — `#deliverFromCursor` (`:300-308`) reads the map to
  take the pushed batch when contiguous, and that is the ONLY way ephemerals (not in the log) reach a
  caught-up cursor target; taking it first loses them. Have the chain step call `#deliverEventBatch`
  with no events and let the facet/rpc branches take the entry synchronously right before `call`
  (they already `delete` there at `:206`/`:217`); (2) guard the chain step with row IDENTITY,
  `if (this.#stream.coreReducedState.subscriptions[name] !== row) return;` — after a
  `subscription-configured` the OLD row's already-enqueued closure would otherwise take the NEW row's
  merged batch and deliver it to the old target (a lost delivery to the new target the per-closure
  `events` capture does not have today). Rewrite the `:68-69` docstring from "latest wins" to
  "merged until taken".
- Gain: zero for a caught-up facet (same path). Under sustained backlog only: facet RPCs +
  `#invokeFacet` work + checkpoint kv puts fall from #commits to #facet-turnarounds — the finder's
  "10×" assumes a 100 ms turnaround; a warm facet's is ~3–10 ms (two kv gets, a cached load, one
  same-DO RPC, the reduce, one output-gated put), so a judge puts it at ~2×. Closure count O(1)
  per name; **event memory stays O(backlog)** (the merged array holds every event) — the finder's
  memory claim is wrong in substance.
- Size: ~30–40 lines, one file, plus one e2e row (a facet blocked 500 ms while 10 commits land
  receives ONE push whose range chains), plus a re-check of the exact-count pins at
  `e2e/push-delivery-ranges-chain.e2e.test.ts:26` (`invocations.length === 2`) and
  `cursor-delivery-halts-ladders-and-resumes.e2e.test.ts:416`.
- Trade-off: with (1) and (2) applied, neither duplicate nor lost — the same events reach the target
  once, in order, in fewer calls; the merged window is the union of the merged windows. As WRITTEN,
  it loses cursor-lane ephemerals ("one push, unredeliverable", `processor.ts:296-297`) — one judge
  marked the filing `violatesDoctrine` for that.
- Dissent: 3/3 menu. Build on `2026-09-02-layering.md` F10 (a subscription's delivery state in four
  containers) — do the merge when those maps are consolidated.

**T2 — Every facet batch appends a live-state delta back into the parent whether or not anyone can chain onto it; M processors turn one commit into M outbound pushes plus M inbound appends.**
`src/stream/processor.ts:486` (`publishLiveState()` after EVERY batch), `src/stream/live-state.ts:82-101`
(diff, then an ephemeral `live-state/changed` append), `src/sdk/stream-processor-durable-object.ts:98`
(the facet's sink is `this.env.ITX.get().append(…)`), `src/itx-entrypoint.ts:28-33` (a fresh
`IterateContext` + `SessionTeardown` per `get()`). Two RPC legs + one `Stream.append` (validate,
offsets, waiters scan, N-row `onCommit` filter) per changing facet per commit. Measured: 50 enables
consumed 1,379 offsets (~1,275 deltas = M(M+1)/2); the diff alone is 1.45 ms/batch on an 89 KiB
projection. Bounded: `core-processor.ts:166` drops unnamed ephemerals and `consumesEvent` filters
before any push, so a delta does NOT re-fan-out to the other M−1 facets — the cost is M, not M².

- Proposal as filed: emit the FIRST delta of an incarnation unconditionally (the heal signal), then
  only while someone has read the seed door (`liveSnapshot()` sets a flag); `LiveState.set` returns
  a boolean. **Rejected as written by one judge and hedged by the other two:**
  `e2e/stream-woken-and-inline-live-state.e2e.test.ts:50-100` subscribes to `live-state/changed`
  WITHOUT ever calling the seed door and expects a second and third `core` delta; `live-state.ts:1-21`
  makes subscribe-without-seed first-class; `processor.ts:145-150` says "always live … costs an
  offset and a cheap diff, nothing durable" — the deal was made on purpose. It also makes a
  WRITE-side effect depend on whether a READ verb was ever called this incarnation (a hidden second
  door), and if `set` is skipped `#lastSerializedState` stops tracking `#state`, so a client that
  seeds later receives a patch against a base it never had — exactly the hazard `live-state.ts:76-81`
  warns about (fix: re-baseline on `snapshot()`). The better lever for the same cost is the SINK,
  not the semantics: the delta rides `env.ITX.get().append` with a fresh `IterateContext` per call —
  `2026-09-02-workerd-idioms.md` F4 / layering F11. Combined with T1, delta count also drops from
  per-commit to per-turnaround.
- Gain: parent DO CPU per commit ~1.2–1.7× under M ≥ 20 all-changing processors with no watcher
  (the appends are `void`-ed, so it is thread CPU, not the facet's critical path); ≈ 0 for typical
  M ≤ 5; zero with a watcher attached; the enable-time offset burn is free (ephemeral, no storage).
  The `whoami` 27.7 vs 13 ms measurement conflates pushes with deltas and cannot be attributed.
- Size: ~15–35 src lines across `live-state.ts`, `processor.ts` and — because the stream's inline
  core state is a SECOND `LiveState` holder (`stream.ts:353`, `:385`) — `stream.ts`; plus rewrites
  in 4–5 test files (`stream-woken-and-inline-live-state` e2e test 2, `processor.test.ts:612-640`,
  `processor-rules.test.ts:404-425`, `__workers-tests__/stream.test.ts:219-323` offset pins) and
  3–4 doc sites stating emit-on-every-change. Realistically 80–120 lines touched.
- Trade-off: deltas are lossy by contract, so no durable delivery is affected — but a
  subscribe-without-seed consumer is silently downgraded to one delta per incarnation.
- Dissent: 1 reject, 2 menu. Owner decision on the doctrine sentence before anything lands.

**T3 — The fetch lane caps an inline `workers.get({source})` expression between 32 and 64 KB; the runtime answers 431 with no hint.**
`src/worker.ts:77-78` (`?itx=` copied into `x-itx-expression`), `src/iterate-context.ts:173-174`
(the terminal-fetch fork puts the JSON expression in the same header), lane comment at
`src/fetch/rpc-stub-fetch.ts:42-45`. Measured: 32 KB → 200, 64 KB → 431.

- Proposal: no code. Two comment lines at `worker.ts:64-68` (required) and `rpc-stub-fetch.ts:42-45`
  (optional): the header is size-bounded — tens of KB at most locally, TIGHTER at the edge
  (Cloudflare documents ~16 KB per header / 32 KB total) — so name the source with a rule
  (`itx.site ⇒ itx.workers.get({…})`, the tour's shape) and keep the header at `itx.site`. Do not
  pin the locally measured number.
- Gain: none in speed; saves the next reader one opaque-431 hunt. Size: 2–3 comment lines.
- Dissent: 1 do-now (doc-only, far under the bar), 2 menu (zero perf gain).

### Startup and wake

**W1 — Every hibernation wake appends a durable `stream/woken`, rewrites the whole core checkpoint, pushes the wake into every default-subscribed processor and pages every default live subscriber — and that arms the 60 s quiet clock.**
_Two filings merged (latency, startup)._ `src/iterate-context-durable-object.ts:157-176`
(constructor → `appendCreatedAndWokenEvents`), `src/stream/stream.ts:190-203` (durable `woken`),
`:335-373` (one `transactionSync`: events row, `maxAssignedOffset`, the core cursor, and — because
`incarnation` is core state and moves every wake, `core-processor.ts:53-54, 176-177` — the FULL
`reduce:core:state` blob, which carries every processor's inline source, M1), `:383-386` (a core
live-state delta every wake); `subscription-delivery.ts:136-151` with `processor.ts:115-116` (a
durable matches every `consumes: undefined` row — 13 of 14 `enableProcessor` calls in `e2e/`) →
`#invokeFacet` per processor (load + class mint + `facets.get` + RPC; the facet engine then writes a
checkpoint for an event none of them reduces, `processor.ts:470-477`) and a page + borrow per
default live-stub row (`rpc-stub-directory.ts:137-138`); `#liveFacetNames.add` (`:484`) and the
borrow make `#recordActivityForQuietClock` (`:347-356`) arm the alarm, so the DO is pinned
non-hibernatable for 60 s (workerd#6800; `__workers-tests__/support.ts:64-73` measures the pin),
then the alarm aborts everything, then ~10 s to hibernate. `2026-09-02-workerd-idioms.md` F3
proposed the same change for constructor-work reasons; this adds the fan-out, the pin and the
at-least-once analysis.

- Proposal (F3(a), one step further): `ephemeral: true` at `stream.ts:201`; delete the
  `incarnation` field and the `woken` case from `CoreContract` (`core-processor.ts:53-54, 98-102,
143, 176-177`); serve it from the kv counter that already exists — `coreReducedStateSnapshot()`
  returns `{ offset, incarnation: this.#incarnation, state }` (`stream.ts:227-229`). Ephemerals
  reach only rows that NAME the type (`processor.ts:115`), so the default fan-out disappears; a
  watcher that wants wakes says `consumes: [..., "events.iterate.com/stream/woken"]`. Keep `created`
  durable (the birth certificate). Prefer the ephemeral over deleting the event: the hibernation
  tell stays observable (`hibernation-at-scale.test.ts`, the woken e2e). Precedent: `rpc-stub/attached`
  is ephemeral so "the log never claims a socket is open"; an incarnation is the same kind of fact.
- **Hard prerequisite: `2026-09-02-bugs-do-side.md` #2 (synthesis bug 3).** Today the unfiltered
  durable `woken` is the accidental wake-time trigger that re-pushes into a stream-kept cursor row an
  eviction left mid-delivery (`#deliverFromCursor` via `:223`); `alarm()` runs
  `deliverEveryCursorSubscription` but `#recordActivityForQuietClock` arms NO alarm with no live
  facets and no borrowed stubs — exactly the state after a wake. Shipped alone, an ephemeral
  `woken` strands such a row until the next commit matching its `consumes` — on a quiet stream,
  never. That is the lost-delivery window the doctrine forbids; one judge marked the filing
  `violatesDoctrine` for it. Land bug 3's fix first (arm the quiet clock while a cursor is behind;
  drive the alarm pass off the rows), then this — or add the one-line companion: kick
  `deliverEveryCursorSubscription()` once per incarnation from the first door ("one read each,
  empty when caught up" is far cheaper than N facet cold starts).
- **Second design decision the finders did not surface:** a FACET row whose push a crash cut short
  is today healed by the wake push's gap repair; after the change it heals on the next durable push
  or read — unbounded delay on a quiet stream. Mitigants: the quiesce never aborts a facet mid-call
  (`#facetWorkInFlight`), so this needs a crash or redeploy mid-push; filtered facet rows already
  behave this way. Say it in BUILD-LOG.
- Gain, per wake that lands NO durable event (reads, probes, pager closes, alarms) on a context with
  ≥ 1 default-subscribed processor or live subscriber: −60 s pinned DO (128 MB × 60 s ≈ 7.5 GB-s
  ≈ 1e-4 $ per wake; ~$1/day per 10k wakes; a sparse read-only caller every 5 min goes from ~23%
  to ~3% awake — ~7× less billed duration), −N facet cold starts (each ≥ `LOADER.get` + class mint +
  `facets.get` + 1 RPC; tens of ms cold), −M pager round trips. Per ANY wake: −1 SQLite transaction
  including the full core blob (~N × source bytes; ~100 KB with five 20 KB processors), −N facet
  checkpoint writes, −1 core delta, −1 permanent log row per incarnation (a context waking 100×/day
  carries 36k rows a year that every version-bump re-reduce rescans). **Zero pin saving for
  append-driven wakes** — those materialize the facets and arm the clock anyway; the finder's
  "webhook" example is wrong. Unmeasured in workerd; the dollar figure is a hypothesis.
- Size: ~12 src lines across `stream.ts`, `core-processor.ts`, the DO constructor comment
  (`:171-174` says the fan-out "re-establishes deliveries after hibernation" — load-bearing text);
  PLUS bug 3's fix (~15–30 lines in `subscription-delivery.ts` + the DO); PLUS **15 test files**
  reference `stream/woken`/`incarnation` (7 workers-tests, 5 e2e, 3 unit), ~23 absolute-offset pins
  shift, `stream-woken-and-inline-live-state` is a whole spec about the durable row,
  `core-processor.test.ts:30` pins "EXACTLY its eight" consumes, `hibernation-at-scale` reads
  `snap.state.incarnation` → `snap.incarnation`; PLUS 6 docs name `stream/woken` as the wake
  record (`stream.ts:15-17, 23-25` "what is worth reaching is worth recording" is explicit owner
  doctrine being reversed). A half-day change with a full e2e run.
- Trade-off: no lost delivery once bug 3 is fixed; no duplicate introduced; hibernation
  strengthened. `CoreState.incarnation` becomes a non-reduced field injected into a "reduced"
  snapshot — one fact through a second door; acceptable with a docstring.
- Dissent: 6/6 menu across both filings; one `violatesDoctrine` (shipped alone). The highest-value
  item on this menu; sequence it directly after bug 3.

**W2 — The 255 KiB React demo page is a string literal inside the API worker script, resident in every `/api` AND every DO isolate.**
`src/worker.ts:13` (import), `:49-52` (`/demo` route); `build-sdk.mjs:45-73` writes
`src/generated/demo-page.ts` (266,051 B, committed). 24% of the minified script, 17% of the upload,
for a page the product worker never uses.

- Proposal: Workers Static Assets — `build-sdk.mjs` writes `public/demo.html`; `wrangler.jsonc`
  gains `"assets": { "directory": "./public" }`; delete the route, the import and the generated
  module. `html_handling` serves `/demo` for `demo.html`, so `specs/live-state-demo.spec.ts` is
  unchanged. Check once that `createTestHarness` (`e2e/support/global-setup.ts`) and the vitest
  plugin honour `assets` (`e2e/support/solo-config.ts:19` already absolutizes `main`; `assets.directory`
  likely needs the same line); fallback is a KV put at deploy + a 2-line route. Decide: commit the
  built HTML or gitignore `public/`.
- Gain: −255 KiB of script; ~1 ms (a judge: a string literal is scanned, not parsed — not the
  finder's 2–4 ms) per cold isolate of the worker or a DO wake-from-eviction; zero warm; `/demo`
  stops invoking the worker at all. The remaining ~690 KiB of inlined strings (SDK, zod) dominate
  cold start, so the latency effect is unmeasurable; the win is shape.
- Size: ~−15 lines + 1 config line + 1 harness line + ~3 doc lines (`clean-room-api-walkthrough.md:90-91,144`),
  1 file deleted, 1 added; 5–6 files touched.
- Trade-off: n/a. Dissent: 3/3 menu (unverified harness compatibility; small absolute gain).

**W3 — zod is in the worker script twice: 303 KiB as code for eight core schemas plus 303 KiB inside the SDK string — 56% of the minified script.**
`src/stream/core-processor.ts:27` (`import { z } from "zod"`, schemas at `:39-140`),
`src/stream/events.ts:6, 70, 98, 107` (`z.ZodType` bound, `.parse`), `src/stream/processor.ts:39, 58`
(type-only), `src/stream/subscriptions.ts:24`. Classic zod does not tree-shake; every cold `/api`
isolate parses and evaluates it to validate `{ match: string, target: string | null }` at
configuration time.

- Proposal (a): `zod/mini` in the main worker, `parse`/`$ZodType` from `zod/v4/core` in `events.ts`
  (both flavours share the v4 core, so the SDK's classic schemas still pass). The core's constructs
  bundle to 18 KiB. **Not ~6 lines as filed — all three judges corrected it:** mini has no chained
  builders, and `core-processor.ts` is written entirely in them (22–32 `.optional()/.default()/
.nullable()/.regex()/.int().positive()` sites become `z.optional(…)`, `z._default(…)`,
  `.check(z.regex(…))`): a wholesale rewrite of the most-read declaration in the package,
  **~30–100 changed lines across 3–4 files**, and it introduces a second zod dialect in one package.
  Proposal (b): delete zod from the main worker — a literal `initialState()` plus the hand checks
  the door already half does; ~−40 lines but retires the "built-ins get schemas" symmetry
  (`events.ts:67-68`, `processor.ts:55`). Owner's call.
- Gain: −285 KiB (−26%) of edge script; a few ms per isolate cold start (post-deploy, idle eviction
  per colo); zero per request, per commit, per warm DO wake or hibernation wake. Proportionally
  large, absolutely modest; 1.1 MB is far under the script limit.
- Trade-off: n/a. Dissent: 3/3 menu.

### Memory and CPU

**M1 — Inline processor sources parked in the core reduced state: a hard SQLITE_TOOBIG cliff at ~2 MiB aggregate; 50× slower rule changes and 20× slower appends below it.**
`src/iterate-context.ts:304-309` (`enableProcessor` embeds the module map in the target),
`src/stream/core-processor.ts:213-223` (the reduce stores the parsed target, source included),
`src/stream/stream.ts:363-369` → `reduce-checkpoint.ts:59` (the ENTIRE core state re-put as ONE kv
value on every core change — every `provide`, every un-set on a pager close, every pause),
`live-state.ts:82` → `lib/patch.ts:46-50` (the whole state JSON-normalized twice per change), plus
L1's per-push stringify. `stream.ts:50-53` documents the ~2 MB cell cap and chunks EVENT bodies for
it; the checkpoint is one cell. Measured and **reproduced by a judge**: three 600 KB processors
enable (snapshot 1.8 MB); the fourth fails `SQLITE_TOOBIG`; afterwards `provide('itx.alias2','itx.kv')`
FAILS with the same error while a plain `append` succeeds — a project with ~3–5 bundle-sized
processors (the SDK alone is 372 KB) can no longer take a live stub from any session, subscribe, or
pause. Below the cliff: `provide` p50 0.57 → 9.70 → 29.57 ms and append 0.54 → 3.03 → 10.60 ms
for 0/1/3 × 600 KB; `core` snapshot 0.28 → 4.21 ms with one 600 KB row. A session connect +
disconnect that lent a stub is TWO core changes = 2 × 1.8 MB of SQLite writes per client today.
Zero cost for `cacheKey` producer sources (fresh row 0.59 ms).

- Proposal (the structural fix — layering F5's "structural alternative" made concrete): keep the
  source OUT of the reduced state; the log row stays the truth (already chunked, `stream.ts:498-534`).
  The reduce stores the target with the spec elided (`itx.facets.get(name).processEventBatch`) plus
  `hostedFacet: { className, cacheKey? }` on the row (fully qualified, not `hosts`); `#invokeFacet` on
  a bare name with no memo reads `stream.read(configuredAtOffset - 1, 1)` (`read` is
  after-EXCLUSIVE, `stream.ts:404-408`) to recover the source, writes `facet:<name>` once, proceeds;
  `#deleteFacetsWhoseHostingSubscriptionWasRemoved` tests `row.hostedFacet` instead of sniffing the
  target (fixes layering F2 as a side effect). **One hole to close (~5 lines):** a re-enable under
  the same name without a disable today ships the new spec on every push, so `:439` rewrites the
  memo and `:471-482` restarts the facet on new code; with a bare-name row a stale memo would run
  the OLD code forever — so in the DO's post-commit hook (`:198-206`, beside the delete check), on a
  `subscription-configured` whose row hosts a facet, write `facet:<name>` from the event payload.
  Variant worth weighing: carry the spec as a named payload field
  (`{ name, target: 'itx.facets.get(name).processEventBatch', hostedFacet: { source, className } }`)
  so the reduce elides a FIELD rather than pattern-matching an expression shape. Re-enable from the
  log, the raw-event doctrine and one-event disable all survive; the cliff moves to 2 MiB PER
  SOURCE; `snapshot()`/`subscriptions.list()` stop shipping bundles.
- Gain: above the cliff, correctness (`provide`/`subscribe`/`pause` work again). Below it, per core
  change at 1.8 MB inline: 29.7 → ~0.6 ms; snapshot 4.2 → 0.3 ms; the checkpoint from MB to KB on
  every core change; per durable append with 3 such facets 10.6 → ~0.6 ms together with L1
  (M1 alone removes the checkpoint/diff share). Zero for `cacheKey`-loaded processors.
- Size: ~50–100 lines across `core-processor.ts` (reduce + row type), `iterate-context-durable-object.ts`
  (memo-miss recovery, delete check, memo refresh), `iterate-context.ts`/`subscriptions.ts`,
  `e2e/support/client.ts:145-149` (`processorNames` regex), `core-processor.test.ts`, plus
  `docs/itx-surface-as-built.md:133/318/417`, `LAYERS.md:25/110`, and an e2e sweep of the 8 files
  that read `.target`. A new row field and a memo-miss read, i.e. a mechanism, not a deletion.
- Trade-off: n/a for delivery; one SQL read per facet materialization (memo miss), never per push.
- Dissent: 3/3 menu. **The 3-line stopgap (refuse an inline source over 64 KB at `enableProcessor`)
  is rejected** — see REJECTED.

**M2 — A processor catching up from the log checkpoints (and publishes a delta) on every 500-event page; only the last checkpoint is useful.**
`src/stream/processor.ts:470-477` (checkpoint whenever `sawDurable && advanced` — every page of
`catchUpFromLog` `:309-334` and every gap-repair page `:284-293`, not only the at-head one);
`reduce-checkpoint.ts:59` puts the STATE blob whenever the reduce changed it (every page for any
counting/mapping processor); `#rereduceIfVersionChanged` (`:418-424`) already writes once at the
end — the two catch-up paths disagree.

- Proposal: stage the checkpoint during catch-up, apps/os-style ("staged checkpoint every 8 pages",
  `2026-09-02-futures.md:103`): `if (sawDurable && advanced && (atHead || ++this.#catchUpPagesSinceCheckpoint >= 8))`.
  **Two corrections from one judge, the first mandatory:** (1) as written it is UNSAFE —
  `writeReduceCheckpoint(…, state !== stateBefore)` compares against the state at the start of THIS
  batch (`:447`); with staging, pages 1–7 may change state and page 8 not, so the cursor is written
  at page 8 while the blob keeps its pre-page-1 value → on rehydrate the engine believes 1–8 are
  reduced but the state lacks them: a LOST reduction, silent. Compare against the state at the last
  PERSISTED checkpoint (`#reducedStateAtLastCheckpoint`, updated only inside the write), or write
  the blob unconditionally on a staged write. (2) "pushes are unaffected" is false — a queued-behind
  push has `atHead === false` (`:273`), so under a burst earlier pushes defer too; scope the staging
  to the two log loops (pass the decision in) rather than a shared counter. Drop the optional
  `if (atHead) this.publishLiveState()` half (contradicts `:479-485`, removes a watcher's progress
  ticks, no measured gain). Rewrite the Rule 4 comment at `:461-466` ("ONE persist per range") and
  `reduce-checkpoint.ts:11`.
- Gain: ~8× fewer state-blob puts and delta appends during a multi-page catch-up or gap repair —
  a once-per-processor-lifetime cost (first enable on a long log, a slug change; post-eviction the
  checkpoint is READ and only the tail pages). Per page saved: one JSON serialize + kv put of the
  state (200 KiB ≈ 1–3 ms) against a page that already costs a 500-row read + 500 reduces + 500
  `processEvent` calls (5–20 ms) — ~10–25% of a rare rebuild's wall clock; negligible in billed row
  writes. Steady state: zero. No log or fixture in the package exceeds one page.
- Size: ~10–15 lines in `processor.ts` (counter + last-persisted-state field or a caller-passed
  flag, guard, two comment edits) + one row in `processor-rules.test.ts`.
- Trade-off: **DUPLICATE, bounded, acceptable under the performance doctrine** — an eviction
  mid-catch-up re-reduces ≤ 8 pages (≤ 4,000 events, pure) and re-runs their `processEvent`
  effects, the at-least-once contract processors already sign. Never lost: the cursor never
  persists past what was reduced (once correction (1) is applied).
- Dissent: 3/3 menu; unanimous that the gain is unobserved in this codebase and the invariant
  change needs the owner's nod.

---

## REJECTED

No finding was rejected whole — the judges confirmed the mechanism of all 20. Parts of accepted
findings that were rejected, each in one line:

- **M1's 3-line stopgap — refuse an inline `source` over 64 KB at `enableProcessor`/`facets.get`.**
  It would refuse the 372 KB SDK bundle the finding itself cites as the realistic processor; an
  indirection constant; a speculative guard against trusted clients. If a stopgap is wanted it is a
  docs pointer to the `cacheKey` producer path, not a limit.
- **L1 (experiments filing), part (b): `hash(memo.source) === hash(spec.source)` in place of the two stringifies.**
  `memo` is kv-fresh on every call, so the WeakMap misses and this ADDS a 2.3 ms/400 KB djb2 where
  today's compare costs 0.3 ms — negative by the finding's own numbers.
- **L1 (throughput filing), part (2): fold `sourceVersion` into the big `facet:<name>` memo and compare after reading it.**
  Keeps the O(source) kv read + deserialize on the hot path (the "~0 after" claim is overstated ~3×)
  and deletes the version key idioms F1 relies on; doing it first then F1 is churn.
- **T2 as written: "first delta of an incarnation unconditional, the rest only while seeded".**
  Breaks the shipped subscribe-without-seed contract (`stream-woken-and-inline-live-state` e2e
  test 2 waits for later `core` deltas with no seed; `live-state.ts:1-21`); makes an emit depend on
  whether a read verb was ever called; drifts `#lastSerializedState` if `set` is skipped.
- **T1 as written: take-and-clear `#pushedEventBatches` at chain-step start.**
  `#deliverFromCursor` reads that entry to hand ephemerals to a caught-up cursor target; clearing it
  first loses them ("one push, unredeliverable"). Also lacks the row-identity guard against a stale
  chain step stealing the replacement row's batch.
- **M2's optional half: publish the live-state delta only on the at-head page during catch-up.**
  Contradicts the `:479-485` contract, drops a watcher's rebuild-progress ticks, no measured gain;
  and M2's own `state !== stateBefore` compare is unsafe under staging without the fix above.
- **L4 alternatives: a rule-pick cache keyed by the printed call; precomputed specificity.**
  Printing costs more than the scan it would save; the scan is sub-µs at realistic R.
- **W1 variant: delete `stream/woken` outright (the kv counter is the truth).**
  ~10 lines fewer, but the hibernation tell stops being observable to a watcher naming the type;
  the ephemeral keeps `hibernation-at-scale` and the woken e2e honest.
- **The throughput filing's e2e evidence ("83 ms for 50 facets, `whoami` 27.7 ms") as support for the hashing tax.**
  At 500 B sources it measures `LOADER.get` + class mint + `facets.get` + RPC + checkpoint (idioms
  F1), not hashing; it stays in the table as a measurement of F1's cost.
- **L2 as sized ("~15 lines, 2 files").** The mechanism stands; the size does not — the edge
  context holds no env, so `ITX_KV` threads through 4–8 files. Re-filed at its real size.

---

## What to measure next

Ordered by how much a surprise would force a redesign. Every number in this file came from one
laptop; these are the runs that would make them real.

1. **Delivery at the 10,000-subrequest budget** (`2026-09-02-futures.md` §3.9). apps/os measured a
   SILENT stop at exactly 10,000 deliveries over one `/api` WebSocket (12,000 events at 120/s;
   appends kept succeeding, the socket stayed open, only a new physical socket recovered). The clean
   room's lent stub is still invoked over a Workers-RPC leg from the DO. Run one connected
   subscriber past 12,000 pushes on one incarnation and count subrequests; establish whether the
   pager/re-lend cycle (a fresh leg) resets the budget, as the design hopes. Same run, the depth
   limit: a facet's live-state delta is exactly an `append → deliver → append` chain
   (facet → `ItxEntrypoint` → DO append → N-row fan-out); apps/os hit `Subrequest depth limit
exceeded` on that shape and skipped an event permanently.
2. **Facet fan-out attribution.** The 1.7 ms/facet at 50 processors is unattributed. Time
   `LOADER.get`, `getDurableObjectClass`, `ctx.facets.get`, the RPC and the checkpoint put
   separately, at 500 B and at 300 KB sources — this decides F1's rank and settles the 3× spread
   between the node hashing benches (0.64 vs 1.93 vs 2.3 ms at 300 KB).
3. **Cold `LOADER.get` with and without `processor.js`**, in the workers pool (DO-NOW 2 landed on
   node numbers plus workerd source reading). If the difference is < 2 ms, the comment should say
   so; if > 5 ms, `runScript`'s per-lambda cold isolate deserves a line in the docs.
4. **The wake bill.** One read-only probe every 5 min for an hour on a context with three
   default-subscribed processors: billed duration, facet materializations, log rows added. The
   "~$1/day per 10k wakes" and "7× duty cycle" in W1 are hypotheses until this runs. Repeat with
   `consumes` set on the rows to see the ceiling.
5. **Push coalescing under backlog** (T1): N commits during a 500 ms-blocked facet — invocation
   count, checkpoint puts, wall time to head — before believing 2× or 10×.
6. **Reconnect storm at P = 200 pagers** (L3): DO CPU per attach and total, in workerd. If it is
   under 1 ms per attach the index is not worth its second source of truth.
7. **A rebuild of a 200 KiB-state processor over a 100k-event log** (M2): pages, seconds, kv bytes
   written. No fixture in the package exceeds one page today.
8. **The cliff on the edge, not locally.** M1's SQLITE_TOOBIG at ~2 MB reproduced on local workerd;
   confirm the same cell cap on deployed DO SQLite before designing around the number.
