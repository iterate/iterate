# Sweep candidates: os-context-builtins

Verified candidates from the 2026-09-29 codebase simplification sweep for this area. Each passed an adversarial skeptic check; where the skeptic amended the proposal, the amendment wins. Line numbers are as of origin/main on 2026-09-29 (about cfd8a1d36) and have drifted since: #3442, #3455 and #3460 touched some of these files. The index and the owner calls are in ../codebase-simplification-sweep.md.

## A facet's public methods come from listPublicMethods() for every facet, not also from a static table that imports 8 domain classes

- Sweep index: 10; risk: low; payoff: 3/10
- LOC: facet-host.ts: −25 net (−32/+7), measured by diffing an oxfmt-formatted simulation against cfd8a1d36. facet-host also drops its 8 domain imports. (skeptic measured: apps/os/src/context/facet-host.ts goes from 1466 to 1441 lines: 34 removed, 9 added, net −25. I simulated the edit on a copy of main at b3daf4846, which already contains #3446, formatted it with the repo's oxfmt config and diffed it. facet-public-methods.ts changes by about 0 lines: rule 4 of its header is reworded. facet-host.ts loses 8 domain imports. Seeding the cache from #start is not included; it would add 3 or more lines.)
- Concepts: 2 sources of public methods become 1, and 2 tables of first-party names become 1.

### Evidence

In apps/os/src/context/facet-host.ts:

- :49-58 imports 8 domain DO classes only to read their statics.
- :142-154 `FIRST_PARTY_FACET_PUBLIC_METHODS` is a second table of first-party names, beside first-party-facets.ts:11-20 FIRST_PARTY_FACET_CLASSES.
- :876-888 `#callOn` branches on `materialized.loaderId`.
- :897-915 `#publicMethodsOf` asks loaded facets for their methods.
- :552-566 `#start` already calls `listPublicMethods` on every facet and discards the answer.

All 8 first-party classes extend StreamProcessorDurableObject (packages/iterate/src/sdk/index.ts:101-129), which answers listPublicMethods().

### Current shape

The facet host checks public methods two ways:

- A caller's walk into a first-party facet is checked against a static table built by importing all 8 classes.
- A loaded facet is checked against its listPublicMethods() answer, cached per loader id.

Both kinds of facet are SDK shells that answer the same RPC.

### Proposed shape

```ts
async #publicMethodsOf(materialized: MaterializedFacet, name: string) {
  const code = materialized.loaderId ?? `${this.#deps.deployId} ${name}`; // first-party runs this deploy's class
  … // unchanged cache + listPublicMethods(), [] on a missing method
}
// #callOn: if (byItxExpression) assertFacetMethodIsPublic(name, await this.#publicMethodsOf(materialized, name), steps);
```

- Delete the 8 imports and the table.
- Optionally (+2 lines), `#start` seeds the cache from the answer it already fetches.

### What changes

- A caller's first expression walk into a first-party facet in an incarnation costs one extra in-process RPC. With seeding, none.
- The compile-time check 'a first-party name without its list fails typecheck' goes. The SDK base class guarantees the list at runtime instead.
- Platform calls with a cause are unchanged.

### Pinned by

- **workers-tests**/facets.test.ts:1396-1446 (facet × method table) and :1480
- src/context/facet-public-methods.test.ts

### Skeptic's amended proposal

In apps/os/src/context/facet-host.ts:

- Delete the 8 imports of domain Durable Objects (:49-58) and the `type FIRST_PARTY_FACET_CLASSES` import.
- Delete FIRST_PARTY_FACET_PUBLIC_METHODS and its doc (:142-154).

In #callOn:

```ts
if (byItxExpression)
  assertFacetMethodIsPublic(
    name,
    await this.#publicMethodsOf(materialized, name),
    itxExpressionSteps,
  );
// withCause UNCHANGED: cause && step !== "fetch" && (!materialized.loaderId || (await this.#publicMethodsOf(...)).length > 0)
```

In #publicMethodsOf, key the cache by the code the facet runs:

```ts
const code = materialized.loaderId ?? `${this.#deps.deployId} ${name}`; // a first-party facet runs this deploy's class
let publicMethods = this.#publicMethodsByCode.get(code); … // rest unchanged: listPublicMethods(), [] on a missing method, set(code, …)
```

- Rename #publicMethodsByLoaderId to #publicMethodsByCode. The `.delete(previousLoaderId)` in #materialize stays.
- Do not seed the cache from #start.

In facet-public-methods.ts, rule 4 becomes: "Every facet's list is asked of it once per code it runs (`listPublicMethods()`, which the shells answer): a loaded identity, or this deploy's first-party class. A loaded class that extends neither shell answers no list, so nothing on it is reached by expression."

Also rewrite the #callOn doc's "a first-party class's table, or what the loaded identity itself answers" as "what the facet itself answers".

Concepts: 2 sources of a facet's public methods become 1, and 2 first-party name tables become 1. facet-host.ts drops 8 domain imports. #callOn branches on loaderId only in the callWithCause decision.

LOC: facet-host.ts −25 (−34/+9), measured with oxfmt.

Risk: low. The cost is one extra in-process call per first-party facet per incarnation, on its first caller walk. During the facet-start platform defect, that walk may also need one extra bounded restart.

Pinned by:

- **workers-tests**/facets.test.ts:1396-1446 and the test that follows it
- src/context/facet-public-methods.test.ts (unaffected)
- src/context/facet-host.test.ts (unaffected)

### Skeptic's verdict

The claim is true: every first-party class answers the call. All 8 of them extend StreamProcessorDurableObject (apps/os/src/{account,email,instance,organization,project,repo,secret,workspace}/durable-object.ts). The SDK's listPublicMethods() returns `this.constructor.publicMethods` (packages/iterate/src/sdk/index.ts), and no first-party class overrides it. So the list read over RPC is exactly the static that FIRST_PARTY_FACET_PUBLIC_METHODS reads (facet-host.ts:142-154). #start (:552) already makes this call on every facet and throws the answer away. #3446 has merged and does not touch any of this.

What changes (a):

1. The first caller walk into a first-party facet in each incarnation costs one extra in-process call to listPublicMethods. The answer is then cached.
2. A FORBIDDEN walk into a cold first-party facet now starts the facet before it is refused. Today it is refused before anything runs. The refused method itself still never reaches the facet, and the facet-ran row is written in both cases (#markRan runs before #callOn).
3. There is an interaction with the platform workaround for failures at facet start. #recover says a replacement can be good for exactly ONE call. In that window, listPublicMethods can use up the one good call. The real call then fails, and a cold first-party facet's first walk costs one extra bounded restart, counted on facet:<name>:restarts. After the restart the answer is cached (the cache key does not change), so the retried walk is the first call on the replacement.
4. Adding a first-party name that has no list no longer fails typecheck. That check was weak anyway: the withCause branch already assumes every first-party class is an SDK shell.
5. Platform calls with a cause are unchanged, but only if the withCause line (:885-888) keeps `!materialized.loaderId ||`. The candidate implied this; it must be stated.

No test depends on the old behaviour:

- **workers-tests**/facets.test.ts:1396-1446 goes through real facets and gives the same outcomes.
- src/context/facet-public-methods.test.ts reads the classes' statics directly, not the host's table.
- src/context/facet-host.test.ts uses only loaded fakes. After the change it stops pulling the 8 domain DOs into Node.
- No test pins the rule that a refused walk never starts the facet.

Is it simpler (b)? Yes, not just different:

- There is one source of a facet's public list (its own answer, cached per code) where there were two.
- There is one first-party name table where there were two.
- The generic facet host stops importing every domain Durable Object only to read statics.
- The ternary in #callOn, with its "the type system cannot see it" cast, goes.

It is modest: 25 lines and one concept, in a central file. It fits "two mechanisms doing one job" but is not heavy junk.

Guarantees (c): none is dropped. The allowlist check still runs before the method call, and the list comes from platform code in both cases.

Amendments:

1. Leave the withCause line exactly as it is.
2. Do not seed the cache from #start. If #start went through #publicMethodsOf, a loaded class whose listPublicMethods returns junk would fail zod at start, be logged as start-failed and keep its facet-ran row. That is a new failure mode, added to save one in-process call.
3. Rename the cache, because it is no longer keyed only by loader ids.
4. Reword rule 4 of facet-public-methods.ts.

## Fold a processor claim's failure count into the claim row: one kv row kind, not two with two maps and two helpers

- Sweep index: 15; risk: low; payoff: 4/10
- LOC: facet-host.ts: 1466 → 1445 lines (+9/−30, net −21), measured on a scratch copy. Test edits are small: facets.test.ts:203, :726 and :733. (skeptic measured: I applied the change to a scratch copy of apps/os/src/context/facet-host.ts (skeptic-claim/new.ts in the scratchpad). The file goes from 1466 to 1447 lines: +11/−30, net −19. That includes a FacetClaim docstring 2 lines longer than today's, which takes over the explanation from the `#facetReviveFailures` doc it replaces. With a tighter docstring it comes to about −21, which matches the candidate. Tests change 3 lines in facets.test.ts, net 0. PR #3446 is merged and does not touch facet-host.ts. The only other readers of `facet-claim*` rows are facets.test.ts:204/723/733-734/740/754 and apps/agents/**workers-tests**/agent-revive.test.ts:59/102. No script, doc or reset tool reads them.)
- Concepts: 2 kv row kinds, 2 maps and 2 sync helpers become 1 row kind and 1 map.

### Evidence

In apps/os/src/context/facet-host.ts:

- :113-116 `FacetClaim = { at, cause? }`
- :278-283 `#facetReviveFailures`
- :309-311 a second constructor kv.list, over `facet-claim-failures:`
- :327 dueAtBirth reads that map
- :361-363 claim() calls `#facetRevived`
- :378-417 reviveDueClaims
- :612-621 `#facetReviveFailed` and `#facetRevived`
- :1449-1450 #deleteFacet clears both

A revive that ends NO_FACET or PERMANENT_FAILURE spends the claim but leaves the failures row behind.

### Current shape

A hosted processor's claim is two kv rows, `facet-claim:<name>` and `facet-claim-failures:<name>`, each with its own in-memory map and its own write and clear helpers. claim(), every revive outcome and deletion have to keep them in step, and the count is only meaningful while a claim exists.

### Proposed shape

```ts
type FacetClaim = { at: number; cause?: Cause; failures?: number };
// revive threw:
this.#claimFacetAlarm(
  name,
  Date.now() + Math.min(REVIVE_AFTER_MS * 2 ** (failures + 1), REVIVE_AFTER_MAX_MS),
  cause,
  failures + 1,
);
// FACET_ABORTED / FACET_RESTARTED: this.#claimFacetAlarm(name, Date.now(), cause, failures);
// constructor: dueAtBirth = firstPartyFacetClassOf(name) && !claim.failures
// claim(): #claimFacetAlarm(name, at, cause) — a facet's own claim carries no failures, ending the ladder
```

Delete `#facetReviveFailures`, the second kv.list, `#facetReviveFailed`, `#facetRevived`, and their call sites.

### What changes

- A spent NO_FACET or PERMANENT_FAILURE revive no longer leaves a stray row.
- A facet that re-claims during its own revive, which then throws, continues the backoff from the spent claim's count. Today it restarts at rung 1.
- At deploy, the existing `facet-claim-failures:*` rows become strays, so any ladder in progress restarts at rung 0 once.
- The backoff formula, due-at-birth, release and 'own claim ends the ladder' are all unchanged.

### Pinned by

- **workers-tests**/facets.test.ts:184, 703, 720 and 736
- apps/agents/**workers-tests**/agent-revive.test.ts reads `facet-claim:agent` as `{ at }` and stays compatible.

### Skeptic's amended proposal

Concrete shape, verified on a scratch copy.

```ts
/** ...one kv row (`facet-claim:<name>`): when a revive is owed by, and why (cause.ts) — and, on a
 *  claim the alarm pass put back after revives that THREW, how many in a row: its backoff, kept in
 *  the row so it survives the eviction between two passes. A facet's own claim carries none. */
type FacetClaim = { at: number; cause?: Cause; failures?: number };

#claimFacetAlarm(name: string, at: number | null, cause = this.#facetClaims.get(name)?.cause, failures?: number) {
  ... const claim: FacetClaim = { at, ...(cause && { cause }), ...(failures && { failures }) }; ...
}

// constructor
const dueAtBirth = firstPartyFacetClassOf(name) && !claim.failures;

// reviveDueClaims
for (const [name, { at, cause, failures = 0 }] of [...this.#facetClaims]) {
  ...
  // FACET_ABORTED | FACET_RESTARTED:
  this.#claimFacetAlarm(name, Date.now(), cause, failures);
  // threw:
  this.#claimFacetAlarm(name, Date.now() + Math.min(REVIVE_AFTER_MS * 2 ** (failures + 1), REVIVE_AFTER_MAX_MS), cause, failures + 1);
}
```

Delete `#facetReviveFailures` and its docstring, the `facet-claim-failures:` kv.list in the constructor, `#facetReviveFailed`, `#facetRevived`, and the calls to `#facetRevived` in claim(), after a successful revive and in #deleteFacet.

The claim() path passes no failures, so a facet's own claim ends the ladder by construction.

Tests:

- facets.test.ts:204: expect the claim row's `.failures` to be undefined instead of the removed row.
- facets.test.ts:733-734: seed a single row, `facet-claim:repo` = `{ at, failures: 1 }`.
- facets.test.ts:740: expect `{ at, failures: 1 }`.

State these accepted drifts in the PR:

- Orphaned `facet-claim-failures:*` rows at deploy. There is no cleanup, per the no-backcompat rule.
- A facet that re-claims inside a revive that then throws continues its ladder instead of restarting it.

Net LOC is about −19 to −21 in facet-host.ts, and the test files net 0.

### Skeptic's verdict

The semantics claim holds. I traced every path on main (b3daf4846):

- **Due at birth.** Today a failures row exists only beside a claim the ladder put back: claim() clears the row before it writes. So `!this.#facetReviveFailures.has(name)` is the same test as `!claim.failures`.
- **Successful revive.** The claim was already released. If the facet re-claims, claim() writes a row with no failures. Either way the count clears implicitly, exactly as `#facetRevived` does today.
- **FACET_ABORTED / FACET_RESTARTED.** Today the failures row is left untouched. Passing the spent claim's count keeps the same number.
- **Revive threw.** 2 ** (failures+1) with the stored count gives the same backoff as today's increment-then-read.
- **claim(name, null) and #deleteFacet.** They delete the one row, which now includes the count.
- **deadlines(), owedCause() and the alarm trace.** They read only at and cause.

The real deltas:

1. A PERMANENT_FAILURE revive, or a NO_FACET revive whose deletion didn't already clear the row, no longer strands a `facet-claim-failures` row. Today that row has no effect on behaviour, because any later claim goes through claim(), which clears it. So this is only storage hygiene.
2. A facet that calls processors.claim inside its own revive, and whose revive then throws with something other than abort or restart, now continues its ladder. Today its claim() reset the ladder, so the backoff restarts at 40 s. The same applies to that facet's count on the abort/restart put-back. Keeping today's rule exactly would take one line: `const rung = this.#facetClaims.has(name) ? 0 : failures`. It isn't worth it, and continuing the ladder is arguably more correct.
3. At deploy, existing `facet-claim-failures:*` rows are orphaned forever, and #deleteFacet no longer cleans them up. Any ladder in progress restarts once: a first-party claim on the ladder becomes due at its next birth, costing one extra revive, and backoff restarts at 40 s. This is acceptable under the no-backcompat rule.

No guarantee is dropped. The backoff still survives eviction (it now lives in the claim row), the ladder still keeps a claim from being due at birth, and a facet's own claim still ends the ladder.

Is it simpler? Yes, genuinely. It goes from 2 kv row kinds, 2 in-memory maps, 2 keep-in-step helpers and 4 call sites to 1 row, 1 map and 0 helpers. That removes the constructor's second kv.list and the rule that "the count only means something while a claim exists", because that is now true by construction. It is modest in size, but it is a real case of two mechanisms doing one job in core code, not a rename.

Typing: `failures = 0` destructured from the optional field is fine. I checked the conditional-spread row literal with the repo's tsc under --strict and it compiles. There is no exactOptionalPropertyTypes in any tsconfig, so `{ at, cause, failures }` also works. Stored undefined keys would be harmless under the tests' toEqual.

Tests that pin the current behaviour:

- facets.test.ts:204 asserts the failures row is absent. That becomes vacuous and should assert that the claim row has no `failures`.
- facets.test.ts:733-734 seeds two rows and :740 expects `{ at }`. Both need `{ at, failures: 1 }`, otherwise :740 fails because toEqual sees the defined failures field.
- facets.test.ts:720 (due at birth) and :754 (loaded claim keeps its at) are unchanged.
- agent-revive.test.ts reads only `.at` or undefined and stays compatible.

I could not run the full typecheck or the workers tests, because the checkout is read-only.

## A platform facet start is bounded once, not twice by the same 10 s, plus a watchdog policy type that exists only for the inner bound

- Sweep index: 16; risk: low; payoff: 3/10
- LOC: facet-host.ts: 1466 → 1452 (+10/−24, net −14), measured on a scratch copy. It pairs with the copy-out row, which removes the third dispose site. (skeptic measured: apps/os/src/context/facet-host.ts: 1466 → 1458 lines, +27/−35, net −8 (a scratch copy with the proposal applied, formatted with the repo's oxfmt, compared using git diff --no-index --stat). The candidate claimed −14.)
- Concepts: Before: a policy type, a constant, and two nested identical bounds.
  After: one number per call, and one bound per start.

### Evidence

In apps/os/src/context/facet-host.ts:

- :118-125 define `FacetCallWatchdog = { watchdogMs; onTimeout: 'restart' | 'leave' }` and FACET_CALL_WATCHDOG.
- #start, inner watchdog at :553: `{ watchdogMs: FACET_START_WATCHDOG_MS, onTimeout: 'leave' }`.
- #start, outer bound at :588: `withTimeout(start(), FACET_START_WATCHDOG_MS, …)`.
- :1284-1295 is #call's TIMEOUT branch, including the 'leave' late-answer dispose.
- :1328-1344 is the ordinary copy-out.

withTimeout never cancels the promise it races (packages/iterate/src/lib.ts:297-322).

### Current shape

The inner timer starts after the outer one and has the same duration, so it can never fire first. Its only effect is the 'leave' branch, which hand-disposes a late answer. #call's ordinary copy-out would dispose that answer anyway if the call were simply awaited.

### Proposed shape

```ts
async #call(m, name, steps, watchdogMs: number | null) {
  result = watchdogMs === null ? await call : await withTimeout(call, watchdogMs, label);
  …
  if (errorCode(error) === 'TIMEOUT' && this.#facetGeneration(name) === generation)
    await this.#restart(name, () => this.#abortForRestart(name, 'call timed out', generation));
```

- #start passes `null`.
- Every other caller passes FACET_CALL_WATCHDOG_MS.
- Delete the policy type, the FACET_CALL_WATCHDOG constant and the 'leave' branch.

### What changes

Behaviour changes only after a start has already given up at its 10 s bound. The inner call is then no longer rejected with TIMEOUT. It keeps waiting, and a late answer is copied and disposed by the normal path, which is the same end state as before.

No abort, kv write, log line or return value of #start changes.

### Pinned by

No test pins a start that hangs. These must stay green:

- facets.test.ts:531, :862, :896 and :976
- e2e/facet-abort-storage-reset.e2e.test.ts
- facet-push-timeout-heals.test.ts
- facet-timeout-restart-heals-sibling-push.test.ts

### Skeptic's amended proposal

In apps/os/src/context/facet-host.ts:

- Delete `FacetCallWatchdog`, its doc and `FACET_CALL_WATCHDOG` (:118-125), and the `watchdog` local in #start (:553).
- Change the `watchdog` parameter of #call, #callOn and #recover to `watchdogMs: number | null`. null means the caller bounds the call.
- #start passes `null` to both #call (:566) and #recover (:579). The three FACET_CALL_WATCHDOG sites (:830, :848, :908) pass FACET_CALL_WATCHDOG_MS.
- In #call:

```ts
result = watchdogMs === null ? await call
  : await withTimeout(call, watchdogMs, () => name === "secret" ? 'facet "secret"' : `facet "${name}" ${print(itxExpressionSteps)}`);
...
if (errorCode(error) === "TIMEOUT") {
  if (this.#facetGeneration(name) === generation)
    await this.#restart(name, () => this.#abortForRestart(name, "call timed out", generation));
} else if (startupFailed()) { ... }
```

- Reword #call's doc at :1249-1250: "a platform start's call has no watchdog of its own; #start bounds the whole start". The #start comment at :586-587 stays as it is.

**Semantics (corrected):** only the tail of a start that has already given up at its 10 s bound changes.

- A late answer is copied and disposed by the normal path, with the same end state.
- A late failure now runs #call's ordinary handling instead of being dropped as TIMEOUT:
  - an abort for a startup failure, outside blockConcurrencyWhile;
  - or at most one retry on a replacement plus one restart through an unqueued #recover, with its `restarts` kv write lost to the drained `owed`.
- Both paths are already reachable today inside the bounded tail window.
- One pending ≤10 s timer per given-up start goes away.

**LOC:** 1466 → 1458 (+27/−35) after oxfmt.

**Concepts:** before, a policy type, a constant and two nested 10 s bounds. After, a nullable number and one bound per start.

**Risk:** low.

**Tests that must stay green:** facets.test.ts:532, :869, :903 and :983, e2e/facet-abort-storage-reset.e2e.test.ts, facet-push-timeout-heals.test.ts and facet-timeout-restart-heals-sibling-push.test.ts.

### Skeptic's verdict

The redundancy is real. #start calls `start()` first and then `withTimeout(start(), FACET_START_WATCHDOG_MS)` (facet-host.ts:588). The inner timer is armed later, inside #call, after `await this.#materialize(...)`. Both last 10 s, so the outer bound always settles #start first, returns false and logs. The inner 'leave' TIMEOUT only ever lands on the tail of a start that has already given up, and :586-587 already says that tail "runs on". No test pins a hanging start. The cited rows are near facets.test.ts:532, :869, :903 and :983, and they exercise start failure and recovery, not a timeout. PR #3446 does not touch facet-host.ts, and nothing outside the file uses FacetCallWatchdog.

**(a) The semantics claim is overstated.** Every change is confined to the tail of a start whose outer 10 s has already fired:

1. A late answer is copied and disposed by #call's normal copy-out, so the end state matches. `owed.push(recordLoadedIdentity)` now lands in an array #restartAll has already drained, which is a no-op.
2. A late rejection after the old inner deadline is no longer cut off as TIMEOUT, whose handler swallowed it with `() => {}`. It now takes #call's ordinary failure paths:
   - If `startupFailed()`, the facet is aborted ("startup failed") outside any blockConcurrencyWhile. Every ordinary call already does this.
   - A recoverable failure (the platform text, or a peer recovery's "platform failure at facet start — restarting" with the generation moved) enters an unqueued #recover outside blockConcurrencyWhile. It can abort and re-materialize, and its console.warn fires. The `restarts` kv write goes into the dead `owed` array.

   Today both of these can already happen inside the tail window: a first call that fails at 9.9 s recovers past the outer bound. The proposal makes the window unbounded in time, but it is still bounded in count: at most one retry on a replacement and one restart.

3. One pending setTimeout per given-up start disappears. That is marginally better for eviction, since timers keep a Durable Object resident.
4. The failure log's message text changes only in a same-tick tie that registration order rules out.

So the candidate's "no abort changes" is false in edge-of-edge cases, but the change is still "almost identical".

**(b) The new shape is simpler.** It removes the policy type and its 3-line doc, the FACET_CALL_WATCHDOG constant, the `watchdog` local in #start, and the 7-line 'leave' branch. In their place, `number | null` means "the caller bounds it". That is one concept fewer, not a lateral move.

**(c) No guarantee is dropped.** The invariant in residency.md is that every platform abort is followed by a start under blockConcurrencyWhile. It still holds, because the start tail gets no watchdog abort at all. The paths in (a)2 are pre-existing exceptions that merely become reachable later.

**(d) LOC:** I re-measured on a scratch copy formatted with oxfmt. The file goes from 1466 to 1458 lines, +27/−35, net −8, not −14. Wrapping the timeout in a ternary adds lines, and the listPublicMethods call reflows. The payoff is real but small.
