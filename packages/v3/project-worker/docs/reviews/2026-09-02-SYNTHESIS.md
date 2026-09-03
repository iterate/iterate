# Review round, 2026-09-02 — synthesis

> Eight reviewers over the clean room as of `44a286376` (the surface after the day's six commits:
> one front door `provide`, one facet door, `workers.get`, inline sources, `cacheKey` producers,
> `env.ITERATE_CONTEXT`, `ItxEntrypoint` = `get` + `fetch`). Six ran as independent agents; two
> (smells, performance) ran as a find → three-judge adversarial verify → synthesize workflow. A
> twelfth-hand pass by twelve Codex reviewers was launched and died at the OpenAI workspace's
> credit wall before any of them finished reading (`docs/reviews/codex/` is empty; the prompts and
> driver are ready to relaunch). Nothing in `src/` was changed by this round except three
> performance DO-NOW items (section 5) and the demo page's own regression; every bug but one has
> a red proof marked `test.fails`.

The reports, each self-contained:

| Report                             | Lens                                            | Findings                               |
| ---------------------------------- | ----------------------------------------------- | -------------------------------------- |
| `2026-09-02-bugs-do-side.md`       | stream, core reduce, delivery, facets, loader   | 6 confirmed, 6 red proofs, 7 suspected |
| `2026-09-02-bugs-edge-side.md`     | edge verbs, sessions, pagers, live-state client | 6 confirmed, 6 red proofs, 6 suspected |
| `2026-09-02-layering.md`           | the onion, ownership, duplication               | 13 findings, 12-item keep-list         |
| `2026-09-02-workerd-idioms.md`     | Workers RPC, DO, Loader, capnweb idioms         | 10 findings, 17 justified divergences  |
| `2026-09-02-narrative-failures.md` | comments, docs, test titles vs code             | 42 findings (12 critical)              |
| `2026-09-02-futures.md`            | apps/os + this branch's record                  | ~110-row ledger, 12 awkward items      |
| `2026-09-02-smells.md`             | naming and concept clarity                      | see the file                           |
| `2026-09-02-performance.md`        | latency, throughput, wake, memory               | see the file                           |

---

## 1. Bugs — thirteen; all fixed by 2026-09-03 (the last two with their own commit)

The proofs live in `src/review-bugs-*.test.ts`, `__workers-tests__/review-bugs-*.test.ts`,
`e2e/review-bugs-*.e2e.test.ts`, each with a `// BUG:` header. On 2026-09-03 every bug with a fix
under ten lines was fixed and its proof flipped from `test.fails` to `test` (commit `5154b70a4`);
bugs 1 and 3, the two over ten lines, followed in their own commit (worker-loader.ts
`loaderIdGenerations` + the facet's loaded-identity marker; the row-driven alarm pass + the cursor
lane arming its own alarm). Ordered by severity across both reports.

| Status            | Bugs                                                            |
| ----------------- | --------------------------------------------------------------- |
| fixed, proof live | 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12; 13 fixed without a proof |
| still red         | none                                                            |

| #   | Bug                                                                                                                       | Where                                              | Proof lane |
| --- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------- |
| 1   | A producer that throws inside `getCode` poisons its loader `cacheKey` forever; the facet memo pins the dead key           | `context/worker-loader.ts:127-160`                 | e2e        |
| 2   | An expression rule's undo un-sets a LIVE provider's rule at the same match                                                | `iterate-context.ts:205-210`                       | e2e        |
| 3   | A cursor subscription whose first delivery an eviction interrupts is stranded; nothing arms the alarm for a cursor target | `stream/subscription-delivery.ts:156-164, 274-275` | workers    |
| 4   | A subscription re-configured mid-delivery keeps delivering to the OLD target (`call ??=`)                                 | `stream/subscription-delivery.ts:260-263, 329`     | workers    |
| 5   | A two-step target `itx.<alias>` is never delivered to (head/method split off by one)                                      | `stream/subscription-delivery.ts:241`              | workers    |
| 6   | `subscribe` refused by the DO leaves the callback lent (no rollback; `provide` has one)                                   | `iterate-context.ts:260-276`                       | e2e        |
| 7   | `subscription-configured { target: null }` deletes a facet another row still hosts                                        | `iterate-context-durable-object.ts:215-234`        | workers    |
| 8   | A pager reconnect rejects the in-flight page with `RPC_STUB_OFFLINE` instead of answering it                              | `context/rpc-stub-directory.ts:210-242`            | workers    |
| 9   | Replacing a live target with an expression target never recalls the lend (both verbs)                                     | `iterate-context.ts:200-210, 277-285`              | e2e        |
| 10  | `subscribe`'s handle is a no-op for the array spelling of an `rpcStubs` target                                            | `iterate-context.ts:278`                           | e2e        |
| 11  | Live-state client drops a delta that arrives during a gap heal and never re-triggers                                      | `client/live-state-client.ts:53-69`                | unit       |
| 12  | Rewrite-rule tie-break is configuration-order dependent for structurally equal pinned object args                         | `context/itx-expression-rewriting.ts:83-101`       | unit       |
| 13  | A failed core-checkpoint write leaves phantom core state in memory (reduce mutates fields inside the transaction)         | `stream/stream.ts:359`                             | none yet   |

Where they cluster: bugs 2, 6, 9, 10 are one seam (who recalls a lend and who un-sets a rule, in
`iterate-context.ts`), which the layering review independently proposes to collapse into one
private `#lendAndAppend`. Bugs 3, 4, 5 are the cursor lane of the delivery loop. Bug 1 is the day's
`cacheKey` change meeting Cloudflare's "a failed `getCode` is cached like a success" rule; the
suggested fix is to produce the modules before `LOADER.get` and hand it literal modules under the
caller's key, which also answers the idiom review's re-entrancy worry.

Suspected and not reproduced (documented in the two reports): the dead `inFlight` counter in the
rpc-stub directory, ephemerals consulting the idempotency column, `coreLiveStateSnapshot`'s
unusable `rev: 0`, subscription replace orphaning a facet, rule-aliased processor targets escaping
the removal effect, the swallowed `#unsetWhatNamesRpcStub` append.

---

## 2. Structure — the bouquet, ordered by leverage

From the layering and idiom reviews. Recommendations only; each is a deletion or a merge.

1. **Delete the `itx.facets.delete` built-in.** Zero callers; and wrong: deleting a hosted
   facet leaves the row whose target still carries the spec, so the next commit re-hosts a
   fresh facet as if it had resumed. Keep the DO's private `#deleteFacet`. (layering F1, 18 lines)
2. **Move the event vocabulary down and split the engine out.** `consumesEvent`, `ScannedRange`,
   `ProcessorContract` into `events.ts`; `ProcessorEngine` into its own file. Kills the three
   upward imports and the `events.ts` ⇄ `processor.ts` cycle; `processor.ts` goes 560 → ~140.
   (layering F3, F8)
3. **One `#lendAndAppend` for `provide` and `subscribe`.** Same five steps written twice, rollback
   only in one. Fixes bugs 6 and 9 as a side effect. (layering F4, 35 lines)
4. **Let `ctx.facets` own the facet memo.** The facet door awaits `loadConfinedWorker` on every
   call, including every subscription push; the runtime documents the startup callback as running
   only when the facet is cold. Move the load inside the callback; the "deleted while its source
   loaded" race check goes with it. Verify first that a producer expression may call back into
   `this.invoke` from inside the callback. (idioms F1, about 25 lines net deletion)
5. **Dispose in the stateless-worker door.** `WorkerStub`, the entrypoint stub and the result are
   dropped undisposed on every `workers.get` and `runScript`; the facet door learned this the hard
   way and its comment records the incident. (idioms F2, 8 lines)
6. **Make `stream/woken` ephemeral.** The constructor writes a durable row and starts the delivery
   fan-out on every wake; the incarnation counter already lives in kv. Do not wrap the fan-out in
   `blockConcurrencyWhile`: a facet target reaches back through `env.ITX` into the same DO.
   (idioms F3)
7. **The DO decodes a layer-3 row's grammar to decide a layer-4 fact** (the hosting check in
   `#deleteFacetsWhoseHostingSubscriptionWasRemoved`). Cleaner: the facet-door spec carries the
   fact, or the removal effect moves to the SDK host. (layering F2)
8. **`enableProcessor` copies the whole source into the row, the core checkpoint and every
   live-state delta.** Elide the spec in `projectLiveState`; point large sources at the
   `cacheKey` producer path. (layering F5, about 10 lines)
9. **`ReachableContext` is a third name for a context** defined in the stream layer to paper over
   one sync method. (layering F6)
10. **`armNoLaterThan` never consults `getAlarm()`**, so a fresh incarnation can push a due retry
    from 5 s to 60 s. (idioms F5)
11. **`ItxEntrypoint.get()` hands loaded code a throwaway `SessionTeardown`** nothing disposes;
    `env.ITX.get()` stubs are never disposed on the SDK's per-append path. (layering F11, idioms F4)
12. Smaller: the terminal-`fetch` shape is pattern-matched in four places (layering F7); two
    post-commit doors (`Stream.append` and the DO's `append`, layering F9); a subscription's
    delivery state in four containers (layering F10); fetch-upgrade sockets accepted and never
    reaped (idioms F6); the manual close-echo is dead at this compat date (idioms F8); loaded
    isolates get a hardcoded compat date (idioms F9).

**Do not re-litigate** (both reviews agree): the two vocabularies kept apart; the DO owning the
un-set of a live stub's rule; the empty `FacetHandle`/`RpcStubHandle` brands; `InvokeHandle` as a
genuine RpcTarget with the prototype hop; the core reduce inside the commit transaction; the
ephemeral zero-write path; both `cd`s; `enableProcessor`/`disableProcessor` as the one durable
pair; the code-over-name error doctrine; the `cacheKey` billing note; the WORKAROUND fence in the
fetch module; the 17 platform divergences the idiom review lists as justified.

---

## 3. Narrative — what still lies

42 findings; the critical ones a new reader hits first:

- `LAYERS.md:140` still says `disableProcessor` appends and then calls `itx.facets.delete`.
- `docs/itx-surface-as-built.md` contradicts itself between §12 B (producer sources deleted) and
  §12 F (back behind `cacheKey`); F is true. Fixed in the same commit as this synthesis.
- Six source headers still name `load` or `rewrite`, including the docstring that promises "a
  reader of this file sees the whole surface" (`iterate-context.ts:108`), the rules header
  (`itx-expression-rewriting.ts:4`) and `dotted-path-proxy.ts:7`.
- The synthesis proposal doc that the as-built doc points at as "the design record" argues for
  the API that lost (`rewrite` as the verb, `ProvidedRpcStubHandle`), retracted only in its §9.
- Five docs dated today describe code that does not exist, three under false "LANDED" banners
  (`plan-argument-matched-mounts.md`, `proposals/guard-audit.md`).
- The tutorial's flagship snippet cannot work; four e2e files are named for `itx.load`.
- The one naming violation in source: `#undo` in the two handle classes.

---

## 4. Futures — what will be awkward

From the ledger (about 110 features from apps/os and this branch's record). Roughly three
quarters fall out of today's six doors. The awkward ones, ranked by how much a late discovery
forces a redesign, each with the smallest change that makes it fit:

1. **Authority.** Nothing carries an actor; `authenticate()` is a no-op and `projects.get`
   reaches any project. Smallest fit: resolve `{ actor, grants }` through the existing `FALLBACK`
   seam, enforce at `projects.get`, stamp `metadata.actor` at the edge. Per-call authorization
   inside a project is explicitly not wanted. The genuinely new layer is a browser session for a
   project's own app.
2. **Time.** Facets have no alarms (workerd#6810) and the parent alarm proxy was deleted, so the
   scheduler, LLM deadlines, debounce, sweeps, heartbeats and approval expiry have no home.
   Smallest fit, about 60 lines and no new door: an `itx.alarms` built-in reduced as one more core
   slice, firing as an ordinary `alarm/fired` event.
3. **Ingress and fetch rules.** Fully specified in the parked `plan-one-fetch-rules.md`; the one
   open decision should follow the landed doctrine, a `fetch-rule-configured` event family.
   Genuine residue: static assets, for which no design exists anywhere.
4. **The build tier.** `itx.build` as a hosted facet with an artifact cache, the bundler as a
   second deployed worker, one `budgetMs` field and a `BUILD_IN_PROGRESS` code. Decide the
   lockfile-in-the-key question now.
5. **Secrets.** The write door was deleted and there is no origin pin; two placeholder grammars
   already coexist in the repo and whichever survives gets baked into userspace.
6. Self-description (`instructions`, `types`), platform bindings with no door (`AI`, R2, Email,
   Browser, containers), cross-context copy without provenance, delivery at the 10,000-subrequest
   budget (a measurement, not a fix), fan-out to many live clients, deletion and GC, observability
   and metering.

The ledger also lists 31 things the owner's record says not to copy, with citations.

---

## 5. Smells and performance

Produced by the find → three-judge verify → synthesize workflow: 48 findings, 21 do-now, 27 menu,
0 rejected. `2026-09-02-smells.md` and `2026-09-02-performance.md` carry the full lists with
every judge's dissent; the highlights:

**Performance** (five finders, one of them measuring on a laptop; every number an order of
magnitude). The steady path is already fast: a built-in call is about 0.3 ms round trip on local
workerd, a durable append 0.4 ms, a rule chain adds microseconds. What is expensive is structural:
a processor's source text parked in the core reduced state is re-serialized on every facet push,
and a durable `stream/woken` fans out a push to every default-subscribed processor on every wake.
Two claims from earlier reviews were corrected by measurement, most notably the layering review's
"the source rides every live-state delta": it does not, the enable delta was about 1 KB, and the
amplification is elsewhere.

- **Applied in this round (three of the four DO-NOW items, all green on every lane):**
  `LentRpcStub`'s step walk no longer awaits mid-chain, so an n-step call onto a client's stub is
  one client round trip (capnweb pipelines the steps); the ~370 KB processor SDK is injected only
  into isolates whose modules import `./processor.js`, so a stateless worker skips compiling it;
  `LiveState.set` returns at once when handed the identical object.
- **Not applied, reclassified:** "a failed core-checkpoint write leaves phantom core state in
  memory" is a bug on a storage-failure path, not a green-path win; it joins the bug list as
  number 13, unproven (the proposal includes the shape of the workers-lane proof).
- **The menu** is grouped by latency, throughput, startup and wake, memory and CPU, and ends with
  "what to measure next", led by the delivery loop at the 10,000-subrequest budget and the
  ~2 MB SQLite cell cap that reproduced locally.

**Smells** (two finders: naming, concept). The vocabulary is mostly right; what is left is residue
from deleted designs (the capability table, `routing.ts`, transport ids) and one word carrying two
or three referents (`host`, `target`, `ref`, `sub`, `hooks`, `resolve`). 17 DO-NOW items, about
95 lines net deletion, each a rename or a deletion of dead state, none applied in this round (the
owner asked for a pass, not a sweep); they are listed as a checklist in the report. Two of them
change behaviour and deserve a look first:

- `enableProcessor` cannot carry a `cacheKey`, and the hosted `/demo` page still seeded its
  processor source through kv with a producer expression, so after today's inline-only and
  cacheKey changes the page failed on the refusal message. Fixed in the commit after this one: the
  demo passes its modules literally (the Playwright spec is green again); `enableProcessor`'s spec
  shape is the smells report's item 9.
- Two of the three "stub not reachable" exits in the rpc-stub directory are uncoded, so the
  delivery loop logs the designed heal path as a dropped push (two lines).

## 6. Suggested order of work

1. Fix the twelve bugs, one commit per seam: the lend/un-set seam in `iterate-context.ts`
   (bugs 2, 6, 9, 10), the cursor lane (3, 4, 5), the producer poisoning (1), the removal effect
   (7), the pager swap (8), the client (11), the tie-break (12). Each flips its `test.fails`.
2. The four structural deletions with a fix attached: `facets.delete`, `#lendAndAppend`, the
   engine split, the facet memo handed to `ctx.facets`.
3. The narrative sweep: the six headers, `LAYERS.md:140`, history banners on the stale plans.
4. Decide time and authority before any product feature lands on the clean room; both are cheap
   now and expensive after the log has history without an actor.
