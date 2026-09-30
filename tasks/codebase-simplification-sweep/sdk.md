# Sweep candidates: sdk

Verified candidates from the 2026-09-29 codebase simplification sweep for this area. Each passed an adversarial skeptic check; where the skeptic amended the proposal, the amendment wins. Line numbers are as of origin/main on 2026-09-29 (about cfd8a1d36) and have drifted since: #3442, #3455 and #3460 touched some of these files. The index and the owner calls are in ../codebase-simplification-sweep.md.

## A facet's live state is connected one way, not three: the agents page stops subscribing to the same facet twice

- Sweep index: 54; risk: medium; payoff: 4/10
- LOC: About −115 net:
- react.tsx: 509 → about 380
- live-state.ts: 254 → about 300
- use-agent-summaries.ts: 104 → about 72 (skeptic measured: Measured on oxfmt-formatted drafts (tsc clean on the SDK copy):
- packages/iterate/src/client/react.tsx: 509 → 370 (−139)
- packages/iterate/src/client/live-state.ts: 254 → 314 (+60, including the moved result types and the FacetLiveSnapshot schema)
- apps/agents/src/lib/use-agent-summaries.ts: 104 → 96 (−8)

Net: −87 lines of code. Also:

- about 16 doc lines that mention `useLiveState` get reworded;
- +30 to 40 lines if a watchFacetLiveState test is added;
- the agents page: ±1 line.)
- Concepts: Before, 7: 4 connect-and-mirror mechanisms and 3 seed parsers.
  After, 2: `watchFacetLiveState` and one seed schema.

### Evidence

The same connect loop exists three times:

- packages/iterate/src/client/react.tsx:51-122 `useLiveState`. It is generic, and `useFacetLiveState` is its only caller.
- react.tsx:343-404 `useIterateContext`, which hand-rolls the same connect/onResync/late-dispose loop and casts the seed at :367.
- apps/agents/src/lib/use-agent-summaries.ts:18 and :49-96, which has its own zod `Seed`.

The duplicate subscription:

- apps/agents/src/routes/_auth/projects.$slug.tsx:295 opens `agent` through the default live-state set (react.tsx:330-336; packages/agents/src/collection.ts:101 enables the row).
- :366-368 then calls `useFacetLiveState(context, 'agent')`, which opens it again.
- The playbook already flags this: .agents/skills/os-web-performance/references/playbook.md:54.

### Current shape

Three places each wire `connectLiveState` to a facet's `liveSnapshot()`, each with its own disposed flag, abort controller, late-connect dispose and status mapping. They parse the seed three different ways, and one page holds two subscriptions for the same facet.

### Proposed shape

```ts
// client/live-state.ts
export function watchFacetLiveState(itx: LiveStateItx & { invoke(call: string): Promise<unknown> }, facet: string,
  onChange: (state: LiveStateResult) => void): () => void
// react.tsx
export function useFacetLiveState(itx, facet) { const [held, setHeld] = useState<…>();
  useEffect(() => itx && watchFacetLiveState(itx, facet, (state) => setHeld({ itx, facet, state })), [itx, facet]);
  return held?.itx === itx && held.facet === facet ? held.state : LIVE_STATE_CONNECTING; }
// useIterateContext: names.filter((n) => n !== 'core').map((name) => watchFacetLiveState(itx, name, (s) => patch(name, s)))
// agents page: const live = iterateContext.liveState.agent
```

Delete `useLiveState`. IterateContextHandle becomes `EventLogItx & { subscriptions; rpcStubs; invoke }`.

### What changes

- `useLiveState` leaves iterate/react. No code calls it; docs need a line each.
- useIterateContext zod-parses per-facet seeds. A malformed seed becomes `status: 'error'` instead of a cast.
- useFacetLiveState uses setState, so it loses useSyncExternalStore's no-tearing guarantee.
- On the agents page, `agent` appears one `subscriptions.list()` round trip later on first paint, and one subscription is saved.

### Pinned by

- packages/iterate/src/client/live-state.test.ts
- apps/os/e2e/live-state-chains-client-side.e2e.test.ts
- No unit test covers the React hooks. The Dash, Agents, Notes and Voice specs cover the pages.

### Skeptic's amended proposal

Give the SDK one watcher for a facet's live state, and dedupe the agents page with an explicit name set, not the default one.

**1. client/live-state.ts** (exported through `iterate/client`):

- Move `LiveStateStatus` and `LiveStateResult` here, along with `const FacetLiveSnapshot = z.object({ rev: z.number(), state: z.unknown() })`.
- Add the watcher:

```ts
export function watchFacetLiveState(
  itx: LiveStateItx & { invoke(call: string): Promise<unknown> },
  facet: string,
  onChange: (state: LiveStateResult) => void,
): () => void {
  let stopped = false,
    stop = () => {};
  const unmounted = new AbortController();
  let held: LiveStateResult = { value: undefined, rev: null, status: "connecting" };
  const emit = (c: Partial<LiveStateResult>) => {
    if (!stopped) onChange((held = { ...held, ...c }));
  };
  connectLiveState<unknown>(itx, {
    key: facet,
    signal: unmounted.signal,
    readSeed: async () =>
      FacetLiveSnapshot.parse(await itx.invoke(`itx.facets.get('${facet}').liveSnapshot()`)),
    onResync: (r) =>
      emit(
        r === "healed"
          ? { status: "live", error: undefined }
          : { status: "error", error: r.message },
      ),
  }).then(
    (c) => {
      if (stopped) return void c.dispose();
      const unsubscribe = c.store.subscribe(() =>
        emit({ value: c.store.get(), rev: c.store.rev() }),
      );
      stop = () => (unsubscribe(), void c.dispose());
      emit({ value: c.store.get(), rev: c.store.rev(), status: "live" });
    },
    (e) => emit({ status: "error", error: e instanceof Error ? e.message : String(e) }),
  );
  return () => {
    stopped = true;
    unmounted.abort();
    stop();
  };
}
```

**2. react.tsx:**

- Delete `useLiveState` and its readSeedRef.
- Rewrite `useFacetLiveState` as:

```ts
const [held, setHeld] = useState<{ itx: unknown; facet: string; state: LiveStateResult }>();
useEffect(
  () => itx && watchFacetLiveState(itx, facet, (state) => setHeld({ itx, facet, state })),
  [itx, facet],
);
return itx && held?.itx === itx && held.facet === facet ? held.state : LIVE_STATE_CONNECTING;
```

- Replace the loop in `useIterateContext` at :343-404 (about 18 lines) with:

```ts
const stops = names
  .filter((n) => n !== "core")
  .map((name) =>
    watchFacetLiveState(itx, name, (state) =>
      setLiveStates((h) =>
        h && h.itx === itx && h.key === liveStateKey
          ? { ...h, entries: { ...h.entries, [name]: state } }
          : h,
      ),
    ),
  );
return () => stops.forEach((s) => s());
```

**3. use-agent-summaries.ts:**

- Replace `connectLiveState`, the `Seed` schema and the AbortController with `releases.push(watchFacetLiveState(context, "agent", ({ value, status, error }) => …))`.
- When `value === undefined && status === "error"`, record unavailable with `error` as the reason.
- Otherwise, record the summary.

**4. Agents page** (optional; drop it if the Events tab must list other hosted facets):

- Call `useIterateContext(context, { consumes: FEED_SUBSCRIPTION, history: "all", liveState: ["core", "agent"] })` and read `const live = iterateContext.liveState.agent`.
- This saves one subscription row per open page and keeps the fallback: `agent` opens at once, never waits on or reopens with the processors table, and still reads status "error" when the seed fails.
- What changes: the Events tab's processors panel shows live state only for `core` and `agent`, not for any other facet that a config hosts on an agent's context.
- Do NOT read the default set. If the table read fails, `idle` sticks at false, and whenever the set of hosted facets changes, `idle` flickers.

**5. Docs and tests:**

- Update the lines that mention `useLiveState` in docs/frontend-development.md, apps/voice/README.md and the os-web-performance skill.
- Add a watchFacetLiveState case to live-state.test.ts on its existing fake: stop while the seed is pending recalls the row, and a failed heal gives status error with the value kept.

### Skeptic's verdict

The main claim holds, but the numbers are inflated and the agents-page part is mis-specified.

**The SDK duplication is real.**

- `useLiveState` (react.tsx:51-122) is generic, and its only caller is `useFacetLiveState` (:127-136). Every app calls `useFacetLiveState`: dash ×5, notes, voice, agents and packages/ui's use-context-explorer.
- Its readSeed thunk, the `readSeedRef` pinning and the comment about cross-key contamination exist only because it is generic.
- `useIterateContext` hand-copies the same lifecycle at :343-404: a disposed flag, an AbortController, a dispose when the connect lands after unmount, and the onResync-to-status mapping. It also casts the seed at :367.
- use-agent-summaries.ts:18 and :59-78 is a third copy. It uses its own zod `Seed` and ignores onResync.
- None of this crosses PR #3446. On this page that PR only removes a cast at :176, and it does not touch react.tsx, live-state.ts or use-agent-summaries.

**I drafted it and measured it.** I wrote the drafts in scratchpad/lsx, formatted them with oxfmt and ran tsc on a copy of packages/iterate. tsc passes.

- react.tsx: 509 → 370
- live-state.ts: 254 → 314, which includes the moved `LiveStateResult`/`LiveStateStatus` types
- use-agent-summaries.ts: 104 → 96, not 72. Getting the project stub and running `cd` on each path stays, so only about 8 lines go.
- Net: −87 lines of code, not −115. On top of that, about 16 doc lines that mention `useLiveState` need rewording (docs/frontend-development.md, apps/voice/README.md, the os-web-performance skill), and a watchFacetLiveState test would add about 30-40 lines.

**Concepts: the candidate's "7 → 2" is inflated.**

- Public live-state names stay at 5: `useLiveState` goes and `watchFacetLiveState` comes in.
- What really drops: lifecycle copies go from 3 to 1, and seed handling (two parses, one cast) goes from 3 to 1.
- That makes it a real dedupe of copies that drifted, not a lateral rename.
- It is not a shared saga helper. It is the callback form of the SDK's own hook, and it lives in `iterate/client` next to `connectLiveState`.

**What changes in behaviour:**

1. `useLiveState` leaves the published `iterate/react` (0.4.1). No code in this repo passes a non-facet readSeed from React; the only one is the e2e test's `itx.chat.state()`, and it uses `connectLiveState`, which stays.
2. `useFacetLiveState` switches from `useSyncExternalStore` to setState. It loses protection against tearing in concurrent rendering, which is theoretical; `useIterateContext` already mirrors this way. It gains a fix: today, in the render right after the handle or facet switches, the old store's value still shows as "live".
3. `useIterateContext` zod-parses seeds instead of casting them.
4. In the summaries, a failed heal records the same summary again, which costs one extra render.
5. No guarantee is dropped. Unsubscribing while the first seed is pending, disposing a connect that lands after unmount, and the heal status all survive in `watchFacetLiveState`.

**The agents-page change as proposed is wrong.** It proposes `const live = iterateContext.liveState.agent` over the default set.

- The default set only includes `agent` once `subscriptions.list()` has answered and lists a hosted `agent` facet.
- If that read fails, `agent` never opens. `live` is then undefined (or connecting, with a default), so `idle` stays false and `reduceAgentFeed` never settles at the idle boundary. Today the page falls back to reading the log alone (projects.$slug.tsx:370-372).
- Any change to the set of hosted facets reruns the single effect keyed on the name set (:404). That reopens every facet subscription and briefly makes `idle` false.
- That regresses the fallback, so the page part needs an explicit name list, or should be left alone.

**Tests.** live-state.test.ts and the e2e test cover `connectLiveState`, which does not change. Nothing covers the hooks or the new function, so the new function needs its own test.

## The engine reads its log in one walk, `#reduceFromLog(until, atHeadPass)`, instead of gap repair, catch-up, and revive's extra slot gated by a flag

- Sweep index: 56; risk: low; payoff: 4/10
- LOC: processor.ts: −25 net (+27/−52), git diff --numstat of a scratch copy. All 294 packages/iterate tests pass unchanged. (skeptic measured: packages/iterate/src/stream/processor.ts goes from 1287 to 1264 lines, −23 net (+27/−50 by `git diff --no-index --numstat` against a scratch copy). That copy keeps a 5-line doc comment on `#reduceFromLog` and the 4-line gap-repair comment. The candidate claimed −25, which is close. The copy passes oxfmt --check and `tsc -p tsconfig.json`, and all 298 packages/iterate tests pass unchanged (15 files; stream/ alone is 82 tests).)
- Concepts: 5 mechanisms (2 loops, the extra slot, the side-channel flag, re-reduce per entry) become 2 (`#reduceFromLog`, and one re-reduce in the chain).

### Evidence

Merges the parallel and heavy hunts.

In packages/iterate/src/stream/processor.ts:

- :341 and :371: #rereduceIfVersionChanged is called at each entry point.
- :347-356: the gap-repair page loop.
- :369-393: catchUpFromLog's loop, a second copy.
- :247-249 and :553: `#lastBatchAtHead`. Every batch writes it; only revive reads it.
- :615-625: revive clears the flag, catches up, then queues a second chain slot that hand-runs `#reduceAndProcessEvent(null)` and publishLiveState.

Line numbers are pre-#3442; #3442 touched processor.ts (+30 lines).

### Current shape

Two loops page the log forward. One stops at a push's start without passing at head; the other runs to the head. revive() works by side channel: a flag, plus a separate hand-written eventless at-head pass.

### Proposed shape

```ts
async #reduceFromLog(until = Infinity, atHeadPass = false) {
  while (this.#reducedThroughOffset < until) {
    const after = this.#reducedThroughOffset;
    const page = await this.#stream.read(after, 500);
    const through = Math.min(page.scannedThroughOffset, until);
    const atHead = page.atHead && until === Infinity;
    if (through > after) await this.#reduceAndCommitEventBatch(page.events.filter((e) => e.offset <= through), { after, through }, atHead);
    else if (atHeadPass) await this.#reduceAndCommitEventBatch([], { after, through }, true);
    if (atHead) this.#showHeadReadFromLog(Math.max(after, through));
    if (atHead || through <= after) return;
  }
}
// processEventBatch: await this.#reduceFromLog(range.after); catchUpFromLog = () => chain(() => this.#reduceFromLog());
// revive: await chain(() => this.#reduceFromLog(Infinity, true)); #runOnSerialChain runs #rereduceIfVersionChanged once
```

Delete `#lastBatchAtHead`.

### What changes

Unchanged: gap repair, catch-up, the read verbs and waitUntilProcessed issue the same reads, checkpoints, caughtUp flags and deltas.

Only revive changes:

- Its catch-up and at-head pass now share ONE serial slot, so no push lands between them.
- If an at-head push was already queued and the revive finds nothing to read, the revive now runs its own idempotent pass.
- The re-reduce also runs at the head of revive's slot, where it is a no-op.

### Pinned by

- processor.test.ts: :248, :1283, :1314, and the 'fed by pushes' rows
- processor-rules.test.ts: :214, :232, :285, :306, :371-462
- apps/os e2e and workers revive rows (not run): facets.test.ts, alarm-and-pins, context-residency, agent-revive

### Skeptic's amended proposal

Keep as proposed, with three precise corrections:

1. Measured LOC is −23, not −25.
2. Extend `#runOnSerialChain`'s doc to say it runs the one pending version re-reduce first:
   `const run = this.#serialBatchChain.then(async () => { if (this.#latchedRefusal) throw this.#latchedRefusal; await this.#rereduceIfVersionChanged(); return work(); });`
3. State the revive delta as "a revive always runs exactly one at-head pass, in the same slot as its catch-up". Today it skips the pass when a batch ahead of it on the chain was at head and its catch-up read nothing.

Final shape:

```ts
async #reduceFromLog(until = Infinity, atHeadPass = false): Promise<void> {
  while (this.#reducedThroughOffset < until) {
    const after = this.#reducedThroughOffset;
    const page = await this.#stream.read(after, 500);
    const through = Math.min(page.scannedThroughOffset, until);
    const atHead = page.atHead && until === Infinity;
    if (through > after)
      await this.#reduceAndCommitEventBatch(page.events.filter((e) => e.offset <= through), { after, through }, atHead);
    else if (atHeadPass) await this.#reduceAndCommitEventBatch([], { after, through }, true);
    if (atHead) this.#showHeadReadFromLog(Math.max(after, through));
    if (atHead || through <= after) return;
  }
}
```

Call sites:

- `processEventBatch`: `await this.#reduceFromLog(range.after)`, then the push as today.
- `catchUpFromLog = () => this.#runOnSerialChain(() => this.#reduceFromLog())`.
- `revive`: `await this.#runOnSerialChain(() => this.#reduceFromLog(Infinity, true))`.

Delete `#lastBatchAtHead`, including its write in `#reduceAndCommitEventBatch`, and the hand-written eventless slot.

Pinned by:

- processor.test.ts:1283 and :1314;
- processor-rules.test.ts gap-repair and version-bump rows;
- workers facets.test.ts revive rows and agent-revive (not run).

### Skeptic's verdict

Checked against origin/main at b3daf4846. PR #3446 and #3442 are both merged there, and neither touches this region. The line evidence matches main as it is now: the flag at :247-249 and :553, gap repair at :340-356, catch-up at :369-393, revive at :615-625.

(a) Semantics. I walked every path.

- Gap repair (`until = range.after`) gives the same results. It issues the same reads and makes the same batches with atHead=false. It never calls `#showHeadReadFromLog`, and it stops the same way when the log runs out below range.after (the ephemeral case).
- Catch-up (`until = Infinity`) is also the same:
  - it sets the same atHead from the page;
  - it calls `#showHeadReadFromLog(after)` when there was nothing to read at head, and `(through)` otherwise;
  - it returns under the same conditions.
- The new `offset <= through` filter does nothing in practice. The engine's `read` is `itx.readEvents(after, limit)` without `includeEphemeral`. The rows it returns are never past `scannedThroughOffset`, because the stream writes rows and the durable mark in one commit. So the gap-repair filter is equivalent to the old `<= range.after` one.
- Moving `#rereduceIfVersionChanged` into `#runOnSerialChain` runs it after the latch check and before the work, the same order as today. That makes the `#staleCheckpoint` doc ("the chain runs before anything else") literally true.

Only revive changes, in two ways:

- Its catch-up and at-head pass now run in ONE slot.
- It now ALWAYS runs exactly one at-head pass. Today it skips its own pass when a push batch queued or in flight ahead of it was at head and the catch-up then found nothing to read.

The extra pass is harmless:

- At-head passes already repeat on every push that reaches the head.
- Processors guard at-head work with runtime fields: `#creating` in packages/agents/src/processor.ts:689 and `#dial` in packages/voice/src/voice-agent.ts:597.
- The eventless pass now goes through `#reduceAndCommitEventBatch([], …, true)`. That adds a waiter resolve at an unchanged cursor, which does nothing, and it writes no checkpoint because there is no durable in the batch. It publishes live state exactly as the hand-written slot did.
- If the reduce throws, or the latch trips, revive rejects just as it does today.

Nothing outside the engine can see the change. The workers-test HangingCounterDurableObject overrides `catchUpFromLog` and `revive` on the DO. The engine's revive never called that DO method, so the facets.test.ts counts `catchups` and `revives` are unaffected. Those rows, agent-revive and the e2e rows were not run.

(b) The new shape is simpler, not just different. Two page loops that do one job become one. The side-channel flag goes: every batch wrote it, only revive read it, and what it held depended on which batch last ran. The hand-rolled eventless slot and the re-reduce call at each entry point go too. The cost is a boolean parameter plus `until === Infinity` standing for "judge at-head by the page". Both fit in one sentence of doc.

(c) No guarantee is dropped. At-most-once for durables, the scanned-range proof, the rule that gap repair never passes at head, the one checkpoint per batch that carried a durable, the latch and the claim/revive backoff are all untouched.

It is a modest de-duplication rather than "awful junk", which is why the payoff is mid. But it sits in the engine that every processor runs on, and it removes a real illogical side channel.

## One `#shownHeadOffset` instead of two shown-head offsets, a setter helper and a ternary merge

- Sweep index: 57; risk: low; payoff: 3/10
- LOC: - Alone: processor.ts −16 (+15/−31).
- On top of #reduceFromLog: −20.
- One test row, :415-442, changes one expectation or is deleted (−28). (skeptic measured: - **Amended:** packages/iterate/src/stream/processor.ts +17/−32 (−15), measured with `git diff --numstat` in a scratch worktree at b3daf4846.
- **Literal candidate:** +16/−35 (−19), and it breaks processor.test.ts:415-442.
- **Tests:** 0 lines required. Two stale comment references need one-line rewording: processor.test.ts:417 and apps/os/**workers-tests**/ephemeral-offset-reuse.test.ts:136.)
- Concepts: 4 concepts become 1.

### Evidence

In packages/iterate/src/stream/processor.ts:

- :223-231 hold #pushedThroughOffset and #headReadFromLogOffset, with 9 lines of doc.
- :339 and :362: a push records one offset and judges at-head against it alone.
- :377, :388 and :395-404: #showHeadReadFromLog writes the other offset, with 6 lines of doc.
- :414-424: #reducedThroughPushedHead merges them with a ternary. Its doc then explains that rule 5 reads only one of them.
- :37-44: the header explains the same number a third time.

### Current shape

The engine tracks two heads: the highest a push showed, and the highest a catch-up read, which counts only for a processor fed by pushes. The read verbs merge them. A push's at-head judgment deliberately reads only the push half.

### Proposed shape

```ts
/** THE HEAD SHOWN so far: the highest range.through a push carried or — fed by pushes — the head a catch-up read. */
#shownHeadOffset?: number;
// processEventBatch: this.#shownHeadOffset = Math.max(this.#shownHeadOffset ?? 0, range.through); atHead: range.through >= this.#shownHeadOffset!
// catch-up at head: if (this.#fedByPushes) this.#shownHeadOffset = Math.max(this.#shownHeadOffset ?? 0, offset);
#reducedThroughShownHead() { return this.#reducedThroughOffset >= (this.#shownHeadOffset ?? Infinity); }
```

### What changes

The read verbs are unchanged.

One case changes, and only for a processor fed by pushes: a push whose range ends below a head a catch-up already read. Such a push is no longer judged at head, so it no longer triggers a second, eventless at-head pass, and its ephemerals carry `caughtUp: false`. No pass at the true head is lost.

### Pinned by

- processor.test.ts:270-285 and :289-413 pass.
- :415-442 is the one row that flips. In a scratch copy, 81 of 82 stream tests pass.
- Checking out and applying the change are both straightforward.

### Skeptic's amended proposal

Merge `#pushedThroughOffset` and `#headReadFromLogOffset` into one `#shownHeadOffset`. Keep rule 5 as "the batch leaves the reduce at the shown head", not "the push's range reaches the shown head".

```ts
readonly #fedByPushes: boolean;
/** THE HEAD SHOWN so far: the highest `range.through` a push carried or — fed by pushes — the head a catch-up read. In memory only. */
#shownHeadOffset?: number;
#showHead(offset: number) { this.#shownHeadOffset = Math.max(this.#shownHeadOffset ?? 0, offset); }

// processEventBatch
this.#showHead(range.through);
... await this.#reduceAndCommitEventBatch(events, range,
      Math.max(this.#reducedThroughOffset, range.through) >= this.#shownHeadOffset!);

// catchUpFromLog, both at-head exits
if (page.atHead && this.#fedByPushes) this.#showHead(after);        // nothing beyond the cursor
if (this.#fedByPushes) this.#showHead(page.scannedThroughOffset);   // last page at head

#reducedThroughShownHead() { return this.#shownHeadOffset !== undefined && this.#reducedThroughOffset >= this.#shownHeadOffset; }
```

This deletes `#showHeadReadFromLog` and its 6-line doc, the ternary in `#reducedThroughPushedHead`, and the caveat "rule 5 reads pushes alone". The header at :37-44 stays as it is; it already describes the one shown head.

**Semantic delta:**

- The read verbs are unchanged.
- Every at-head pass that runs today still runs.
- The only change is extra, redundant at-head passes. One can occur when a catch-up has already reduced past a later queued push and an earlier push then runs, whether or not the processor is fed by pushes. It also covers the :415 case (a push the log beat), which is at head today and stays at head. In every such case the reduce already stands at the shown head.
- Do not use the candidate's `range.through >= #shownHeadOffset`. It delivers an ephemeral with `caughtUp: false` when a catch-up (`waitUntilProcessed` or `revive`) read past it to a durable the processor does not consume. No later at-head pass follows, and I reproduced this with a probe.

**Tests:** all 82 stream tests and all 298 packages/iterate tests pass unchanged. Reword the comment at processor.test.ts:417 and the `#pushedThroughOffset` reference at ephemeral-offset-reuse.test.ts:136.

### Skeptic's verdict

The merge is right, but the rule-5 predicate as the candidate wrote it is wrong. The claim "no pass at the true head is lost" is false.

**(a) Semantic delta, measured.** I tested it in a scratch worktree at b3daf4846. Processor.ts is untouched by #3446.

The literal proposal is `atHead = range.through >= #shownHeadOffset`. It fails the :415 row, [2,1] against [2,2]. More importantly, it drops a real at-head delivery. I wrote a probe processor that consumes `t` and an ephemeral `e`, with `fedByPushes: true`:

- A catch-up reads the log to head 3, whose durable `noise@3` the processor does not consume.
- Then the push for ephemeral `e@2` arrives.
- Today, `e@2` is delivered with `caughtUp: true`. Under the proposal it is delivered with `caughtUp: false`.
- No later push ever comes, because nothing consumed follows. So no at-head pass runs after the ephemeral was folded.

This is reachable in production:

- `waitUntilProcessed` (connections.ts:280) is not in facet-host's PROCESSOR_READS, so the host does not hold it for owed pushes.
- `revive` catches up from the log too.
- Either can overtake an ephemeral push that is still in flight.

The amended predicate is `Math.max(#reducedThroughOffset, range.through) >= #shownHeadOffset`: "this batch leaves the reduce at the head shown so far". It keeps every at-head pass that runs today:

- The case "today at head, amended not" cannot happen, because a log-read head is never above `#reducedThroughOffset`.
- The only change is extra at-head passes. That happens when a catch-up has already reduced past a later queued push, and an earlier push then runs.
- In that case the reduce already stands at the shown head, so the pass is a redundant idempotent re-derivation. It never runs against a stale reduce, so the back-to-back test's rationale still holds.
- The read verbs' predicate is unchanged: `max` over both offsets, `undefined` when neither is set. So the read counts in #3101's tests and Workers row are identical.

In the probe, the amended version gives `{"false":["t@1","e@2"],"true":["t@1","e@2"]}`, the same as today. All 82 stream tests pass unchanged, including :415-442. All 298 packages/iterate tests pass, and there are no tsc errors in processor.ts.

**(b) Is it simpler?** Yes, modestly:

- Two state fields become one.
- The ternary merge becomes a one-line predicate.
- The caveat "rule 5 reads pushes alone" disappears.
- Rule 5 and the read verbs now share one concept, "reduced through the shown head".
- `#fedByPushes` stays, and a 3-line `#showHead` max helper stays.

Concepts: two heads, a merge and a caveat before; one shown head after. The candidate's "4 → 1" overstates it.

**(c) Guarantees.** The amended version drops none. The literal one drops the at-head delivery of an ephemeral that a log read overtook.

**(d) LOC.** Re-measured with `git diff --numstat`:

- Amended: processor.ts +17/−32, so −15.
- Literal: +16/−35, so −19, but it needs the :415 row changed. The candidate claimed −16.
- Tests: no change is needed. The :415 row's comment ("judged against the pushed head alone") and ephemeral-offset-reuse.test.ts:136 (`#pushedThroughOffset undefined`) need a one-line wording fix each.

It is small and in a central file. PR #3101 deliberately kept the two heads so that "nothing else moves". This is a real concept removal, but a low-payoff one.

## defineProcessorContract builds one definitions table for both the uniqueness check and lookups; EventInput is derived from EventInputForType

- Sweep index: 58; risk: low; payoff: 2/10
- LOC: processor.ts: −13 (+12/−25). In a scratch copy, tsc passes and all 82 stream tests pass. (skeptic measured: packages/iterate/src/stream/processor.ts: +8/−20 (1287 → 1275 lines, −12). packages/iterate/src/stream/processor.test.ts: +1/−1 (comment only). Net −12. Measured with git diff --no-index --numstat against wt-main after oxfmt.)
- Concepts: 4 concepts become 2.

### Evidence

All in packages/iterate/src/stream/processor.ts:

- :1253-1265: a `depEventTypes` Set exists only for the ownership check.
- :1266-1270 and :1281: `resolve()` maps over processorDeps on every `payloadSchemaFor` call, which runs once for every consumed event the engine validates.
- :1158-1177 (`EventInputForType`) and :1197-1206 (`EventInput`) spell out the same row type twice.

### Current shape

The contract builder walks every dep's catalog once to refuse duplicate owners, keeping a Set it then discards. It then walks the deps again on every lookup. The owned-event input type is also written out a second time.

### Proposed shape

```ts
const definitions: EventCatalog = { ...events };
for (const dep of processorDeps) for (const [type, definition] of Object.entries(dep.events)) {
  if (type in definitions) throw new Error(`contract "${slug}": event "${type}" is ${type in events ? 'already owned by a dep' : 'declared by two deps'}`);
  definitions[type] = definition;
}
… payloadSchemaFor: (type) => definitions[type]?.payloadSchema,
export type EventInput<Contract> = Contract extends { events: infer Events extends EventCatalog } ? EventInputForType<Events, readonly [], keyof Events & string> : never;
```

### What changes

Nothing observable changes: the same refusals and messages, the same lookups, the same union type. A lookup becomes one property read instead of a map-and-find.

### Pinned by

- processor.test.ts:29-69
- EventInput users, which were not typechecked here: repo/durable-object.ts:474, secret/durable-object.ts:1290, library.ts:106 and packages/agents/src/contract.ts

### Skeptic's amended proposal

Keep the two plain throws instead of a nested ternary, and update the two comments that name `resolve`. In packages/iterate/src/stream/processor.ts, defineProcessorContract becomes:

```ts
const definitions: EventCatalog = { ...events };
for (const dep of processorDeps as readonly { events: EventCatalog }[])
  for (const [type, definition] of Object.entries(dep.events)) {
    if (type in events)
      throw new Error(`contract "${contract.slug}": event "${type}" is already owned by a dep`);
    if (type in definitions)
      throw new Error(`contract "${contract.slug}": event "${type}" is declared by two deps`);
    definitions[type] = definition;
  }
// …
payloadSchemaFor: (type: string) => definitions[type]?.payloadSchema,
```

`EventInput` becomes:

```ts
export type EventInput<Contract> = Contract extends { events: infer Events extends EventCatalog }
  ? EventInputForType<Events, readonly [], keyof Events & string>
  : never;
```

Also:

- Reword the comment at processor.ts:1251 from "`resolve` … would pick just the first" to refer to `definitions`.
- Reword processor.test.ts:52 ("`resolve` would pick one").

Documented delta: `EventInput` of a contract with no catalog becomes `StreamEventInput` instead of an uncallable row. No caller does this. A test for the "already owned by a dep" refusal could be added, since none exists today.

### Skeptic's verdict

I checked this against origin/main b3daf4846. PR #3446 does not touch packages/iterate/src/stream/processor.ts. I applied the change in a scratch copy (scratchpad/skeptic-defcontract/repo) and checked it there.

(a) Semantics.

- Runtime refusals: identical. The loop order is the same. A dep type the contract also owns still throws "already owned by a dep" first, and a type two deps share still throws "declared by two deps".
- Lookups: identical. `type in` and bracket reads behave the same on a copied plain object, including prototype keys like "toString" (dead edge anyway, because event types contain a slash).
- One real runtime difference: `definitions` is a snapshot taken when the contract is defined, where `resolve` read `dep.events` live. Nothing mutates a catalog after definition, so this is unobservable today.
- Types: I checked old and new `EventInput` for mutual assignability on all 8 contracts that have catalogs: Repo, Secret, Workspace, Account, Project, Organization, Instance and Agent. All were equal, and so was a widened `EventCatalog`.
- One type difference: for a contract with NO events catalog (the `Record<string, never>` default), `EventInput` goes from an uncallable row (`payload: never`) to plain `StreamEventInput`. The new behaviour matches `EmittedEventInput`'s documented fallback. No caller applies `EventInput` to a catalog-less contract: `EntityHandle` uses only Repo and Workspace, and `#fact` uses Secret. The doc comment on `EventInputForType` already calls it "`EventInput`'s row", so the second spelling really is a duplicate that could drift.
- The perf claim is real but trivial: deps are 0 to 3 small arrays.

(b) Simpler. The Set used only for the uniqueness check plus the `resolve` closure that walks the deps again become one table that does both. The 8-line mapped type becomes a one-line alias of the row type that already exists. That is 4 concepts down to 2, and not a lateral move.

(c) No guarantee is dropped. The one-owner-per-type refusal and payload validation are unchanged.

(d) LOC, re-measured with `git diff --numstat` after oxfmt:

- processor.ts: +8/−20 (1287 → 1275 lines, −12). The candidate claimed −13.
- processor.test.ts: +1/−1, a comment only.

Checks, all passing:

- tsc on packages/iterate (both tsconfigs), packages/agents, packages/voice and apps/os (src, tests and scripts tsconfigs).
- The 82 tests under packages/iterate/src/stream, including processor.test.ts:42-69, which pins "declared by two deps". The "already owned by a dep" branch has no test.

Caveats:

- The proposed nested ternary in the error message is worse than two plain throws, so I amended that. The amended loop body is a 4-line change from today.
- The candidate missed two stale mentions of `resolve`: the comment at processor.ts:1251 and processor.test.ts:52.
- Scale: this is a real but small tidy in central SDK code, not the heavy junk the owner is hunting. Hence the low payoff.
