# Sweep candidates: os-context

Verified candidates from the 2026-09-29 codebase simplification sweep for this area. Each passed an adversarial skeptic check; where the skeptic amended the proposal, the amendment wins. Line numbers are as of origin/main on 2026-09-29 (about cfd8a1d36) and have drifted since: #3442, #3455 and #3460 touched some of these files. The index and the owner calls are in ../codebase-simplification-sweep.md.

## FacetHost records how a facet generation ended in one map, not three maps, a wrapper and a match on our own message text

- Sweep index: 12; risk: medium; payoff: 4/10
- LOC: Measured on scratch copies: −12 to −14 in facet-host.ts (1466 lines). One simulation was +39/−51 with the recovery ending folded in; the other was −72/+58 without it.

The per-area estimates of −23 and −32 were not measured. (skeptic measured: I applied the amended shape in a scratch worktree off origin/main at b3daf4846, then ran oxfmt, oxlint and `tsc --noEmit` (all clean). apps/os/src/context/facet-host.ts goes from 1466 to 1448 lines (+67/−85, net −18), and no other file changes. The diff is saved at /private/tmp/claude-501/-Users-jonastemplestein--herdr-worktrees-iterate-first-party-agents/8c90908e-f48e-4f3f-adc0-08a3364e1b4c/scratchpad/skeptic-fh-endings.diff. The candidate's own −12 to −14 was in the right range. PR #3446 does not touch facet-host.ts.

Tests run on the amended code:

- workers: facets.test.ts, facet-timeout-restart-heals-sibling-push.test.ts (the real 60 s watchdog) and facet-push-timeout-heals.test.ts: 66/66 pass.
- workers: alarm-and-pins, named-facets, uncontrolled-degradation and context-runs: 44 pass, plus 6 expected failures that are the pinned-degradation rows.
- unit: facet-host.test.ts and dispatch.test.ts: 28/28 pass.
- The deployed e2e context-abort.e2e.test.ts:212 was not run. It asserts the same code and message that facets.test.ts already covers locally.)
- Concepts: Before: 3 ended-generation maps, 2 abort helpers, a message-text sentinel, and live-set bookkeeping at 5 sites.
  After: 1 map, 1 FacetEnding type and 1 abort helper.

### Evidence

Merges 4 rows: builtins (parallel and heavy) and routing (parallel and heavy).

In apps/os/src/context/facet-host.ts:

- :259-266 `#abortedOnRequest` and `#restartedUnderInFlightCalls`
- :303-305 `#deletedGeneration`

The three maps are written by:

- `abort()`'s before/after compare at :437-443
- the `#abortForRestart` wrapper at :1423-1430 (called at :1128, :1132 and :1294)
- `#deleteFacet` at :1447-1448

`#call`'s catch at :1302-1323 re-codes with three ordered branches, each guarded differently:

- none
- not TIMEOUT
- message === 'Facet was deleted.'

A fourth ending, a recovery restart, is recognised by string-matching our own abort reason ('platform failure at facet start — restarting') at :958-962 and :996-1008.

Five call sites also drop the name from `#liveFacetNames` by hand: :440, :536, :963, :1129 and :1299.

### Current shape

Each way the platform ends a facet generation keeps its own per-facet map of the generation it ended: abort on request, platform restart, and deletion. Each map remembers only its latest generation.

`#call` checks the three maps in turn to re-code an in-flight rejection as FACET_ABORTED, FACET_RESTARTED or NO_FACET.

### Proposed shape

```ts
type FacetEnding = { code: 'FACET_ABORTED' | 'FACET_RESTARTED' | 'NO_FACET'; message: string };
readonly #endedGenerations = new Map<string, FacetEnding | 'recovery'>(); // `${name}@${generation}`
#abortFacetIfRunning(name, reason, ending?, expectedGeneration?) {
  const generation = this.#facetGeneration(name);
  if (expectedGeneration !== undefined && expectedGeneration !== generation) return;
  this.#liveFacetNames.delete(name);
  try { this.#deps.ctx.facets.abort(name, reason); } catch { return; }
  if (ending) this.#endedGenerations.set(`${name}@${generation}`, ending);
  this.#facetGenerationByName.set(name, generation + 1);
}
// #call catch:
const ended = this.#endedGenerations.get(`${name}@${generation}`);
if (ended && ended !== 'recovery' && errorCode(error) !== 'TIMEOUT') throw codedError(ended.code, ended.message);
throw error;
```

- abort() passes FACET_ABORTED.
- The restart sites pass FACET_RESTARTED, and `#abortForRestart` goes.
- `#recover` passes 'recovery'.
- `#deleteFacet` sets NO_FACET.

A simpler variant keeps one entry per facet name (the latest ending only).

### What changes

- A call cut off by a deletion becomes NO_FACET whatever its rejection text says. Today only the exact 'Facet was deleted.' text is re-coded.
- A TIMEOUT on a generation that was aborted on request stays TIMEOUT. Today it becomes FACET_ABORTED, which in practice cannot happen because the watchdog's restart moves the generation first.
- With the name@generation key, a straggler on an older generation is still re-coded after a newer one ended. The per-name variant would hand it the raw error instead, which is a sub-turn window.
- A call whose own error races a recovery's abort is retried in line. Keep the text check too to stay exactly identical.

### Pinned by

- **workers-tests**/facets.test.ts:163, 184, 207 (FACET_ABORTED), :229/:243 (NO_FACET), :305-320 (FACET_RESTARTED), and recovery concurrency at :896, 931, 976, 1021
- **workers-tests**/facet-timeout-restart-heals-sibling-push.test.ts:23-79
- e2e/context-abort.e2e.test.ts:213
- stream/subscription-delivery.test.ts:1169; subscription-delivery.ts:554 and :780-797 read the codes

### Skeptic's amended proposal

Record how a generation ended on the generation object, not in maps keyed by facet name.

```ts
/** One run of a facet's container, from its start to the abort or deletion that ends it: a late
 *  failure may only retire its own. The platform's end of it says what a call still in flight on it
 *  rejects with (`#call`): `itx.facets.abort` FACET_ABORTED, a platform restart (a new loaded
 *  identity, another call timed out) FACET_RESTARTED, `#deleteFacet` NO_FACET — outcomes, not
 *  failures to report. A recovery's restart and a failed startup's abort code nothing. */
type FacetGeneration = {
  endedBy?: { code: "FACET_ABORTED" | "FACET_RESTARTED" | "NO_FACET"; message: string };
};
// MaterializedFacet.generation: FacetGeneration
// #facetGenerationByName = new Map<string, FacetGeneration>()
// Removed: #abortedOnRequest, #restartedUnderInFlightCalls, #deletedGeneration

#abortFacetIfRunning(name, reason, endedBy?: FacetGeneration["endedBy"], expectedGeneration?: FacetGeneration) {
  const generation = this.#facetGeneration(name);
  if (expectedGeneration && expectedGeneration !== generation) return;
  this.#liveFacetNames.delete(name);
  try { this.#deps.ctx.facets.abort(name, reason); } catch { return; } // not running
  generation.endedBy = endedBy;
  this.#facetGenerationByName.set(name, {});
}
#abortForRestart(name, reason, expectedGeneration?) {
  this.#abortFacetIfRunning(name, reason,
    { code: "FACET_RESTARTED", message: `facet "${name}" was restarted (${reason}) — its next call runs on the new instance` },
    expectedGeneration);
}
#facetGeneration(name) {
  let g = this.#facetGenerationByName.get(name);
  if (!g) this.#facetGenerationByName.set(name, (g = {}));
  return g;
}
// abort(): #restart(name, () => #abortFacetIfRunning(name, `facet "${name}" aborted${why}`, { code: "FACET_ABORTED", message: `facet "${name}" was aborted${why} — its next call starts it fresh` }))
// #deleteFacet: this.#facetGeneration(name).endedBy = { code: "NO_FACET", message: `facet "${name}" was deleted while this call was in flight` }; this.#facetGenerationByName.set(name, {});
// #call's catch, after the timeout and startup branches:
//   } else if (startupFailed()) this.#abortFacetIfRunning(name, "startup failed", undefined, generation);
//   const { endedBy } = generation;
//   if (endedBy && errorCode(error) !== "TIMEOUT") throw codedError(endedBy.code, endedBy.message);
//   throw error;
```

Also remove the manual `#liveFacetNames.delete` at :440, :536, :963, :1129 and :1299, and the `.clear()` at :516. `#restartAll`'s loop becomes `for (const { abort } of restarts) abort?.();`. `#materialize`'s identity change becomes `const abort = () => this.#abortForRestart(name, "loaded identity changed"); if (platformStart) abort(); else started = await this.#restart(name, abort);`. `#recover` drops its redundant expectedGeneration argument, since :952 already checks it.

Keep the recovery's text match in `#isRecoverableFacetFailure` (:1005) unchanged. Do not add a 'recovery' sentinel: it would retry a call's own application error inline. Do not key a map by name@generation: nothing prunes it, so it leaks.

Exact semantic delta:

- NO_FACET for any error other than TIMEOUT on a deleted generation, not only the runtime's exact "Facet was deleted." text;
- TIMEOUT stays TIMEOUT on a generation that was aborted on request (unreachable in practice);
- a call still in flight on an old generation always keeps its code (today it can lose it).

Concepts before: a generation number, three per-kind ended-generation maps with two before/after compare idioms, a match on the runtime's message text, and live-set bookkeeping at five sites. After: a generation object with one optional `endedBy` field, and one abort helper that owns the live set. `#abortForRestart` stays only to build the FACET_RESTARTED ending.

Measured: facet-host.ts +67/−85 (net −18). tsc, oxlint and oxfmt are clean. The workers tests in facets.test.ts, facet-timeout-restart-heals-sibling-push.test.ts and facet-push-timeout-heals.test.ts pass, and so do the unit tests in facet-host.test.ts and dispatch.test.ts. Risk: low to medium.

### Skeptic's verdict

The finding is right: three per-facet maps record the same thing, each paired with its own guard. `#abortedOnRequest` (:261), `#restartedUnderInFlightCalls` (:266) and `#deletedGeneration` (:305) each store "the generation the platform ended, and why". Each is written through its own before/after compare or wrapper: abort() at :437-443, `#abortForRestart` at :1425-1430 and `#deleteFacet` at :1447. `#call`'s catch at :1302-1323 then reads them back through three ordered branches with three different guards:

- the abort branch catches any error;
- the restart branch catches anything except TIMEOUT;
- the deletion branch re-codes only when the runtime's text is exactly "Facet was deleted.".

On top of that, `#liveFacetNames.delete` is repeated by hand at five sites. The one at :440 is already redundant, because `#restartAll` deletes the name again at :536.

The candidate's proposed shape is mis-specified in two ways:

- **The name@generation map leaks.** It gains one entry per abort or restart and nothing ever removes one. A facet that keeps timing out would grow it for the life of the incarnation.
- **The 'recovery' sentinel changes behaviour.** It would mark any error on a generation a recovery ended as recoverable. A call's own application error that raced a sibling's recovery would then be run again inline, on the replacement.

The per-name variant has a different problem. A call still in flight on an older generation loses its code if the facet ended a newer generation before that call's catch ran, and that can now happen across kinds. It is a real (if narrow) risk: an abort, then the next start finding a new loaded identity. The call would then skip its catch-up and be reported as an issue.

The amended shape makes the generation an object that the call already holds, and records how it ended on that object. There is then no map to look up, no race and no leak. It is measured and tested in the scratch worktree.

What changes in behaviour:

1. **Deletion.** Any error other than TIMEOUT on a deleted generation becomes NO_FACET, not only the runtime's exact text. Deletion only follows a hosting row's removal or `secrets.delete`, so in subscription-delivery.ts :812 and :818 this is the removal outcome, not an issue. In `reviveDueClaims` (:386-415), the old behaviour for an application error raced by a deletion was to report an issue and put back a claim on a facet that no longer exists; that goes away.
2. **Abort on request.** A TIMEOUT on a generation that was aborted on request now stays TIMEOUT instead of FACET_ABORTED. This cannot happen in practice. The abort cuts off in-flight calls at once (facets.test.ts:175 has a comment saying "Seconds, not the 60 s watchdog"). A watchdog that fires first restarts the facet, which ends that generation as FACET_RESTARTED, and that code already leaves TIMEOUT alone.
3. **Late calls.** A call still in flight on an old generation is never de-coded any more. Today it loses its code when a newer generation ended the same way first. This is strictly better than today.
4. **Live set on the timeout path.** In `#restartAll`, the name is now removed only when the abort's generation guard passes. That only matters on the timeout path, when the generation already moved on, and then the facet really is running under a newer generation.

The recovery's text match at :1005 stays exactly as it is.

No guarantee is dropped: every code that subscription-delivery.ts (:558, :788, :798, :801, :818) and `reviveDueClaims` rely on is still produced. It is genuinely simpler:

- three ended-generation maps and two before/after compare idioms become one optional `endedBy` field;
- `#call`'s 22-line catch becomes 3 lines;
- the five hand-written live-set deletions (:440, :536, :963, :1129, :1299) move into the one abort helper;
- the redundant generation `if` at :1297 goes.

The payoff is moderate: −18 lines in a central file, and one latent race closed.

## One copy-out of a Workers-RPC answer and one disposer, instead of five drifted copy-out blocks and four ways to dispose

- Sweep index: 13; risk: low; payoff: 4/10
- LOC: - 6 files (dispatch, facet-host, rule-snapshots, cf-artifacts, rpc-stubs, rpc-stub-relay): about −17 net, measured with oxfmt simulations.
- Adding context-stub.ts and subscription-delivery.ts's inline disposes: about −38 net over 8 files, estimated from spans. 63 lines today become about 25. (skeptic measured: I applied the proposal to scratch copies of the 8 files and formatted both the before and after sets with the repo's oxfmt config. `git diff --no-index --shortstat` gives 44 lines added and 66 removed, so net −22. The candidate's −38 is overstated.

Per file, net:

- facet-host −12
- cf-artifacts −8
- rpc-stubs −6
- context-stub −4
- subscription-delivery −2
- rule-snapshots −1
- rpc-stub-relay +2 (the two `.then` callbacks reformat onto several lines)
- dispatch +5 (the helper plus a 3-line doc)

Roughly −17 of the saving comes from the copy-out half and about −5 from the disposer half.)

- Concepts: 5 copy-out blocks and 4 disposer spellings become 1 copiedOffSession and 1 releaseRpcSessions.

### Evidence

Merged from three hunts: builtins parallel, builtins heavy, and routing parallel.

The five copy-out blocks:

- apps/os/src/context/dispatch.ts:222-230, the tail of itxAnswerDetachedFromSession.
- facet-host.ts:1328-1344, #call. It uses `Symbol.dispose in result` and a raw dispose. It also has an inline late-answer dispose at :1286-1291.
- cf-artifacts.ts:97-106. Its comment says 'facet-host.ts #call says why'.
- rule-snapshots.ts:136-140.
- src/context-stub.ts:115-121.

The disposers:

- iterate/lib `releaseRpcSessions` (packages/iterate/src/lib.ts:158-166). It reports a throw and never rethrows it.
- rpc-stubs.ts:146-151 `disposeRpcStub`, documented as 'THE one disposer'. It is used 3 times there and 4 times in rpc-stub-relay.ts.
- cf-artifacts.ts:134-141 `release`, used 4 times.
- Inline disposes at facet-host.ts:1289 and :1341, and subscription-delivery.ts:990-991.

### Current shape

Each module has its own 'structuredClone the answer, dispose the original, pass it through if it cannot be cloned' block. The copies use different predicates and different releases. The facet host calls the disposer raw, so a disposer that throws fails a facet call whose answer had already arrived. Two helpers each claim to be 'the one' disposer.

### Proposed shape

```ts
// dispatch.ts, beside isRpcResultWithDisposer
export function copiedOffSession<T>(answer: T): T {
  if (!isRpcResultWithDisposer(answer)) return answer;
  let copy: T;
  try {
    copy = structuredClone(answer);
  } catch {
    return answer;
  } // a stub, a stream, a Response
  releaseRpcSessions([answer]);
  return copy;
}
```

The five call sites become `return copiedOffSession(result)`.

Delete `disposeRpcStub`, cf-artifacts `release`, and the three inline disposes. Each becomes `releaseRpcSessions([x])`.

### What changes

Throwing disposers:

- A disposer that throws after a successful copy is reported as `itx-expression.release-rpc-session` instead of failing the facet call.
- The same applies to a stub disposal that throws.

Answers with no disposer, and uncloneable answers:

- rule-snapshots, cf-artifacts and context-stub pass an answer with no disposer through uncopied. Only test fakes lack a disposer.
- Those three sites hand through an uncloneable answer where they used to throw. They only ever receive data.

Everything else is identical.

### Pinned by

- src/context/dispatch.test.ts:225-331
- cf-artifacts.test.ts:119 and :569
- rule-snapshots.test.ts
- rpc-stubs.test.ts
- rpc-stub-relay.test.ts (dispose counts)
- e2e/context-residency.e2e.test.ts (careless-caller rows around :150 and :550)
- **workers-tests**/alarm-and-pins.test.ts:56

### Skeptic's amended proposal

Put the helper in apps/os/src/context/dispatch.ts, next to `isRpcResultWithDisposer`. dispatch.ts imports only capnweb, iterate/expression and iterate/lib, so no import cycle is added.

```ts
/** `answer`'s data, off the Workers-RPC session that answered it: an answer with a disposer is copied
 *  and the original released; one without, or one no copy can carry (a stub, a stream, a Response,
 *  data holding a stub), is handed through as it is, the holder's to release. */
export function copiedOffSession<T>(answer: T): T {
  if (!isRpcResultWithDisposer(answer)) return answer;
  let copy: T;
  try {
    copy = structuredClone(answer);
  } catch {
    return answer;
  }
  releaseRpcSessions([answer]);
  return copy;
}
```

Call sites:

- **dispatch.ts:** `itxAnswerDetachedFromSession`'s tail becomes `return copiedOffSession(result);`.
- **facet-host.ts:1333-1345:** `return copiedOffSession(result);`. Keep the 3-line why-comment about aborted facets pinning the actor.
- **facet-host.ts:1289:** `(answer) => releaseRpcSessions([answer])`.
- **cf-artifacts.ts `withArtifactRepoHandle`:** `return copiedOffSession(await answeredInTime(...));`, and `finally { releaseRpcSessions([handle]); }`.
- **cf-artifacts.ts `answeredInTime`:** `answer.then((late) => releaseRpcSessions([late]), () => {})`.
- **cf-artifacts.ts:** delete `release`, and point the header comment at `copiedOffSession` instead of 'facet-host.ts #call says why'.
- **rule-snapshots.ts:139:** `const answered = copiedOffSession(result);`. Drop the iterate/lib import.
- **context-stub.ts:115:** `return copiedOffSession(found) as StreamEvent;`, with no try/finally.
- **rpc-stubs.ts:** delete `disposeRpcStub` (146-151). Its 3 uses and the relay's 4 become `releaseRpcSessions([x])`, imported from iterate/lib.
- **subscription-delivery.ts:989-991:** `releaseRpcSessions([await walked]);`.

Optional, left out of the measurement: library.ts:297-303 silently swallows a throwing dispose. It could also become `releaseRpcSessions([value])`, but that turns a deliberate silent swallow into a reported issue, so do it only if that noise is wanted.

Concepts: 5 copy-out blocks (3 predicates, 2 release styles) and 3 disposer spellings (`releaseRpcSessions`, `disposeRpcStub`, `release`), plus 3 inline disposes, become 1 `copiedOffSession` and 1 `releaseRpcSessions`.

Pinned by:

- dispatch.test.ts:225-331
- cf-artifacts.test.ts:119 and :569
- rule-snapshots.test.ts
- rpc-stubs.test.ts:179
- rpc-stub-relay.test.ts
- **workers-tests**/alarm-and-pins.test.ts
- the careless-caller rows in e2e/context-residency.e2e.test.ts

Risk is low.

### Skeptic's verdict

Checked against origin/main at b3daf4846. PR #3446 is merged and touches none of these lines. No open PR overlaps.

**(a) The semantics are almost identical, and I confirmed every item.**

The five copy-out blocks exist as described:

- dispatch.ts:221-229
- facet-host.ts:1334-1344, which uses a `Symbol.dispose in` predicate and a raw dispose
- cf-artifacts.ts:99-102, which has no predicate and no catch
- rule-snapshots.ts:139-140, which has no predicate and no catch
- context-stub.ts:115-121, which uses try/finally and rethrows a DataCloneError

The behaviours that change:

1. **A disposer that throws** is reported through reportIssue as `itx-expression.release-rpc-session` instead of propagating. This covers the facet-host copy-out and its late-answer dispose, the subscription-delivery push result, the 4 `disposeRpcStub` sites in rpc-stubs and the 4 in the relay, and cf-artifacts `release`.
   - Workers-RPC and capnweb disposers do not throw in practice, so this is theoretical.
   - Where it could happen, it is a small fix: a delivered batch would no longer be failed and redelivered because of a dispose.
   - In the relay's liveness probe, a dispose throw would now count as "answered" instead of rejecting the race.
   - The failure-site label is slightly misleading for relay stubs.
2. **An answer with no disposer** is passed through uncopied at cf-artifacts, rule-snapshots and context-stub.
   - Production answers there are always Workers-RPC results. The snapshot read is `namespace.getByName(...).rulesSnapshot`, context-stub is a DO `invoke`, and cf-artifacts goes through the Artifacts binding.
   - Only test fakes lack a disposer. rule-snapshots.test.ts reassigns `owner.rules` rather than mutating it, and asserts with toMatchObject, so aliasing is harmless.
3. **An answer that cannot be cloned** at those three sites is handed through unreleased. Today it throws DataCloneError; context-stub releases first and then throws. Only plain data arrives there.
4. **facet-host's predicate** changes. A function-typed answer that carries a disposer now reaches structuredClone, which throws for a function, so the answer is handed through exactly as before.

No test pins any of these deltas:

- dispatch.test.ts rows ~296-322 (the data copy and its release, uncopied data built here, the unreleased stream and function holder) all hold, because the helper is dispatch's own tail.
- cf-artifacts.test.ts:119 and :569 count handle releases, which are unchanged.
- The relay and rpc-stubs tests count disposes, and those are unchanged.

**(b) Genuinely simpler.** Five drifted spellings, with 3 predicates and 2 release styles, become one named operation. The comments that point at each other ('facet-host.ts #call says why', 'dispatch.ts says why') collapse into one doc. Two local helpers that each claim to be 'the one disposer' (`disposeRpcStub`, cf-artifacts `release`) are deleted in favour of the existing `releaseRpcSessions`.

- The disposer half is lateral at each call site (`releaseRpcSessions([x])` versus `disposeRpcStub(x)`). Its value is fewer concepts, not fewer lines.
- This is not a 'shared saga helper' in the owner's sense, which is about domain entities. It is a runtime primitive like the `releaseRpcSessions` it sits next to.

**(c) No guarantee is dropped.** Every answer that carries a disposer is still copied and released. The actor-residency guarantee is kept by the same code, which is dispatch's current tail.

**(d)** Measured −22 net, not −38. This is a modest but real 'copy-pasted blocks that drifted' cleanup in central code, not heavy junk.
