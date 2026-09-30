# Sweep candidates: os-stream

Verified candidates from the 2026-09-29 codebase simplification sweep for this area. Each passed an adversarial skeptic check; where the skeptic amended the proposal, the amendment wins. Line numbers are as of origin/main on 2026-09-29 (about cfd8a1d36) and have drifted since: #3442, #3455 and #3460 touched some of these files. The index and the owner calls are in ../codebase-simplification-sweep.md.

## Cursor rows deliver durable events only, the rule fan-out rows already follow

- Sweep index: 20; risk: medium; payoff: 6/10
- LOC: Measured on scratch copies of the post-#3446 files. About −478 in total.

Product, −88:

- subscription-delivery.ts: 1962 → 1888 (−117/+43)
- stream.ts: 1030 → 1016

Tests, about −390:

- subscription-delivery.test.ts: −281 (536-636 and 676-853; 656-674 is inverted)
- memory-budget.test-support.ts: −63
- memory-budget.test.ts: −21
- e2e/cursor-delivery.e2e.test.ts: −25 (skeptic measured: Product −91 (subscription-delivery.ts 1962→1885 +51/−128; stream.ts 1040→1026 +2/−16). Tests −395 (subscription-delivery.test.ts +2/−288; memory-budget.test-support.ts −63; memory-budget.test.ts −23; e2e/cursor-delivery.e2e.test.ts −23). Net −486 across 6 files (55 insertions, 541 deletions), plus about +2 doc lines in packages/iterate/src/stream/processor.ts and iterate-context.ts. Measured on b3daf4846 (includes #3446) in a scratch worktree, all apps/os stream unit tests green.)
- Concepts: 5 concepts become 1.

Before:

- cursor rows reading the ring
- the at-mark reserve
- restart-after-wait plus claimArmsTheAlarm
- the eviction ledger plus its warning
- persist-on-durable-progress

After: the stream keeps a cursor only for what it can deliver again.

### Evidence

Merges the parallel and heavy hunts. Measured on origin/main cfd8a1d36, which includes #3446.

The two rules disagree:

- apps/os/src/stream/subscription-delivery.ts:37-38 says a cursor target 'receives ephemerals too'.
- 20 lines later, :499 and :1931 (`fanOutAdmits`) say 'Ephemerals are never a fan-out row's: nothing could deliver one again after an eviction.'

The ring machinery in subscription-delivery.ts:

- :97-98: the at-mark ring reserve
- :506-527: the idle fast path on an ephemeral head
- :695-706: `#adoptCursor`'s persist flag and clamp
- :1042-1045 and :1108-1111: `claimArmsTheAlarm`
- :1113-1144: the ring-sized reserve and the restart after the wait
- :1147: `includeEphemeral`
- :1154-1172: the eviction warning
- :1173-1175 and :1189-1193: `through` and `persist`

The ring machinery in stream.ts:

- :62-64: the RECENT_EPHEMERALS_BUDGET_CHARS export
- :162-163 and :348: the per-type eviction map
- :352-360: two accessors

No first-party cursor row names an ephemeral type:

- live-state, event-log, voice call-client and the agents feed are lent callbacks, so they get pushes;
- the voice-agent and processors are facet pushes;
- the envs.ts birth rows are `ordered: false`.

This came from #2833 and #2848 (rein-in 11 and 12), plus two Bugbot fixes.

### Current shape

A cursor row reads its batches with the recent-ephemerals ring merged in. That requires:

- a memory cursor ahead of the table cursor, clamped on write;
- an at-mark reserve the size of the ring;
- a restart after the room wait, with a hand re-arm of the alarm;
- per-type eviction tracking, only to warn.

All of this is best-effort, and one eviction loses it.

### Proposed shape

```ts
// onCommit, after the push branch:
if (!durable) continue; // ephemerals are never a stream-kept row's
// #drainCursor
if (cursor.confirmedOffset >= this.#stream.highestDurableOffset()) {
  /* spend any claim */ return;
}
claim(cursor.attempt + 1);
await this.#cursorReadCharsInFlight.acquire(CURSOR_READ_BUDGET_CHARS);
const page = this.#stream.read(cursor.confirmedOffset, 100); // no includeEphemeral
// #adoptCursor always persists, no clamp
```

Delete `claimArmsTheAlarm`, the ring reserve, the behindNow restart, the eviction warning, `persist`, `Stream.recentEphemeralsChars()`, `evictedEphemeralThroughOffset()` and its map, and the budget export.

The ring itself stays, for `readEvents({ includeEphemeral })` and waitForEvent.

### What changes

An ordered expression-target row that names an ephemeral type in `consumes` no longer receives those ephemerals. It needs a facet or a live callback instead, the same rule fan-out rows already follow.

The 'ring retry' and the `delivery.cursor.ephemerals-evicted` warning both go.

Unchanged:

- durable delivery: claim-before-read, the ladder, halt, read budget, the clamp to the durable mark, and move-along;
- ephemeral delivery to facets and callbacks.

No first-party row depends on this. A third-party cursor row that names an ephemeral type would silently stop getting it.

### Pinned by

- stream/subscription-delivery.test.ts: 538, 584, 610 (ring retry); 656 (to invert); 676, 738, 786, 804, 823
- stream/memory-budget.test.ts, scenario `cursor-rows-ephemerals-from-ring`
- e2e/cursor-delivery.e2e.test.ts:346
- **workers-tests**/ephemeral-offset-reuse.test.ts:33

### Skeptic's amended proposal

Cursor rows get durables only; the ring-merged cursor read goes, but the idle fast path, `persist` and the clamp stay.

onCommit, cursor branch: the fast-path test ignores ephemerals.

```ts
if (!events.some((event) => !event.ephemeral)) {   // no durable this row consumes
  /* idle fast path unchanged: memory moves to throughOffset, persisted only when `durable` */
  if (!durable) continue; // an ephemeral-only batch owes a cursor row nothing
}
void this.#deliverFromCursor(name)…
```

#drainCursor, after the resume and not-yet-due checks:

```ts
if (cursor.confirmedOffset >= this.#stream.highestDurableOffset()) {
  if (cursor.nextAttemptAtMs !== undefined) {
    const { nextAttemptAtMs: _s, ...settled } = cursor;
    this.#adoptCursor(name, { ...settled, attempt: 0 }, true);
  }
  return; // caught up: no await, no reserve, no claim
}
/* claim exactly as today (attempt+1, halt past MAX, adopt persist=true) */
await this.#cursorReadCharsInFlight.acquire(CURSOR_READ_BUDGET_CHARS);
inFlightRoomHeld = CURSOR_READ_BUDGET_CHARS;
page = this.#stream.read(cursor.confirmedOffset, 100); // no includeEphemeral
const through = page.scannedThroughOffset;
/* filter, trim room, replaced-check, empty-page and ack adopts pass `true` */
```

Delete:

- `claimArmsTheAlarm`, `ringChars`/`reserveChars`, the `behindNow` restart
- the eviction warning, the post-read caught-up block, the loop's `persist` const
- the RECENT_EPHEMERALS import
- in stream.ts: the export (the constant becomes module-private), `recentEphemeralsChars()`, `evictedEphemeralThroughOffset()` and its per-type map

Keep `#adoptCursor`'s `persist` parameter and its clamp: the fast path still puts the memory cursor on a head ephemeral.

Docs:

- subscription-delivery.ts header: ephemerals reach only targets that own their progress.
- `consumesEvent`: a named ephemeral type is delivered to a facet or live callback.
- `subscribe`: one clause saying the same.

Tests:

- Delete the three "ring retry" tests and the five at-mark/ring "alarm claim" tests.
- Invert "an ephemeral-only push to a caught-up cursor row is uninsurable" so it expects pushes [[1]].
- Drop the memory-budget scenario `cursor-rows-ephemerals-from-ring` and its two rows.
- Drop the e2e "ephemerals DO reach a caught-up cursor target" test.

### Skeptic's verdict

The semantics claim holds, but the proposal as written is wrong in one place and needs the amendment below.

(a) What changes. Only cursor rows change: ordered rows whose target is not a facet or a lent stub.

- A cursor row whose `consumes` names an ephemeral type stops receiving it.
- The ring retry of a refused ephemeral goes.
- The `delivery.cursor.ephemerals-evicted` log line goes. Nothing else references it.
- A cursor delivery's `range.through` is always the log's proof, never a head ephemeral.

No first-party code depends on this. I checked every ephemeral consumer:

- The voice-agent is a facet.
- live-state, event-log, voice-board, call-client, dash `Facts` and kit firmware all use lent callbacks.
- The envs.ts birth rows are `ordered: false`.
- The iterate/config checkout has no cursor row.

The browser-extension README already says only live subscribers see `chrome/*` events. Two docstrings need one clause each: `consumesEvent` ("a NAMED type opts in, INCLUDING ephemerals") and `subscribe`.

(b) The new shape is simpler. A row at the mark now returns before any await, so the restart-after-wait bug class and `claimArmsTheAlarm` go away. Every claim is written synchronously with its kick. Fan-out and cursor rows share one rule: the stream keeps state only for what it can deliver again.

(c) No real guarantee is lost. Ephemeral delivery to cursor rows was already best-effort: lost on eviction, on ring eviction, and while waiting for room. Durable at-least-once is untouched: claim before read, the ladder, halt, the budget, move-along.

(d) The proposal is mis-specified. Putting `if (!durable) continue` before the idle fast path, with "always persist, no clamp", freezes the memory cursor on the durable mark. The fast path compares the cursor against `afterOffset`, which is the head including ephemerals. Ephemeral heads are constant: every processor's live-state delta, every alarm trace, every presence event. So every later durable commit the row does not consume would miss the fast path. That costs a claim write, an alarm reconcile, a page read and a spend write per idle row per commit.

The amendment keeps the fast path, the `persist` flag and the clamp. Because those stay, `__workers-tests__/ephemeral-offset-reuse.test.ts` does not pin this change; it still passes.

Verified in a scratch worktree at b3daf4846:

- Before editing any test, exactly the 11 ring tests failed: 9 in subscription-delivery.test.ts and the 2 memory-budget rows. Nothing else failed.
- After deleting or inverting them, 464 unit tests pass.
- `tsc` is clean for apps/os (main and tests configs).
- The workers tests ephemeral-offset-reuse and alarm-and-pins pass, 17 of 17.
- The one full workers run had one failure: a rule-snapshots TTL-timing test under load, which passes when run alone. A second full run was killed before it finished, so the full workers suite is not proven.

LOC, measured with `git diff --numstat`:

- Product −91: subscription-delivery.ts 1962 → 1885 (+51/−128), stream.ts 1040 → 1026 (+2/−16).
- Tests −395: subscription-delivery.test.ts −286, memory-budget.test-support.ts −63, memory-budget.test.ts −23, e2e/cursor-delivery.e2e.test.ts −23.
- Total −486 across 6 files, plus about +2 doc lines.

Concepts go from 6 to 2, not 5 to 1. Before:

- ring-merged cursor reads
- a head-ephemeral `through`
- the ring-sized at-mark reserve
- restart-after-wait plus the hand re-arm
- the per-type eviction ledger plus its warning
- persist plus clamp

After: persist plus clamp, which now serve only the idle fast path, and the one shared rule.

Risk is low to medium. A third-party cursor row that names an ephemeral type goes silent. This cannot be refused at configure time, because ephemerality is set per append, not per type. Persisted cursors in production that hold a rung on an ephemeral are cleaned up by the new at-mark early return.

Owner caveat: this reverses the deliberate choice in rein-in 11 §1.3 (#2833) to keep ephemerals on cursor rows. #2848 and the Bugbot fixes then grew the machinery on top of that choice, so this is Jonas's call.

The amended diff is saved at scratchpad/skeptic-ring/amended.diff.

## One failure decision for facet rows instead of four partial classifiers that have drifted

- Sweep index: 21; risk: low; payoff: 5/10
- LOC: subscription-delivery.ts: −54 net (+38/−93, plus 1 for the TIMEOUT guard), measured on a scratch copy. Tests: about +8. (skeptic measured: I built the proposal faithfully on a scratch copy of apps/os/src/stream/subscription-delivery.ts, keeping a full doc comment on the new function: 1962 → 1922 lines, +49/−89, so −40 net. The candidate's −54 only holds if about 14 more comment lines are cut. Tests would need about +8 to +15 lines of new table rows for the new behaviours, since nothing pins them today. Where the lines go: #catchUpFacetRow loses 17 (its try/catch and recursion), #pushEventBatch loses about 40 (the nested inner/outer catch becomes one line), and the configure .catch loses 5. #reportFacetRowFailure (32 lines) is replaced by #facetRowFailed (about 50 lines including the doc comment). Verified on a scratch clone with the change applied: the unit file subscription-delivery.test.ts passes 277/277, the workers files facets.test.ts, facet-push-timeout-heals.test.ts and facet-timeout-restart-heals-sibling-push.test.ts pass 66/66 after a rebuild, and apps/os tsc --noEmit is clean.)
- Concepts: 4 partial classifiers become 1.

### Evidence

In apps/os/src/stream/subscription-delivery.ts, four places each decide part of what a facet-row failure means:

- :545-561 `#catchUpFacetRow`'s catch: halts on a deterministic failure, recurses on FACET_ABORTED/RESTARTED, else rethrows.
- :459-465 configure's `.catch`: pre-filters NO_FACET on a live row.
- :771-791 the push's inner catch: halts, or queues a catch-up on TIMEOUT/ABORTED/RESTARTED.
- :792-847 the push's outer catch and `#reportFacetRowFailure`: silences, logs or reports.

They have drifted:

- NO_FACET on a row that is still in place is silent on push (:811) and on configure (:463). The same error becomes reportIssue on resume (:441) and on catch-up-after-timeout (:864).
- An evaluation error never halts the row, but the same error thrown by the call does.

### Current shape

Facet-row failures are classified piecemeal, and each caller pre-filters a different subset of codes. So the same outcome is treated differently depending on whether it came from a push, a configure, a resume or a catch-up.

### Proposed shape

```ts
#facetRowFailed(action, name, row, afterOffset, error): void {
  const code = errorCode(error);
  if (deterministicFailure(error)) return this.#haltRow(name, row.configuredAtOffset, afterOffset, 1, error);
  if (code === 'FACET_ABORTED' || code === 'FACET_RESTARTED' || (action === 'deliver' && code === 'TIMEOUT'))
    this.#catchUpAfterPushTimeout(name, row);
  if (code === 'NO_ITX_EXPRESSION_MATCH' || code === 'FACET_ABORTED') return;
  if (code === 'FACET_RESTARTED' || code === 'NO_FACET') return /* log restarted/removed-in-flight when not the row */;
  const kind = failureKind(error);
  if (isPlatformFailureKind(kind)) return logPlatformFailure('subscription-delivery', action, kind, { name, message: String(error) });
  reportIssue(`subscription-delivery.${action}`, error, { name });
}
```

`#catchUpFacetRow` loses its try/catch. `#pushEventBatch` keeps one catch. The configure, resume and catch-up handlers all call this one decision. `#reportFacetRowFailure` goes.

### What changes

- NO_FACET on a live row is silent everywhere.
- A catch-up cut off by ABORTED/RESTARTED is retried once, chained behind the row's queued pushes, instead of by immediate recursion. It is also logged.
- A deterministic refusal while evaluating a push's target now halts the row.
- NO_ITX_EXPRESSION_MATCH at configure or resume is silent.
- A timed-out push still queues exactly one catch-up, and a catch-up that times out is still not retried.

### Pinned by

- stream/subscription-delivery.test.ts:1166 (table), :85, :113-212
- **workers-tests**/facets.test.ts:240, :305-318
- facet-timeout-restart-heals-sibling-push.test.ts:23-79
- uncontrolled-degradation.test.ts:142-144

### Skeptic's amended proposal

Change apps/os/src/stream/subscription-delivery.ts as follows.

- Configure (:459): `this.#deliveryRecordFor(name).deliveryChain = this.#catchUpFacetRow(name, row).catch((error) => this.#facetRowFailed("configured", name, row, row.configuredAtOffset, error));`
- Resume (:437-441): `void (targetOwnsProgress(state, row) ? this.#catchUpFacetRow(name, row).catch((e) => this.#facetRowFailed("resume", name, row, row.configuredAtOffset, e)) : this.#deliverFromCursor(name).catch((e) => reportIssue("subscription-delivery.cursor", e, { name })));`
- #catchUpFacetRow: evaluate the head; return if the row was superseded or the head is not a FacetHandle; then `await this.#catchUpFacetFromLog(head, this.#causeAt(row.configuredAtOffset));`. No try/catch, no recursion.
- #pushEventBatch: one try around the evaluation, the rpc-stub branch and the awaited facet push (acquire, call, release in finally); `catch (error) { this.#facetRowFailed("deliver", name, row, range.after, error); }`
- #catchUpAfterPushTimeout: its `.catch` calls `#facetRowFailed("catch-up-after-timeout", name, row, row.configuredAtOffset, error)`.

The new function replaces #reportFacetRowFailure:

```ts
#facetRowFailed(action: "resume" | "configured" | "deliver" | "catch-up-after-timeout", name: string, row: Subscription, afterOffset: number, error: unknown): void {
  const failureSite = `subscription-delivery.${action}`;
  const code = errorCode(error);
  if (deterministicFailure(error)) { this.#haltRow(name, row.configuredAtOffset, afterOffset, 1, error); return; }
  if (code === "FACET_ABORTED" || code === "FACET_RESTARTED" || (code === "TIMEOUT" && action === "deliver"))
    this.#catchUpAfterPushTimeout(name, row);
  if (code === "NO_ITX_EXPRESSION_MATCH" || code === "FACET_ABORTED") return;
  if (code === "FACET_RESTARTED" || code === "NO_FACET") {
    if (code === "FACET_RESTARTED" || !this.#isStillTheRow(name, row))
      console.log({ event: `delivery.${code === "NO_FACET" ? "facet-removed" : "facet-restarted"}-in-flight`, namespace: "subscription-delivery", failureSite, name, code, message: String(error) });
    return;
  }
  const kind = failureKind(error);
  if (isPlatformFailureKind(kind)) { logPlatformFailure("subscription-delivery", action, kind, { name, message: String(error) }); return; }
  reportIssue(failureSite, error, { name });
}
```

Consider renaming #catchUpAfterPushTimeout, since it now also retries a cut-off catch-up. Rewrite the configure comment at :446-450: a dangling facet row is silent, as cursor and fan-out rows are.

Semantic delta, stated in full:

1. A deterministic refusal while evaluating the target now halts facet and lent-rpc-stub rows, as it already does for cursor and fan-out rows. The row no longer heals itself when a rule change fixes it; an operator has to resume it.
2. A TIMEOUT, ABORTED or RESTARTED while evaluating a push's target queues a catch-up.
3. FACET_RESTARTED during a configure, resume or catch-up now logs a line.
4. NO_ITX_EXPRESSION_MATCH at configure or resume is silent. This drops the one-off configure-time issue for a dangling facet row.
5. NO_FACET on a live row is silent everywhere.
6. A cut-off configure or resume catch-up is retried at the end of the delivery chain, not its head.

Unchanged:

- A timed-out push gets exactly one catch-up, and a catch-up that times out is never retried.
- There is one halt fact per refusal.
- Platform failures are logged.

Tests to add as rows in the subscription-delivery.test.ts push-outcome table, or next to it:

- NO_FACET at resume on a live row gives no issue.
- An evaluation-time FORBIDDEN on a facet row halts it with one fact.
- A configure catch-up cut off by FACET_RESTARTED runs again after the queued push.

LOC: −40 in subscription-delivery.ts with a full doc comment kept (+49/−89), plus about +10 to +15 test lines.

### Skeptic's verdict

The claims hold, with some corrections. PR #3446 has already merged and is in origin/main (b3daf4846), and it doesn't touch any of these sites. #3445 (merged today) already calls #reportFacetRowFailure "the one place a facet row's failure is classified". This proposal finishes that job.

Is the drift real? Yes.

- NO_FACET on a live row is silenced before the reporter at :463 and :811, but not on resume (:441) or catch-up-after-timeout (:864). There it becomes reportIssue.
- The halt decision is written twice (:551, :775).
- The cut-off retry is written twice, and differently: immediate recursion at :558, a chained catch-up at :788.
- The silencing is split across the push's outer catch and a configure pre-filter.
- Git history (45a0bba52) shows the resume gap was never chosen on purpose: "keep today's handling".

(b) The new shape is simpler. The push loses its try-inside-try that rethrows into an outer catch. The catch-up loses its try/catch and recursion. The halt, retry, silence and report logic each appear once. There are 5 decision sites before and 1 after. The only special case is TIMEOUT, which triggers a catch-up only when the action is "deliver" (so a catch-up that times out never loops). That is easy to explain.

(a) Semantic changes are all small, but the candidate's list is incomplete. The full list:

1. A deterministic refusal while evaluating the target head (FORBIDDEN, NOT_A_METHOD) now halts facet rows and lent-rpc-stub rows. Today it is an issue on every commit, and the row heals itself if a rule change fixes it. After the change, an operator has to resume the row. Cursor rows (:1228 sits inside the try that halts at :1286) and fan-out rows already halt this way, so this makes the three kinds consistent.
2. Not disclosed by the candidate: a TIMEOUT, FACET_ABORTED or FACET_RESTARTED while evaluating a push's target now also queues a catch-up.
3. Not disclosed: FACET_RESTARTED during a configure, resume or catch-up now logs delivery.facet-restarted-in-flight. Today the recursion swallows it.
4. NO_ITX_EXPRESSION_MATCH at configure is now silent, which loses today's one-off configure-time issue for a dangling facet row. Cursor and fan-out rows already treat dangling as silent. The comment at :446-450 ("a target whose head cannot be evaluated is reported here, at configure") must be rewritten.
5. A catch-up that ABORTED or RESTARTED cut off at configure is now retried at the end of the chain, behind pushes already queued, instead of at its head. A push into the fresh instance heals the gap from the log (gap repair), and deliveriesQueuedFor still waits on all of it.
6. NO_FACET on a live row is silent everywhere.

(c) No guarantee is lost. #haltRow still dedupes, so there is still one fact per refusal. A push that timed out still gets exactly one catch-up, and a catch-up that times out is still not retried. The recursion was already unbounded, and the chained retry is too, at the same frequency. Platform failures still go through logPlatformFailure. All existing tests pass unchanged, which also shows none of them pin the drift.

Mis-specification to fix: the resume `.catch` at :441 also wraps #deliverFromCursor for cursor rows. The unified function must not apply its facet-only halting and catch-up to those rows. A cursor halt belongs to #haltCursorRow, which also spends the claim. Attach #facetRowFailed only to the catch-up branch, and give #deliverFromCursor the same reportIssue("subscription-delivery.cursor") catch as its three other call sites. In practice #deliverFromCursor catches its own failures, so this is about clarity, not a live bug.

Risk: low to medium. Change 1 is the only one that touches durable state (a halted event where today there are issues), and it only fires on refusals that can only repeat anyway.

## One 'still the row' check. Its stand-in lets a replaced cursor loop run against the new fan-out row (bug)

- Sweep index: 22; risk: low; payoff: 4/10
- LOC: subscription-delivery.ts: −16 net (+10/−26), measured on a scratch copy. Plus about +25 for a failing-first test. (skeptic measured: apps/os/src/stream/subscription-delivery.ts: +9/−25, so −16 net (git diff --no-index against a scratch copy of origin/main at b3daf4846, which includes #3446). oxfmt --check passes. If the new loop-top line (105 characters) gets wrapped, it adds about 2 lines. Tests: two new rows, about +55 lines (A/D pins the bug, B pins the kept cursor check). No other files change.)
- Concepts: 3 spellings of row identity become 1, and the cursor loop guards its own kind.

### Evidence

In apps/os/src/stream/subscription-delivery.ts, the check is written three ways:

- The helper `#isStillTheRow` (:850), used in the fan-out code at :1398, :1624, :1677, :1699 and :1795.
- Its body inlined at :539-543, :720-726, :914-918 and :1209-1213. `#haltRow` (:882) compares a passed-in offset instead.
- `#drainCursor` uses `if (!this.cursor(name)) continue` (:1229, :1240, :1255), and its loop top (:1051) checks only `targetOwnsProgress`.

The failure path:

1. A cursor loop is mid-call when its name is reconfigured to `ordered: false`.
2. `onCommit` forgets the record (:455), and `#persistFanOutCursor` adopts a fresh cursor.
3. The old loop's stand-in check passes, so its ack (:1245) overwrites the fan-out admission cursor.
4. The loop keeps calling the fan-out target in batches while the pump delivers the same events one by one.

### Current shape

'Was this row removed or replaced while I awaited?' is asked three ways. One of them, cursor presence, stops working whenever the replacement recreates a cursor. The cursor loop never checks that its row is still an ordered row.

### Proposed shape

Replace every site with `if (!this.#isStillTheRow(name, row)) return;`, using `continue;` inside the loop. The loop top becomes:

```ts
if (row.ordered === false || targetOwnsProgress(this.#stream.coreReducedState, row)) return;
```

### What changes

- Removal, and replacement by another cursor row or a facet row, behave identically.
- Replacement by an `ordered: false` row mid-call now drops the old batch's ack and ends the old loop. No batched `deliverEvent` calls, and no admission cursor overwritten.
- A push whose row was replaced, not only removed, before evaluation returns earlier than it does now.

### Pinned by

- stream/subscription-delivery.test.ts:183, :334 and :479
- e2e/cursor-delivery.e2e.test.ts, around :385
- No test covers a cursor row replaced by a fan-out row: a red row is needed first.

### Skeptic's amended proposal

In apps/os/src/stream/subscription-delivery.ts:

1. Use the existing `#isStillTheRow(name, row)` in place of the four inlined copies of the identity check:
   - `#catchUpFacetRow` :539-543
   - `#pushEventBatch` :720 and :722-726. Both sides of the evaluation become `if (!this.#isStillTheRow(name, row)) return;`.
   - `#haltCursorRow` :914-918
   - `#drainCursor` :1209-1213 (`continue`)

   Leave `#haltRow` as it is.

2. `#drainCursor`'s loop top (:1051) becomes:

   ```ts
   if (row.ordered === false || targetOwnsProgress(this.#stream.coreReducedState, row)) return;
   ```

   Probe D fails without this line.

3. At the three mid-flight sites (:1229, :1240, :1255), KEEP the cursor check and add identity. Do not replace one with the other:

   ```ts
   if (!this.#isStillTheRow(name, row) || !this.cursor(name)) continue;
   ```

   Add a comment saying the two halves do different jobs: identity catches a replaced row, including one replaced by a fan-out row that re-creates a cursor; cursor presence catches a row re-pointed at a facet by a rule commit, which keeps its `configuredAtOffset`.

4. Add two failing-first rows to subscription-delivery.test.ts:
   - A cursor row parked mid-call and reconfigured `ordered:false` with a backlog in the fan-out slots. After release, no batch call reaches `deliverEvent` and the fan-out cursor is left alone.
   - A cursor row parked mid-call and re-pointed at a facet, whose call is then refused with PERMANENT_FAILURE. The row is not halted, keeps no cursor, and `deadlines()` is `[]`.

Net −16 lines in the source, plus about 55 lines of tests. One PR.

### Skeptic's verdict

I ran this in a scratch copy with added tests. The bug is real, but the proposal as written would add a new bug of its own, so I amended it.

**(a) The bug is real, proven red on current main.**

- Probe A: a cursor row "s" is parked mid-call on itx.sink.push and gets reconfigured to `ordered:false` on itx.sink.deliverEvent. When the old call is released, the old loop's check at :1240, `if (!this.cursor(name)) continue`, passes. That check only tests whether a cursor exists, and the fan-out pump has already created a new one.
- The old loop then acks over the fan-out cursor, which loses its `route`. It loops, evaluates the NEW row's target and calls `deliverEvent(events, range)`: a batch array handed to a one-event method. The recorded singles were `[2, -1]`, and the `-1` is that array.
- Probe D: the same setup with the fan-out row's 8 slots full. The old loop still makes 1 batch call.

**The literal proposal breaks something else: replacing `!this.cursor(name)` with `#isStillTheRow` alone.**
Cursor presence has a second job: it detects a row re-pointed at a facet by a rule commit. The row keeps its `configuredAtOffset`, and `onCommit` deletes its cursor (:479-484). With identity checks only, the old target's outcome is acted on for a row that now owns its progress:

- Probe B: a PERMANENT_FAILURE from the old target HALTS the now-healthy facet row (`halted: {error: "poison"}`) and writes a stale cursor back.
- Probe C: a transient failure writes a ladder rung for that row, and `deadlines()` reports it. `deliverEveryCursorSubscription` skips rows that own their progress, so no pass ever spends that claim, and the alarm keeps firing until the next commit happens to clear it. This is the kind of alarm spin #3446 just fixed.
- The existing 277 tests all pass under the literal proposal. Nothing pins B or C today. Test :1025 releases the parked call but asserts nothing afterwards.

**The amended version passes everything.** All 280 rows, including A, B, C and D, pass. Wider unit runs over src/stream, src/project and src/context fail only rows that also fail on the original code or only here, never because of this change:

- `world N` timeouts under load, which also fail on the original.
- templates.test.ts, which fails because the scratch repo has no origin/main.
- domain-connect timeouts.

**Is the loop-top guard needed?** Yes. Without `row.ordered === false`, probe D goes red.

**(b) Simpler?** Somewhat. Four copies of the same identity check collapse into the existing helper, and that part is mechanical. The honest concept count is 3 → 2, not 1:

- `#isStillTheRow` means "same row".
- `this.cursor(name)` means "still a cursor row, not re-pointed at a facet".

`#haltRow` compares a passed-in offset plus `halted`, so it stays as it is. One small change of behaviour: `#pushEventBatch`'s first check now also returns when the row was _replaced_, not only removed, before its target is evaluated. That is strictly safer, since a dead row's facet is never materialized.

**(c) Guarantees.** The literal proposal drops "a row re-pointed at a facet is never halted or given a claim by its old target's outcome". The amended version keeps it.

**(d) LOC.** −16 net, matching the claim. It is more a bug fix hidden by the inconsistent checks than heavy junk removed.

**Pinned by:** subscription-delivery.test.ts :183, :334, :479 and :1025. e2e/cursor-delivery.e2e.test.ts has no replacement rows, so the candidate's pointer to "around :385" is wrong. It needs the new rows A/D and B.

## owedCause reads what deadlines() decided is due, folding as it reads, so no longer a second 'due' rule that holds a page per row

- Sweep index: 23; risk: low; payoff: 3/10
- LOC: subscription-delivery.ts: −12 net (+14/−26), measured on a scratch copy. The fold-as-read part is about ±0. (skeptic measured: apps/os/src/stream/subscription-delivery.ts: 1962 → 1954, so −8 net (+21/−29), not −12. Measured on an APFS clone of origin/main (b3daf4846, which already contains #3446 as cfd8a1d36). The clone passes oxfmt and tsc. The saved diff is scratchpad/skeptic-owedcause.diff. Adding a test row to pin the new rule would add about 20 test lines.)
- Concepts: 2 definitions of 'due' become 1. Retained pages go from N to 1.

### Evidence

Merges the parallel simplification with the heavy hazard.

In apps/os/src/stream/subscription-delivery.ts:

- :372-387 `deadlines()` walks every record, including cursor claims and `fanOutClaim`.
- :393-418 `owedCause(dueBy)` walks the same records again with its own rule, `(cursor.nextAttemptAtMs ?? 0) <= dueBy && behind the mark`. It repeats `fanOutClaim`, which #3446 added to both walks.

The `?? 0` counts a cursor with no claim at all (a dangling row, or a fan-out backlog with no probe) as due. That contradicts the method's own doc: 'Only what is due'.

The hazard: `owed.push(...this.#stream.read(cursor.confirmedOffset, 100).events)` retains one page per owed row until `deepestCause` runs. A page is up to READ_PAGE_BUDGET_BYTES, 8 MiB (stream.ts:54). This happens synchronously in the alarm pass (iterate-context-durable-object.ts:1430). So 20 owed rows can hold 160 MiB, exactly what memory-budget.test.ts forbids on the commit path.

### Current shape

Two walks decide what delivery owes the alarm. They agree on fan-out records only because #3446 copied `fanOutClaim` into both, and they disagree on unclaimed cursor rows. The cause walk also keeps every owed page alive at once.

### Proposed shape

```ts
export type DeliveryDeadline = { name: string; at: number; attempt: number; offset?: number }; // offset: a fan-out record's
owedCause(dueBy: number): Cause | undefined {
  let owed: Cause | undefined;
  for (const { name, offset } of this.deadlines().filter(({ at }) => at <= dueBy)) {
    const events = offset !== undefined ? this.#readFanOutEvent(offset) : this.#pageAfterCursor(name);
    owed = deepestCause([owed, ...events.map((event) => event.source?.cause)]);
  }
  return owed;
}
```

### What changes

- A row that is behind but holds no claim no longer counts toward an alarm wake's cause, so the cause can only be as deep or shallower. This matches the doc.
- Peak memory drops from one page per owed row to one page.
- The alarm trace's deadlines gain `offset` for fan-out records.
- This composes with the alarm-sources table row.

### Pinned by

- stream/subscription-delivery.test.ts:2007 (rig wake cause)
- **workers-tests**/wake-causes.test.ts
- **workers-tests**/loop-guard.test.ts
- No row covers many large owed pages. A memory-budget row with N due cursor rows behind 8 MiB events would pin the fix.

### Skeptic's amended proposal

In apps/os/src/stream/subscription-delivery.ts, measured −8 net:

```ts
/** One row's claim on the DO's alarm, for `deadlines()` and the trace: the persisted
 *  `nextAttemptAtMs` and the attempt it belongs to — a fan-out record's names its event's `offset`. */
export type DeliveryDeadline = { name: string; at: number; attempt: number; offset?: number };

// in deadlines(), the fan-out push:
if (claim !== undefined)
  deadlines.push({ name, at: claim, attempt: delivery.attempt, offset: delivery.offset });

/** WHY AN ALARM COMES BACK FOR DELIVERY: the deepest cause among the events owed to the claims
 *  due by `dueBy` (`deadlines()`) — a fan-out record's event, or the next page after a row's
 *  cursor (a cursor row's batch, a fan-out row's backlog) — each at the cause it was stored with
 *  (cause.ts). Only what is due: one deep obligation later never deepens a wake for another. */
owedCause(dueBy: number): Cause | undefined {
  let owed: Cause | undefined;
  for (const { name, at, offset } of this.deadlines()) {
    if (at > dueBy) break; // deadlines() is sorted
    let events: StreamEvent[] = [];
    try {
      events =
        offset === undefined
          ? this.#stream.read(this.cursor(name)!.confirmedOffset, 100).events
          : this.#readFanOutEvent(offset);
    } catch {
      // an unreadable batch halts its row when the pass reaches it; it causes nothing here
    }
    owed = deepestCause([owed, ...events.map((event) => event.source?.cause)]);
  }
  return owed;
}
```

What changes:

1. A behind row with no claim no longer deepens an alarm's `itx/woken` cause. That covers dangling cursor rows, fan-out backlog past its probes, and unadmitted fan-out backlog while every slot is full. The cause can only get shallower, and every claimed obligation still counts, so the loop guard holds.
2. Peak memory falls from one page per owed row to one page.
3. A fan-out entry in the alarm trace's `deadlines.delivery` gains `offset`.
4. Read errors from `#readFanOutEvent` other than EVENT_UNREADABLE are swallowed instead of failing the pass.

The `highestDurableOffset` guard goes. A claimed row that is already caught up now reads an empty page.

Concepts: 2 'due' rules become 1, and retained pages go from N to 1.

Pinned by:

- subscription-delivery.test.ts, "a wake handler appending work that fails climbs one hop a lap, stops at 8", plus the 'world N' property rows (verified by mutation);
- **workers-tests**/wake-causes.test.ts and loop-guard.test.ts.
  All of them pass with this change.

Add two rows:

- a unit row: a dangling cursor row with a depth-7 backlog plus a depth-1 due retry wakes at depth 1;
- optionally, a memory-budget row: N due cursor rows behind about 7 MiB events, with the alarm wake's owedCause surviving the 128 MiB cap.

Risk: low.

Out of scope, and unchanged by this proposal: both the old and new versions read the page after the cursor unfiltered by the row's `consumes`, so they count the causes of events the row will skip.

### Skeptic's verdict

I checked this against main at b3daf4846. #3446 is already merged there as cfd8a1d36, and it added `fanOutClaim` to both walks.

(a) Semantics. I applied the change to a clone and ran the tests. All of these pass:

- the unit suites subscription-delivery.test.ts and memory-budget.test.ts: 297 pass and 3 expected fails;
- the workers suites wake-causes.test.ts and loop-guard.test.ts: 35 pass.

owedCause really is load-bearing. With it mutated to return undefined, "a wake handler appending work that fails climbs one hop a lap, stops at 8" fails, so the wake's cause is part of the loop guard. The proposed shape keeps every claimed obligation, so that row stays green.

The only behaviour that changes is that behind rows with no claim stop deepening an alarm's `itx/woken` cause:

- dangling cursor rows;
- fan-out backlog past its probes;
- a fan-out row's unadmitted backlog while its 8 slots are full.

No test pins that behaviour. The `?? 0` came in deliberately with commit 5e4908983, so this is a policy change and not just a bug fix. Still, it matches the doc ("whose claim is [due]"), the commit's stated principle ("never by work owed later"), and facet-host.owedCause's own shape: claims filtered by `at <= dueBy`.

The old rule was also inconsistent. It counted unclaimed cursor rows but not unclaimed fan-out records, even though the pass pumps both. And it can wrongly deepen a depth-1 heartbeat's wake with the backlog of an unrelated dangling row.

(c) No guarantee is dropped:

- Unclaimed work never arms the alarm, because it is not in `deadlines()`. So an alarm-driven loop always runs through a claim, and claims still count.
- The work the pass does runs under its events' own causes (`runAsDelivery`), whatever the wake's depth.
- The hazard the candidate names is real. owedCause keeps every owed page alive until `deepestCause` runs, which bypasses the CURSOR_READ_BUDGET_CHARS guard. That constant's own doc warns that 20 rows × 8 MiB is a reset, and here it would happen inside the alarm pass, which the runtime retries. Folding as each page is read keeps one page alive at a time.

(b) The new shape is simpler, though only modestly:

- one walk and one 'due' rule instead of two parallel walks that #3446 had to patch in both places;
- −8 lines, not the −12 claimed.

The trace's fan-out deadlines gain `offset`. No test asserts toEqual on a non-empty deadline list, so nothing breaks there.

Two things to fix in the spec:

- The candidate's `#pageAfterCursor` helper is unnecessary. The read can be inlined.
- With the reads under one bare catch, errors from `#readFanOutEvent` other than EVENT_UNREADABLE are now swallowed instead of failing the pass. The cursor branch already swallowed everything, so this is harmless, but it should be stated.

It is small. It is not heavy junk, but it is two mechanisms doing one job that have already drifted apart, plus a latent OOM.

## Drop the persisted FNV route digest that retries every pending delivery of a fan-out row at once after a re-point

- Sweep index: 24; risk: low; payoff: 5/10
- LOC: Product: about −61.
- subscription-delivery.ts: 1962 → 1911 (−57/+6, then −2)
- stream.ts: −4
- itx-expression-rewriting.ts: about −4

Tests: about −14. (skeptic measured: I applied the deletion to scratch copies and counted with wc -l.

Product: 4242 → 4179 lines (−63).

- subscription-delivery.ts: 1962 → 1908 (−60/+6)
- stream.ts: 1040 → 1036 (−4)
- itx-expression-rewriting.ts: 1240 → 1235 (−10/+5)

Tests: 3285 → 3271 lines (−14).

- subscription-delivery.test.ts: 2459 → 2449 (the rig's routeOf option is gone, and test 1473 loses its re-point half and `publication` variable)
- memory-budget.test-support.ts: 826 → 822 (four `routedTo:` stubs)

Total: −77.)

- Concepts: 4 concepts (routedTo, persisted digest, FNV hash, retry-pending-now) become 0.

### Evidence

In apps/os/src/stream/subscription-delivery.ts:

- :231-232 `EvaluatedTargetHead.routedTo`
- :282-286 deps
- :924-930: a docstring that needs 7 lines to explain lazy learning
- :948-957 digest compare, cursor write and `#retryPendingNow`
- :971-976 and :1005
- :1347-1348
- :1870-1884 `#retryPendingNow`
- :1952-1962 `routeDigestOf`, an FNV-1a hash of a string that 'may carry a whole worker source', re-hashed on every re-evaluation

Elsewhere:

- stream.ts:743-746 persists `SubscriptionCursor.route`.
- itx-expression-rewriting.ts:1033-1042 JSON-stringifies `[route.at, ran]` only for this.

This was added in #3425 on 09-29. Since #3446, refusals of an unpublished config are passed over (subscription-delivery.ts:1713-1719), so only a republish after failures relies on the digest.

### Current shape

Every evaluation of a fan-out target returns where it resolved as a string. That string is FNV-hashed and compared against a digest persisted on the row's cursor. When they differ, the cursor is rewritten and every pending record is pulled to now.

### Proposed shape

`evaluate()` returns `{ value, validUntil }`. `#evaluateTargetHeadForRow` becomes only the memo:

```ts
const evaluated = await this.#evaluateItxExpressionTargetHead(name, row.target);
this.#deliveryRecordFor(name).evaluatedTargetHead = {
  configuredAtOffset: row.configuredAtOffset,
  rewriteRulesRef,
  ...evaluated,
};
return evaluated;
```

Delete `routedTo`, `SubscriptionCursor.route`, `routeDigestOf`, `#retryPendingNow` and the table note.

### What changes

After a fan-out target is re-pointed (in practice, a republished config after failures), pending retries fire at their own rung instead of all at once.

Rungs follow 1 s·2ⁿ, capped at 30 min (4 h for webhooks). So:

- an event with 8 or fewer failures still retries within about 4 min;
- a deep one waits up to 30 min after the fix.

The cursor is no longer rewritten on a route change. The evaluation memo, validUntil, dangling probes and the #3446 pass-over are unchanged.

### Pinned by

- stream/subscription-delivery.test.ts:1473: its re-point half (1493-1499) flips.
- The rig's `routeOf` option (1928-1938, 1991).
- memory-budget.test-support.ts `routedTo:` stubs.

### Skeptic's amended proposal

Delete the route digest mechanism outright.

In subscription-delivery.ts:

- Remove `EvaluatedTargetHead.routedTo`, and `routedTo` from the `evaluateItxExpression` deps type and its docstring.
- Remove the fan-out block at 948-957 and `#retryPendingNow` (1870-1884).
- Remove `routeDigestOf` (1952-1962) and the table's exception clause (1347-1348).
- Shrink the 7-line docstring at 924-930 to one line.
- `#evaluateTargetHeadForRow` becomes only the memo:

```ts
const evaluated = await this.#evaluateItxExpressionTargetHead(name, row.target);
this.#deliveryRecordFor(name).evaluatedTargetHead = {
  configuredAtOffset: row.configuredAtOffset,
  rewriteRulesRef,
  ...evaluated,
};
return evaluated;
```

In stream.ts, drop `SubscriptionCursor.route` (753-756).

In itx-expression-rewriting.ts, `evaluate` no longer builds `JSON.stringify([route.at, ran])`. Either destructure `{ value, validUntil }`, or drop `route` from `#dispatch`'s return and write `evaluate(call) { return this.#dispatch(call, []); }`.

Tests:

- Trim test 1473 to its memo half. Retitle it "…a pending retry keeps its rung" and assert the rung stands.
- Delete the rig's `routeOf` option.
- Delete the four `routedTo:` stubs in memory-budget.test-support.ts.

Corrections to the candidate's semantic delta:

- Rungs are 1 s·2^(n−1), not 1 s·2ⁿ. A record with 8 or fewer failures waits at most about 2.5 min, and only 11 or more failures reach the 30 min cap.
- State the upside as well: a republish of a config that is still broken no longer spends one attempt from every pending record.
- Stale `route` keys already in prd cursors are inert and need no migration.

Commit framing: fan-out retries keep their rung. A fix reaches older failures at their next attempt, as a pointer's first landing already does.

### Skeptic's verdict

The candidate holds up against origin/main b3daf4846, which already contains #3446 as cfd8a1d36. All line references are accurate.

(a) Semantics. The mechanism only matters for fan-out records that sit on a ladder rung after the resolved target threw or timed out.

- Dangling records are not affected. They have nextAttemptAtMs null, and `dueRecord` already treats null as due, so the digest's null-to-now rewrite only changed their tie order.
- Unpublished-config refusals are not affected either: #3446 passes them over.

So the change is exactly this: after a republish or rule re-point that fixes a throwing target, each pending record waits for its own rung instead of all firing at the next fresh evaluation.

- The ladder is 1 s·2^(n−1) ±20%, capped at 30 min (4 h for webhook rows reached through a rule).
- A record with 8 or fewer failures waits at most about 2.5 min; one with 9 waits about 5 min; one with 11 or more waits up to 30 min.
- The digest never gave a paused row more than this anyway. A paused row admits nothing new, so the first evaluation after a fix already waited for the next probe or rung.
- #3425's own PR body accepts rung-bounded latency for the analogous case: "a pointer's first landing reaches a waiting context within that context's current probe rung".

Dropping the digest also changes a few other things:

- It removes a hidden downside. Every republish of a still-broken config pulls every pending record to now and spends one attempt from each. Fifteen quick republishes while debugging could dead-letter every pending event in minutes, where the ladder would have given them about 2.5 h.
- It removes one durable cursor write per fan-out row per route change, including each row's first evaluation.
- It removes a JSON.stringify plus FNV hash of the route on every fresh evaluation, at most once per 5 s per row.

Only one test pins the behaviour: subscription-delivery.test.ts:1473, whose re-point half (1493-1499) flips. No Workers test, e2e test or spec depends on it.

(b) The new shape is really simpler. `#evaluateTargetHeadForRow` becomes a pure memo, and four concepts disappear:

- `routedTo`, a type threaded through resolver, deps and head;
- the persisted `SubscriptionCursor.route`;
- the FNV digest;
- `#retryPendingNow`, together with the exception clause in the fan-out table.

The 7-line docstring was a "hard to explain" sign.

(c) No delivery guarantee is dropped. At-least-once delivery, attempt counts, dead letters, the pause, dangling probes, the evaluation memo and validUntil are all unchanged. Stale `route` keys already stored in prd cursors are carried along by the `#fanOutCursor` spread and compare as equal, so they are inert and need no migration.

(d) I re-measured the LOC by applying the change to copies of the files (see locMeasured).
