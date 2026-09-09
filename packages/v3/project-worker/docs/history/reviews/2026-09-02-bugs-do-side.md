# DO-side bug hunt — 2026-09-02

Six confirmed defects on the DO side (`iterate-context-durable-object.ts`, `stream/`, `context/`),
each with a RED test marked `test.fails`; none is fixed here. Four are in the **subscription
delivery loop and its recovery story** — a cursor subscription can lose its at-least-once guarantee
across an eviction, keep delivering to a target that was replaced, or never be delivered to at all
if its target is a two-step `itx.<alias>` (the spelling every `provide` mints). The fifth is at the
**loader**: the producer expression that `workers.get({ source, cacheKey })` runs inside `getCode`
(added today) poisons its low-cardinality `cacheKey` **permanently** on any failure — the runtime
caches the rejection and never runs the producer again, so one transient miss bricks that worker or
facet. A sixth, lower-severity one is in the rewrite-rule table: two differently-spelled but
structurally equal pinned object args are two map rows that both claim a call, so which one wins is
decided by configuration order.

Everything below reproduces on `wip/kernel-wayfinder-2026-07-30` @ `38eccab36` + working tree.

---

## Confirmed, ranked by severity

### 1. A failed load poisons its loader `cacheKey` forever — a producer expression that throws bricks the worker or facet

- **Defect:** `src/context/worker-loader.ts:127-131` (the producer runs inside `getCode`) with
  `src/context/worker-loader.ts:135-160` (`env.LOADER.get(id, getCode)`).
- **Mechanism.** Today's change moved the source producer _inside_ Cloudflare's `getCode` callback
  ("the producer runs inside `getCode`, i.e. only on a cold isolate"). The runtime caches a **failed**
  load under its id exactly as it caches a successful isolate: every later `LOADER.get` with that id
  replays the _original_ error and never calls `getCode` again. Two properties make it permanent
  rather than a retry-and-move-on:
  - the id is `${kind}:${deploy}:${owner}:${cacheKey|contentHash}` and is _deliberately_
    low-cardinality ("the cacheKey IS A DOLLAR AMOUNT … NEVER a nonce, timestamp, request id"), so
    "just use a new key" is the one recovery the loader doctrine forbids;
  - a facet pins `{ source, cacheKey }` in its startup memo
    (`src/iterate-context-durable-object.ts:430-442`), so every later `itx.facets.get(name)` — the
    whole processor materialization path — re-hits the dead key with no way to ask for a re-run.

  The trigger is ordinary and transient: the producer reads a build artifact that has not landed
  yet, calls a lent builder stub that is momentarily `RPC_STUB_OFFLINE`, or appends to a paused
  stream. One such moment and that build id is dead for the life of the loader cache.

- **Proof:** `e2e/review-bugs-do-side.e2e.test.ts` — "a cacheKey whose producer threw once loads
  fine when the producer would now succeed". Producer = `itx.kv.get('build:cap.js')`; the first load
  fails because the artifact is missing, the artifact is then written _and read back_, and the
  second load under the same key still rejects with the **original** message
  (`workers.get: a source is its modules, and needs a "cap.js" main module`).
  (Proved in the e2e lane on purpose: a failing dynamic-worker load leaves an unhandled rejection
  inside the runtime that the in-process workers lane reports as a lane error. The platform half was
  verified separately with a raw `env.LOADER.get` probe — both a throwing `getCode` and a `getCode`
  that resolves to modules which fail to start poison the id identically.)
- **Suggested fix.** Do not let a failed `getCode` become the cached answer: either salt the loader
  id with a small _attempt/generation_ counter kept beside the facet memo and bumped when a load
  fails (still low-cardinality — it moves only on failure), or hold the producer _outside_
  `LOADER.get` (produce the modules first, then pass literal modules with the caller's `cacheKey`),
  so a producer failure never reaches the loader at all.
- **Blast radius.** Every producer-expression load — `itx.workers.get({ source: <expr>, cacheKey })`,
  `itx.facets.get(name, { source: <expr>, cacheKey })`, and therefore every processor enabled from a
  built artifact. Once poisoned, the only recoveries are a deploy (the deploy id is in the id) or a
  new `cacheKey`, which costs a fresh billed Dynamic Worker identity.

### 2. A cursor subscription whose first delivery an eviction interrupts is stranded — at-least-once lost

- **Defect:** `src/stream/subscription-delivery.ts:156-164` (`deliverEveryCursorSubscription`) +
  `:274-275` (the first cursor is adopted with `writeKv: false`), with
  `src/iterate-context-durable-object.ts:347-356` (`#recordActivityForQuietClock` arms nothing).
- **Mechanism.** Two halves.
  - `deliverEveryCursorSubscription` iterates `#cursors` — the **cursor table**, seeded from kv —
    not the subscription **rows**. A subscription's first cursor is adopted in memory only ("the
    first durable delivery writes it"), so an eviction _before that first ack_ leaves kv with no
    cursor and the row invisible to the alarm's recovery pass forever.
  - Nothing had armed an alarm anyway: `#recordActivityForQuietClock` returns early unless a facet
    is live or an rpc stub is borrowed, and a cursor target (a loaded entrypoint, a sibling context,
    a remote) is neither.

  So the committed events sit undelivered until some _later_ commit happens to match the row's
  `consumes` — on a quiet stream, never. This is exactly the case the DO's own alarm comment claims
  to cover: "anything an eviction left behind mid-delivery runs here".

- **Proof:** `__workers-tests__/review-bugs-do-side.test.ts` — "the alarm's cursor pass recovers a
  subscription whose first delivery an eviction interrupted". Incarnation 1 parks on a delivery that
  never acks; the test asserts kv holds no cursor and `storage.getAlarm()` is `null`; incarnation 2
  over the same storage runs `deliverEveryCursorSubscription()` and delivers **nothing** (expected
  `[1, 2]`, got `[]`) even though the row survived the "eviction".
- **Suggested fix.** Drive the alarm pass off the ROWS
  (`stream.coreReducedState.subscriptions`) rather than `#cursors`, materializing a cursor for any
  row that has none; and arm the quiet clock while any cursor subscription is behind (add "a cursor
  subscription is behind" to `#recordActivityForQuietClock`'s "is there anything to come back for"
  test, or arm from `#deliverEventBatch` when it routes to the cursor lane).
- **Blast radius.** Every stream-kept-cursor subscription — the whole non-facet, non-stub delivery
  lane (`itx.workers.get(…).processEventBatch`, `itx.cd('/x').append`, remotes). Silent event loss
  on a quiet stream; the row still reads healthy in `itx.subscriptions.list()`.

### 3. A subscription re-configured mid-delivery keeps delivering to the OLD target

- **Defect:** `src/stream/subscription-delivery.ts:260-263` (`#deliverFromCursor(name, call?)`) and
  `:329` (`call ??= (await this.#evaluateItxExpressionTargetHead(row.target)).call`), with `:332`.
- **Mechanism.** `#deliverFromCursor` takes the already-evaluated `call` as a parameter and only
  ever fills it with `??=`. When a `subscription-configured` replaces the row mid-flight, the loop
  _does_ notice (`if (!this.#cursors.has(name)) continue;` — `#forgetSubscription` dropped the
  cursor) and picks up the new row and a fresh cursor, but `call` is already bound to the **old**
  target, so `??=` never re-evaluates. Meanwhile the replacement's own delivery attempt returned
  early on `#cursorDeliveryRunning`, so nothing else is left to serve the new target: the old target
  keeps receiving every subsequent batch and the new one receives nothing, indefinitely.
- **Proof:** `__workers-tests__/review-bugs-do-side.test.ts` — "a subscription re-configured
  mid-delivery delivers the next batch to the NEW target". Expected
  `{ sinkA: [[1]], sinkB: [[2]] }`, got `{ sinkA: [[1], [2]], sinkB: [] }`.
- **Suggested fix.** Re-evaluate the target whenever the loop re-reads the row: drop `call` to
  `undefined` on the `!this.#cursors.has(name)` branch (or key the memo by the row's
  `configuredAtOffset` and invalidate it when that changes).
- **Blast radius.** Any cursor-lane subscription re-pointed while busy — the "swap the archive
  context", "move a processor to a new source" flows. Data keeps flowing to a revoked target
  (a mis-delivery, not just a drop) and the new target is silently dead.

### 4. A two-step subscription target (`itx.<alias>`) is never delivered to

- **Defect:** `src/stream/subscription-delivery.ts:241` —
  `const method = typeof last === "string" && target.length > 1 ? last : undefined;`
- **Mechanism.** The head/method split peels a trailing **string** step off as "the method to call
  on the head", guarded only by `target.length > 1`. For a two-step target `["itx","sink"]` that
  leaves the head as `["itx"]` — a bare scope root that no built-in and no rewrite rule can ever
  match — so the evaluation dies in `NO_ITX_EXPRESSION_MATCH` before the target is reached, once per
  commit, silently (only `reportIssue`). The guard is off by one: only a target of **three** steps or
  more has a head to evaluate; a two-step target names the callee itself.
  This is not an exotic spelling — it is the one `provide` mints:
  `itx.provide('itx.sink', stub)` writes the rule `itx.sink ⇒ itx.rpcStubs.get('itx.sink')`, and
  `subscribe({ target: 'itx.sink' })` is the documented composition ("a rule whose target names
  another rule classifies correctly because it evaluates to the same handle", LAYERS.md layer 3).
- **Proof:** `__workers-tests__/review-bugs-do-side.test.ts` — "a two-step subscription target
  (itx.<alias>) is delivered to". Nothing is delivered, and the expressions actually evaluated are
  `["itx", "itx"]` — the bare scope root, twice (the configured-row head-check and the batch).
- **Suggested fix.** Change the guard to `target.length > 2` — a two-step target evaluates whole and
  is root-called through `callOn` (its `applyRoot`), exactly like a target ending in a call step.
- **Blast radius.** Every subscription whose target is a rewrite-rule alias. Note the _lent-callback_
  path is unaffected: `subscribe({ target: <live fn> })` writes the three-step
  `["itx","rpcStubs",["get","subscription:<name>"]]` itself, so this bites hand-written and
  `provide`-aliased targets only — which fail with no user-visible error at all.

### 5. `subscription-configured { target: null }` deletes a facet another row still hosts

- **Defect:** `src/iterate-context-durable-object.ts:215-234`
  (`#deleteFacetsWhoseHostingSubscriptionWasRemoved`).
- **Mechanism.** The removal effect reads the removed row's target, sees
  `facets.get(<name>, <spec>)`, and calls `#deleteFacet(<name>)` unconditionally. Nothing consults
  the _other_ rows — which are right there, in the same pre-commit `subscriptionsBeforeCommit` map
  the function was handed. `#deleteFacet` is `ctx.facets.delete(name)` plus both kv keys, so the
  facet's **storage** goes with it: a surviving processor row silently rebuilds from offset 0 and
  re-runs every effect it ever ran (double effects), and a spec-less `itx.facets.get(name)` answers
  `NO_FACET`.
- **Proof:** `__workers-tests__/review-bugs-do-side.test.ts` — "removing one hosting subscription
  keeps the facet another row still hosts". Two rows host `shared`; the facet is bumped to 2;
  removing row `a` leaves core state `{ b }` but `facet:shared` gone and the count back to `0`
  (expected `{ memoKept: true, count: 2 }`, got `{ memoKept: false, count: 0 }`).
- **Suggested fix.** Delete only when no _remaining_ row hosts that facet: after the commit, check
  `this.#stream.coreReducedState.subscriptions` for another row whose target is
  `facets.get(<name>, …)` and skip the delete if one exists.
- **Blast radius.** Any context with two subscriptions over one facet (a processor plus an audit or
  mirror row). Silent state loss plus replayed side effects — the worst failure mode in the
  processor contract, and it is triggered by an ordinary `disableProcessor`.

### 6. Rewrite-rule tie-break: two rows with equal-length, equal-pin matches both claim a call

- **Defect:** `src/context/itx-expression-rewriting.ts:83-101`
  (`pinnedArgCount` / `moreSpecific` / `pickItxExpressionRewriteRule`), with
  `src/context/expression.ts:93-102` (`print` preserves object key order) and
  `src/lib/patch.ts:22-32` (`jsonEqual` does not).
- **Mechanism.** A match's canonical spelling is JSON5, which **preserves** key order, so
  `itx.ai.run({model:'x',fast:true})` and `itx.ai.run({fast:true,model:'x'})` are two distinct rows
  of the rewrite-rule MAP. But `matchItxExpressionPrefix` compares pinned args with `jsonEqual`,
  which is order-**insensitive**, so both claim the same call — with equal length and equal pin
  count. `moreSpecific` is a strict `>` on `(length, pins)`, so the tie keeps whichever rule the scan
  saw first, i.e. whichever was configured first. The later rule is silently dead while
  `itx.rewriteRules.list()` shows it present, and re-providing "the same" match with the keys typed
  in a different order does **not** replace — contradicting both the MAP contract and the module
  header's own rule 3 ("two rules with DIFFERENT matches of equal length and pins cannot both match
  one call").
- **Proof:** `src/review-bugs-do-side.test.ts` — "a pinned object arg picks the same rule whatever
  order the rules are scanned in". `pick([first, second])` → `itx.openai.chat`;
  `pick([second, first])` → `itx.anthropic.chat`.
- **Suggested fix.** Canonicalize object args key-sorted in `print` (one map row, so a re-provide
  really replaces) — or, if the spelling must be preserved verbatim, break the tie deterministically
  in `moreSpecific` (e.g. by canonical match string) and say so.
- **Blast radius.** Only rules that pin object literals. No data loss; a confusing "my rule does
  nothing and the table says it is there" and an order-dependent dispatch.

---

## Suspected, not reproduced

- **`returnBorrowedRpcStubs` ignores the `inFlight` counter it maintains.**
  `src/context/rpc-stub-directory.ts:82,120,141,162` increment and decrement
  `#borrowedRpcStubs.get(k).inFlight`, and **nothing ever reads it** — the facet side has exactly
  this guard (`#facetWorkInFlight`, `iterate-context-durable-object.ts:365,374`) and the stub side
  does not. Probed in the workers lane: with a client stub call parked for >60 s, the quiesce alarm
  returns the borrowed stub anyway (`borrowedRpcStubs` 2 → 0) and
  `rpcStubTransportState().dormant` flips to `true` while the call is outstanding. **But the parked
  call still resolved correctly** once released, so I could not demonstrate functional harm — the
  dispose does not cancel an in-flight Workers-RPC call. Left here as dead state that looks like a
  dropped guard, and a `dormant` probe that lies.
- **Ephemeral events consult the idempotency column.** `stream/stream.ts:283-311` runs the
  `SELECT … WHERE idempotency_key = ?` and the in-batch map for _every_ event, ephemerals included,
  though the module header states "an ephemeral's idempotencyKey is simply never stored — ephemerals
  never reach the idempotency column". Consequence read off the code (not tested): an ephemeral
  carrying a key that collides with a durable row either dedupes to that durable event (and never
  fires) or refuses the whole batch with `IDEMPOTENCY_CONFLICT`; and two same-keyed ephemerals in
  one batch collapse to one while the same two in different batches both fire.
- **`coreLiveStateSnapshot()` seeds `rev: 0`, which no delta can ever chain onto.**
  `stream/stream.ts:234-236` returns `{ rev: 0, … }` before the incarnation's first durable commit,
  and the comment says "the first delta (`from: 0`) chains onto" it — but `LiveState` mints its rev
  from a `Date.now()`-based epoch (`stream/live-state.ts:54`), so the first delta's `from` is that
  epoch and a client seeded at 0 is always forced to re-seed. Costs a round trip, not correctness;
  reads as a stale comment.
- **A subscription REPLACE orphans the facet the old row hosted.**
  `#deleteFacetsWhoseHostingSubscriptionWasRemoved` fires only on `target === null`
  (`iterate-context-durable-object.ts:222`), so re-pointing a row away from
  `facets.get(name, spec)` leaves that facet and its storage behind with nothing naming it. Whether
  that is intended (a facet outliving its subscription is legal) was not clear enough to call a bug.
- **A rule-aliased processor target escapes the removal effect.** The same function destructures the
  literal target (`const [, root, getStep] = removedRow.target`), so a row whose target is
  `itx.presence` (a rewrite rule to `itx.facets.get('presence', …).processEventBatch`) never deletes
  its facet on `disableProcessor`. Untested; the mirror image of bug 5.
- **`#unsetWhatNamesRpcStub` swallows a refused append.**
  `iterate-context-durable-object.ts:144-155` fires `void this.append(…).catch(() => undefined)` for
  every rule/row naming a dead stub. On a PAUSED stream those appends are refused and dropped, so
  rules and subscriptions naming a stub that will never come back survive indefinitely (the pause is
  a real feature — `BreakerProcessor` trips it). Not tested.
- **The halt path resets the ladder before appending the halt.**
  `stream/subscription-delivery.ts:354-366` does `#adoptCursor(name, { ...cursor, attempt: 0 }, true)`
  and _then_ awaits the `subscription-delivery-halted` append. If that append is refused (paused
  stream), the halt fact never lands and the ladder has been reset to attempt 0 with no
  `nextAttemptAtMs` — a tight, backoff-free retry. Needs 15 induced failures to reach; not tested.
- **Checked and found sound** (no defect): the expression codec round-trips every arg shape I threw
  at it (nested objects/arrays, both quote characters, `Infinity`/`NaN`, `-0`, dashed identifiers);
  a self-referential rule errors at the depth budget rather than spinning; the `subscription-configured`
  name `core` is refused at the command (`stream/subscriptions.ts:27`); the ephemeral-offset /
  durable-mark contract holds (a batch's mark covers the ephemeral offsets it handed out, so a
  cursor persisted at an ephemeral offset can never skip a durable); `Stream.append` is synchronous
  end to end, so two concurrent appends cannot interleave.

---

## Commands run, and their results

```
# baseline, before any new file
pnpm -s test                       # 24 files, 252 passed — green

# the new proofs, verified RED for the right reason (test.fails temporarily flipped to test)
npx vitest run --project workers __workers-tests__/review-bugs-do-side.test.ts
#   × the alarm's cursor pass recovers …   AssertionError: expected [] to deeply equal [ 1, 2 ]
#   × a subscription re-configured …       expected { sinkA: [[1],[2]], sinkB: [] } to deeply equal { sinkA: [[1]], sinkB: [[2]] }
#   × a two-step subscription target …     expected { delivered: [], evaluated: ["itx","itx"] } …
#   × removing one hosting subscription …  expected { memoKept: false, count: 0 } to deeply equal { memoKept: true, count: 2 }

npx vitest run --config e2e/vitest.config.ts e2e/review-bugs-do-side.e2e.test.ts
#   × a cacheKey whose producer threw once …
#     Error: workers.get: a source is its modules, and needs a "cap.js" main module   ← the ORIGINAL failure, replayed

npx vitest run --project unit src/review-bugs-do-side.test.ts
#   × a pinned object arg picks the same rule …  expected 'itx.openai.chat' to be 'itx.anthropic.chat'

# then marked test.fails — both lanes green
pnpm -s test                       # 28 files, 252 passed | 7 expected fail — exit 0
npx vitest run --config e2e/vitest.config.ts    # 38 files, 141 passed | 7 expected fail — exit 0
pnpm -s typecheck                  # exit 0
npx oxfmt <the three new files> && npx oxlint <the three new files> --deny-warnings
#   Found 0 warnings and 0 errors.
```

(The "expected fail" counts include proofs added by the parallel edge-side review; this review adds
four to the workers lane, one to the e2e lane and one to the unit lane.)

### Files added (tests only; nothing under `src/` was modified)

- `src/review-bugs-do-side.test.ts` — bug 6 (pure logic, node lane)
- `__workers-tests__/review-bugs-do-side.test.ts` — bugs 2, 3, 4, 5 (workerd lane)
- `e2e/review-bugs-do-side.e2e.test.ts` — bug 1 (whole-worker lane)
