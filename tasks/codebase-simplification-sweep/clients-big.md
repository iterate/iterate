# Sweep candidates: clients-big

Verified candidates from the 2026-09-29 codebase simplification sweep for this area. Each passed an adversarial skeptic check; where the skeptic amended the proposal, the amendment wins. Line numbers are as of origin/main on 2026-09-29 (about cfd8a1d36) and have drifted since: #3442, #3455 and #3460 touched some of these files. The index and the owner calls are in ../codebase-simplification-sweep.md.

## The Agents page opens its context with useContextStub, reads live state from its one useIterateContext, and uses the SDK's StreamEvent

- Sweep index: 71; risk: medium; payoff: 6/10
- LOC: About −90 to −100 product lines, measured with sed and wc:
- projects.$slug.tsx: −69, +8
- agent-events.ts: −17
- stream-event.ts: −26

Tests are about ±0: the agent-events.test.ts `at()` helper and agents.e2e.test.ts:388 drop the wrap. (skeptic measured: Measured on a prototype formatted with oxfmt, diffed against wt-main with `git diff --no-index --numstat`:

- projects.$slug.tsx: +24/−74
- agent-events.ts: +1/−19
- events/stream-event.ts: −26
- agent-ui-reducer.ts: +1/−1
- agent-inspectors.tsx: +1/−1
- agent-events.test.ts: +3/−2
- agent-ui-reducer.test.ts: +12/−3

Totals:

- Product: −94.
- Tests: +10.
- Net: −84.
- With the amended live-state fallback (about +3), net is about −81.
- agents.e2e.test.ts:385-389 adds about −2 more.)
- Concepts: 5 app-local mechanisms become 0:
- useAgentContext
- useAgentLog
- Committed/toAgentEvent
- the local StreamEvent
- the second subscription

### Evidence

Merges three sources (clients-big parallel ×2, heavy).

In apps/agents/src/routes/_auth/projects.$slug.tsx:

- :247-286 `useAgentContext` is a 40-line held/disposed/release dance around `projects.get` and `cd`. It was written 09-16..21, before packages/iterate/src/client/react.tsx:147-192 `useContextStub` landed (#3144, 09-25). packages/ui's use-context-explorer.ts:42-44 already composes that hook for exactly root → cd(path).
- :288-313 `useAgentLog`.
- :368 `useFacetLiveState(context, 'agent')` opens a second subscription to a facet that :295's `useIterateContext` already opens (react.tsx:330-352; packages/agents/src/collection.ts:101).

In apps/agents/src/lib:

- agent-events.ts:19-34 (`Committed` zod plus a `JSON.parse(JSON.stringify(raw))` per event) re-clones what event-log.ts:247-258 `toStreamEvents` already cloned. It does this for the whole log (history: all) on every publish.
- events/stream-event.ts:1-26 is a hand copy of the SDK StreamEvent.

This breaks the owner's 'ONE useIterateContext' rule.

### Current shape

The page holds its project and agent stubs with bespoke disposal. It re-clones and zod-parses the entire log once per frame. It opens a second live-state subscription the hook already holds. And it types everything with a local copy of StreamEvent.

### Proposed shape

```ts
const projectStub = useContextStub(() => api.projects.get(project), [api, project]);
const agent = useContextStub(projectStub.stub ? () => projectStub.stub!.cd(path) : null, [
  projectStub.stub,
  path,
]);
const iterateContext = useIterateContext(agent.stub, {
  consumes: FEED_SUBSCRIPTION,
  history: "all",
});
const { events, caughtUp } = iterateContext;
const connectError = projectStub.error || agent.error;
const live = iterateContext.liveState.agent ?? { value: undefined, status: "connecting" as const };
```

Delete `useAgentContext`, `useAgentLog`, `Committed`/`toAgentEvent` and stream-event.ts. The rest imports `type StreamEvent` from 'iterate/stream/processor'.

### What changes

- Each open chat holds one server-side live-state subscription to `agent` instead of two.
- The header shows 'Connecting…' about one `subscriptions.list()` round trip longer on first paint, and again briefly whenever the processors table changes.
- A context with no `agent` row stays 'Connecting…' instead of saying 'Live state unavailable'. Keeping the old text needs `processors.loaded && !live`.
- Events are the SDK's once-cloned rows, so the extra positive-integer offset, metadata and idempotencyKey checks go.
- A publish no longer clones the whole log.
- Stub lifetime is the same.

### Pinned by

- apps/agents/src/lib/agent-events.test.ts:95-100
- agents.e2e.test.ts:385-389
- agent-ui-reducer.test.ts:8 and :1690-1700 (import path)
- No browser spec covers the Agents app since #3446, so this needs a manual drive.

### Skeptic's amended proposal

In AgentConversation, replace useAgentContext, useAgentLog and useFacetLiveState with this:

```ts
const held = useContextStub(() => api.projects.get(project), [api, project]);
const projectStub = held.stub;
const agent = useContextStub(projectStub ? () => projectStub.cd(path) : null, [projectStub, path]);
const context = agent.stub;
const connectError = held.error || agent.error;
// ONE subscription: the whole log ("all": the chat folds every page), the processors, and every hosted facet's live state
const iterateContext = useIterateContext(context, { consumes: FEED_SUBSCRIPTION, history: "all" });
const { events, caughtUp, processors } = iterateContext;
const error = connectError || iterateContext.error;
// no `agent` row once the table is read (a dead agent) or the table failing reads as unavailable, as the facet's own read did
const live = iterateContext.liveState.agent || {
  value: undefined,
  status: processors.loaded || processors.error ? ("error" as const) : ("connecting" as const),
  error: processors.error,
};
```

Delete these:

- `useAgentContext` and `useAgentLog`, projects.$slug.tsx:247-313.
- `Committed` and `toAgentEvent`, agent-events.ts:19-34, along with its now-unused `import { z }`.
- apps/agents/src/lib/events/stream-event.ts.

Import `type StreamEvent` from "iterate/stream/processor" in these files:

- agent-ui-reducer.ts
- agent-inspectors.tsx
- agent-events.ts
- the tests

Test changes:

- **agent-events.test.ts `at()`:** it becomes `({ ...committedEvent(offset, type, payload), ...extra }) as StreamEvent`.
- **agent-ui-reducer.test.ts, :495 and :1690:** the fixture type becomes `{ type: string; payload?: unknown; offset?: number; createdAt?: string; source?: unknown }`, because `Partial<>` of the SDK type still requires `source.origin`.
- **agents.e2e.test.ts:385-389:** it becomes `feed = (log: StreamEvent[], idle: boolean) => reduceAgentFeed(log, idle)`.

An alternative is to pass `liveState: ["core", "agent"]`. That opens `agent` without waiting for the table and needs no fallback. The cost is that the Events tab's processors panel would stop showing any other facet hosted on that context. Keep the default unless the agent context only ever hosts `agent`.

### Skeptic's verdict

The claims hold against origin/main at b3daf4846. #3446 is already merged there and only touched the page's upgrade cast, so it does not overlap. I built the change in a scratch mirror at scratchpad/tc-agents: `tsc --noEmit` is clean, and agent-events.test.ts plus agent-ui-reducer.test.ts pass (52 tests).

(a) What changes in behaviour:

- **Stub lifetime:** identical. `useAgentContext` (projects.$slug.tsx:247-286, from 09-21) is a hand-rolled copy of `useContextStub` (react.tsx:148-184, from 09-25). `use-context-explorer.ts:42-44` already chains two of those for root then cd. Both versions dispose on unmount and dispose a stub that arrives late.
- **Events:** `toAgentEvent` (agent-events.ts:19-34) runs `JSON.parse(JSON.stringify(...))` and a zod parse on every row. The page runs it over the whole log (`history: "all"`) each time the SDK publishes, which is at most once a frame. But event-log.ts:250 `toStreamEvents` has already cloned each batch once and filtered on offset, type and createdAt. The only checks lost are "offset is a positive integer", "metadata is a record" and "idempotencyKey is a string", all of which the platform guarantees. The Events tab count is unchanged, and row objects become stable across frames.
- **Second subscription:** confirmed. `useIterateContext` without a `liveState` option already opens `core` plus every hosted facet (react.tsx:330-337), and that includes `agent`. `useFacetLiveState(context, "agent")` at :368 opens a second server-side live-state subscription to the same facet. Removing it frees one subscription row per open chat.
- **Header and idle timing:** `liveState.agent` appears only after `subscriptions.list()` lands, so the header and `idle` wait one extra round trip on first paint. The log catch-up runs at the same time, and until it finishes the chat shows the "Reading the log…" spinner, so the extra wait is mostly hidden. If the set of hosted facet names changes, every live state reconnects, which briefly makes `idle` false. On an agent context that is rare.
- **Missing agent row:** the proposal as written makes this regress. When the context has no `agent` row (a dead agent) or `subscriptions.list()` fails, the header would stay on 'Connecting…' and `idle` would stay false forever, so the idle-boundary flush never runs. Today the header says 'Live state unavailable' and the log alone decides. The amended fallback below keeps today's behaviour.

(b) The new shape really is simpler. Two app-local hooks, the `Committed`/`toAgentEvent` parse, the copied type and the duplicate subscription become calls to the SDK hooks that exist for this. It also removes the slice-named wrapper `useAgentLog`, which is the smell Jonas called out in the "ONE useIterateContext" feedback.

(c) No guarantee is lost. Stub disposal, delivery and the loop limits are untouched, and events are still the interface.

(d) Re-measured after oxfmt with `git diff --no-index --numstat`:

- Product code, −94 lines:
  - page +24/−74
  - agent-events.ts +1/−19
  - stream-event.ts −26
  - two import swaps ±0
- Tests, +10 lines. The SDK `StreamEvent` requires `path` and `source.origin`, so `Partial<StreamEvent>` no longer fits the reducer test fixtures at :495 and :1690. They need a loose fixture type.
- Net is about −84, or about −81 with the fallback amendment.

The proposal is also slightly mis-specified in three places:

- `import { z }` in agent-events.ts must go.
- The e2e test's `feed` helper at agents.e2e.test.ts:385-389 must take `StreamEvent[]`.
- The fallback needs the processors-table condition, as in the amended code.

The first-party-agents branch edits this page, but not these hooks, so the conflict risk is low.

Risk is medium-low. No browser spec covers the page, so it needs a manual run.

## The live tail's label is one function: the 6-phase status machine only tests read goes, with a second log scan and a never-varied formatter option

- Sweep index: 72; risk: low; payoff: 4/10
- LOC: About −154 in total.
- Product, about −90:
  - reducer: −64 and −6
  - agent-events.ts: −12
  - page/feed: −6
  - item field: +2
- Tests, about −64: agent-ui-reducer.test.ts:1525-1586 is deleted, and the :1587 row loses its phase asserts. (skeptic measured: Measured with `git diff --no-index --numstat` on a prototype that typechecks, lints clean and passes its tests: +26 / −182, net −156.
- agent-ui-reducer.ts: +13 / −79
- agent-events.ts: 0 / −13
- agent-feed.tsx: +8 / −16
- projects.$slug.tsx: +1 / −3
- agent-ui-reducer.test.ts: +4 / −71

Product code is −89 and tests are −67.)

- Concepts: 5 concepts become 1:
- Before: the phase union, AgentUiLiveStatus, the processing inference, the trace-offset scan, and the hint option.
- After: `liveStatusText`, next to liveActivityLabel.

### Evidence

Merges the clients-big parallel and heavy hunts.

The unused status machine:

- apps/agents/src/lib/events/agent-ui-reducer.ts:200-269: `AgentUiLivePhase` (6 phases), `AgentUiLiveStatus`, and `deriveAgentUiLiveStatus`, including a 'processing' inference that sniffs `<codemode`.
- Its only production caller, agent-feed.tsx:543-544, reads only `.statusText`. It runs after `if (!working) return` (:531), so the 'processing' and 'working' phases can never be reached there.
- The label actually shown comes from `liveActivityLabel` (agent-events.ts:95-101).
- `.phase` is read only in agent-ui-reducer.test.ts:1525-1632.
- The comment at :1637 names 'journal-only surfaces (mobile)', which no longer exist.

The second log scan:

- agent-events.ts:103-114 `traceOffsetByMessage` re-scans the whole log on every change (projects.$slug.tsx:381 and :572).
- The reducer already reads llmRequestOffset at agent-ui-reducer.ts:434.

The unvaried option:

- agent-ui-reducer.ts:135-159 `formatAgentUiActivitySummary` takes an options bag. Both callers (agent-feed.tsx:183-186 and :571-574) pass the same hint.

### Current shape

The reducer exports a status machine whose phase the UI throws away. The page runs a second pass over the log to find offsets the reducer already has, and a formatter takes an options bag no caller varies.

### Proposed shape

```ts
export function liveStatusText({ live, summaryActivity, summaryActivityUpdatedAtMs: at }: AgentUiState) {
  return live && at !== null && at >= live.startedAtMs ? summaryActivity : null;
}
// agent-feed.tsx: const currentLabel = liveStatusText(state) || liveActivityLabel(runningSteps);
// web-message-sent case: assistant item carries llmRequestOffset; traceOffsetByMessage and the traceOffset prop go
export function formatAgentUiActivitySummary(activity, summary) { … 'interrupted (click to see partial response)' … }
```

### What changes

Nothing changes on screen: the live label, the collapsed summary, and the 'trace ›' link all render as before. What goes is an unrendered phase value and its inference.

### Pinned by

apps/agents/src/lib/events/agent-ui-reducer.test.ts:1525, :1561 and :1587

### Skeptic's amended proposal

**Reducer** (apps/agents/src/lib/events/agent-ui-reducer.ts)

- Replace lines 199-269 (`AgentUiLivePhase`, `AgentUiLiveStatus`, `deriveAgentUiLiveStatus`) with:

```ts
/** The agent's `activity` text when it was set during the live activity, else null: code steps
 *  inherit `summaryActivity` at birth, so a previous turn's text never labels this one. */
export function liveStatusText({
  live,
  summaryActivity,
  summaryActivityUpdatedAtMs: at,
}: AgentUiState) {
  return live && at !== null && at >= live.startedAtMs ? summaryActivity : null;
}
```

- `formatAgentUiActivitySummary(activity: AgentUiActivity, summary: AgentUiActivitySummary)`. It always writes "interrupted (click to see partial response)" when `interruptedWithPartialResponse` is set. `summary` is required and positional because the live caller passes `doneSummary`.
- `AgentUiMessageItem` gains `/** The llm request an assistant message was extracted from: its trace link opens it. */ llmRequestOffset?: number | null;`
- The `web-message-sent` case writes `llmRequestOffset: extractedFromRequest` directly. oxlint's `simple-truthiness-check` rejects the conditional-spread form.
- Reword the doc comment on the `paused` field and the comment on the pause case, both of which mention the "processing" inference. `paused` itself stays, because the settle at :619 needs it.

**agent-events.ts**

- Delete `traceOffsetByMessage` (lines 103-114). `isRecord` stays, because the trace code uses it.

**agent-feed.tsx**

- Drop the `traceOffset` prop and its type.
- The assistant case becomes a block, `case "assistant": { const traceOffset = item.llmRequestOffset; … {traceOffset == null ? null : <button onClick={() => inspect.llmRequest(traceOffset)}>trace ›</button>} }`.
- Both summary calls become `formatAgentUiActivitySummary(activity, summary)` and `formatAgentUiActivitySummary(live, doneSummary)`.
- `const currentLabel = liveStatusText(state) || liveActivityLabel(runningSteps);`

**projects.$slug.tsx**

- Drop the `traceOffsetByMessage` import, the `traceOffsets` `useMemo` at line 381, and the `traceOffset=` attribute at line 572.

**Tests** (agent-ui-reducer.test.ts)

- Delete the phase tests at :1525-1585.
- The :1587 test asserts `expect(liveStatusText(reduceAll(turnOne))).toBe("Sweeping March refunds")`, then `toBeNull()` for turn two, then `toBe("Sweeping April refunds")`.
- Fix the stale "(mobile)" comment at :1637.
- Optionally add `llmRequestOffset: 1` to an existing `toMatchObject` on an assistant item, so the trace link keeps a pin.

**Semantic delta**
Nothing rendered changes. The things that do change:

- the exports `deriveAgentUiLiveStatus`, `AgentUiLivePhase` and `AgentUiLiveStatus` are gone (they had no other importers);
- assistant items now carry `llmRequestOffset` (a `number` or `null`), and nothing compares items with strict equality;
- the page makes one fewer O(n) pass over the log each time `events` changes.

**Concepts**
Five before: the phase union, the status type, the processing inference, the trace-offset scan plus its prop, and the hint option. Two after: `liveStatusText`, plus the offset stored as data on the item it belongs to.

**Risk**
Low. This touches 5 files in the apps/agents UI only.

**Tests that pin the current behaviour**
agent-ui-reducer.test.ts:1525, :1561 and :1587. No test pins `traceOffsetByMessage` or the hint.

### Skeptic's verdict

The claims hold against origin/main at b3daf4846. PR #3446 only touches an unrelated `upgradeAgents` cast in projects.$slug.tsx, and neither open PR #3453 nor #3384 touches these symbols.

(a) Semantics.

- `deriveAgentUiLiveStatus` has exactly one production caller, agent-feed.tsx:543-544, and it reads only `.statusText`.
- `.phase` and the types `AgentUiLivePhase` / `AgentUiLiveStatus` are read only in agent-ui-reducer.test.ts:1525-1632. Nothing else in apps/, packages/ or specs/ imports them.
- The call also comes after `if (!working) return` (:531), so a running step always exists there and the 'processing' and 'working' phases cannot be reached at that site.
- The phase is computed eagerly (`phase: phase()`) and then thrown away.
- `traceOffsetByMessage` builds keys `assistant-${offset}` from `web-message-sent` events that carry a numeric `llmRequestOffset`. The reducer's `web-message-sent` case (:427-449) is the only place that makes assistant items, it uses the same id, and it already computes `extractedFromRequest` with the same read. So moving the offset onto the item gives an identical trace link. The map also held entries for events whose `message` is null, but no item ever looked those up.
- `formatAgentUiActivitySummary`: both callers pass the same hint. The `summary` option does vary (the full summary vs `doneSummary`), so it has to become a required positional argument; it cannot be dropped.
- Nothing rendered changes. The one real test behaviour, "this turn's summary only" at :1587, stays pinned through `liveStatusText`.

(b) The new shape is simpler.

- Removed: a 6-phase union, a status type, a codemode-sniffing inference with a 10-line doc comment, a second O(n) log scan on every `events` change, a `traceOffset` prop threaded from page to row, and an options bag.
- Added: one 4-line function and one field on the item.

(c) No guarantee is dropped.

- The reducer's `paused` field stays, because the settle logic at :619 still uses it. Only its doc comment, which mentions the "processing" inference, needs rewording.
- The `agent/paused` settle test at :1634 stays. Only its comment about "journal-only surfaces (mobile)" is stale.

(d) I re-measured on a scratch prototype of all 5 files, and it passes:

- tsc: clean, apart from missing-module errors caused by the scratch copy itself;
- oxlint with the repo's `.oxlintrc.json`: clean;
- vitest: the 47 agent-ui-reducer tests and the 3 agent-events tests pass.

The prototype needed one amendment. The candidate implied a conditional spread for the new item field, and oxlint's `iterate/simple-truthiness-check` rejects that. The field has to be written directly as `llmRequestOffset: extractedFromRequest`, typed `number | null`.

Payoff is moderate. This is dead, hard-to-explain UI-client code that tests keep alive, not central platform code.

## Replace the 98-line shared-clock framework behind one 100 ms label with useState + setInterval

- Sweep index: 73; risk: low; payoff: 4/10
- LOC: About −93 to −97 net. (skeptic measured: `wc -l` gives apps/agents/src/lib/use-ticking-now-ms.ts as 98 lines, and the file is deleted. The import at agent-feed.tsx:46 goes (−1). `useLivePhaseClock` (agent-feed.tsx:687-699) grows from 13 to 17 lines (+4); I counted that on a standalone copy that passes `tsc --strict`. Net about −95 across 2 files. `useEffect` and `useState` are already imported at agent-feed.tsx:5, so the import list does not change.)
- Concepts: There are 2 clock mechanisms in the repo today; after this change there is 1.

### Evidence

Merged from the parallel and heavy hunts.

- apps/agents/src/lib/use-ticking-now-ms.ts:1-98 has four parts: a per-interval registry, useSyncExternalStore with a microtask re-notify for Strict Mode, a `stopAtMs` boundary, and a server snapshot.
- Its only user is agent-feed.tsx:687-699 (useLivePhaseClock inside AgentLiveStatus), and only one instance is ever mounted (:620).
- The route is `ssr: false` (_auth.tsx:6), so the server snapshot never runs.
- packages/ui already does the same job in about 8 lines, in processors-panel.tsx:541-550 and presence-strip.tsx:12-24.

### Current shape

The elapsed counter subscribes to a shared, reference-counted external-store clock, built so that 'many components do not each own a timer'. Only one component ever subscribes to it.

### Proposed shape

```ts
function useLivePhaseClock(startedAtMs: number, deadlineMs: number | null) {
  const [nowMs, setNowMs] = useState(Date.now);
  const deadlineExceeded = deadlineMs !== null && nowMs >= deadlineMs;
  useEffect(() => {
    if (deadlineExceeded) return;
    const timer = setInterval(() => setNowMs(Date.now()), 100);
    return () => clearInterval(timer);
  }, [deadlineExceeded]);
  return {
    deadlineExceeded,
    elapsedLabel: formatElapsedSeconds((deadlineExceeded ? deadlineMs! : nowMs) - startedAtMs),
  };
}
```

Delete lib/use-ticking-now-ms.ts.

### What changes

- There is one interval per mounted row instead of a shared one, and only one row is ever mounted.
- The clock still freezes at the deadline.
- The first tick comes 100 ms after mount instead of on a microtask.
- The dead server snapshot goes.

### Pinned by

None.

### Skeptic's amended proposal

Delete apps/agents/src/lib/use-ticking-now-ms.ts and the import at agent-feed.tsx:46. Replace the body of `useLivePhaseClock` at agent-feed.tsx:687-699, keeping its JSDoc and the comment on `AgentLiveStatus`:

```ts
function useLivePhaseClock(
  startedAtMs: number,
  deadlineMs: number | null,
): { deadlineExceeded: boolean; elapsedLabel: string } {
  const [nowMs, setNowMs] = useState(Date.now);
  const deadlineExceeded = deadlineMs !== null && nowMs >= deadlineMs;
  useEffect(() => {
    if (deadlineExceeded) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 100);
    return () => clearInterval(timer);
  }, [deadlineExceeded]);
  return {
    deadlineExceeded,
    elapsedLabel: formatElapsedSeconds((deadlineExceeded ? deadlineMs : nowMs) - startedAtMs),
  };
}
```

No `!` is needed, because TypeScript narrows `deadlineMs` through the aliased condition; this was verified with `tsc --strict`. The `setNowMs(Date.now())` on each restart keeps parity with today's resubscribe-refresh when a code step whose deadline was exceeded hands over to the next step. Net about −95 lines across 2 files; the repo goes from 2 clock idioms to 1, the one packages/ui already uses.

### Skeptic's verdict

The claim holds up against the code on origin/main at b3daf4846. PR #3446 does not touch agent-feed.tsx or use-ticking-now-ms.ts.

Evidence:

- `useTickingNowMs` has one caller, agent-feed.tsx:691. That caller sits inside `AgentLiveStatus`, which is mounted once (:610). `AgentLiveActivity`, the component around it, is mounted once too (projects.$slug.tsx:576).
- The route is `ssr: false` (_auth.tsx:6), so the `serverSnapshot` branch (lines 71-78) is dead.
- Git history explains the machinery. #2031 (2026-07-15) built it to follow react-doctor and to share one timer among three users: the feed counter, the roster's "ago" clock and the terminal UI's `LiveActivity`. The other two users are gone after #2837 and #2946.
- react-doctor does not run in CI or lint. The only React rules in .oxlintrc.json are `rules-of-hooks` and `exhaustive-deps`.
- The file's header comment argues against the exact idiom packages/ui uses at processors-panel.tsx:541-550 and presence-strip.tsx:18-22. What remains is a generic, reference-counted external-store framework with one user. It is also hard to explain: three comment blocks justify the microtask re-notify, the boundary detach and the server snapshot.

(a) Every behaviour that changes (all visual, none pinned):

1. First render: the proposed shape reads a fresh `Date.now()`. Today the first render can use the module clock's stale last tick, and it only corrects once React re-checks the snapshot after subscribing. This is an improvement.
2. The tick phase is relative to this component's mount rather than a shared timer's. Only one instance is ever mounted.
3. The freeze at the deadline looks the same. Today `Math.min(snapshot, stopAt)` plus unsubscribing does it. In the proposal the interval stops on the render where `nowMs >= deadline`, and the label is pinned to `deadlineMs` either way.
4. When the deadline changes, today's code resubscribes, which refreshes `now` and notifies on a microtask. The proposal restarts the effect when `deadlineExceeded` flips.
   - As the candidate wrote it, the effect restarts without refreshing, so the label can read `0.0s` for up to 100 ms after an exceeded code step hands over to the next step, because the stale `nowMs` is clamped by `Math.max(0, …)`.
   - My amendment adds `setNowMs(Date.now())` at the start of the effect, the same way processors-panel does, which gives parity. The cost is one extra render at mount.
5. The dead server snapshot goes.

Nothing pins any of this:

- agent-events.test.ts only tests the reducer.
- No spec or e2e test references `agent-live-status`, "Code deadline exceeded" or the elapsed format.

(b) The new shape really is simpler.

- Before: about 5 concepts across 2 files (an external store, a per-interval registry `Map`, the Strict Mode microtask re-notify, the `stopAtMs` boundary with self-detach, and the server snapshot).
- After: one `useState` plus an interval effect gated on `deadlineExceeded`. It is the same idiom packages/ui already uses, so the repo goes from 2 clock idioms to 1.

(c) No guarantee is dropped. This is a display-only elapsed label, and "the counter freezes at the deadline and flips to the failure state" is kept.

(d) Measured at about −95 net.

The candidate's sketch needs two fixes:

- The `deadlineMs!` non-null assertion is unnecessary. TypeScript narrows through the aliased `deadlineExceeded` condition, and I confirmed this with `tsc --strict`.
- It omits the refresh when the interval restarts.

Risk: low. The only plausible objection is react-doctor's stated preference, and nothing in the repo enforces it.

## Remove the chat composer's 'Raw event' mode: a second, unvalidated raw-append composer on a page that already mounts the shared one

- Sweep index: 74; risk: low; payoff: 4/10
- LOC: About −112 net.
- composer.tsx: 380 → about 275
- the page: −6
- package.json: −1
- README: −1 (skeptic measured: I applied the change to a scratch copy of the composer; it went from 380 to 267 lines (−113). Other files:
- The page: −6 (the `onAppendRaw` block at projects.$slug.tsx:601-606).
- apps/agents/package.json: −1 (the `yaml` line).
- pnpm-lock.yaml: −3 (the `yaml` entry under the apps/agents importer).
- README: −1, or 0 if the line is reworded.

Net is about −124 LOC across 4 or 5 files.)

- Concepts: 2 raw-append composers on one page become 1, and 2 composer modes become 1.

### Evidence

The Raw mode lives in apps/agents/src/components/composer.tsx:

- mode types at :32-51
- the Message/Raw radio at :144-194
- the CodeEditor branch at :196-205
- the raw draft at :303-305, defaulting to `events.iterate.com/note/added`
- `submitRawEvents` at :338-345, which appends anything that parses

projects.$slug.tsx:601-606 wires it in as `onAppendRaw`, with a cast.

The same page already renders the shared composer: it passes `onAppend` to ContextView (:525), which renders packages/ui's AppendComposer (context-view.tsx:282-283). That composer validates the envelope (append-events.ts:22-49).

packages/iterate/README.md:244 carves out an exception for this composer's `note/added` example.

### Current shape

From the Chat tab, a person can append raw YAML with no validation. The Events tab of the same page offers the shared composer, which validates and writes to the same `context.append`.

### Proposed shape

The `+` dropdown becomes a single attach button:

```tsx
<Button
  variant="ghost"
  size="icon-lg"
  title="Attach files"
  className="rounded-full"
  disabled={isSubmitting}
  onClick={message.onAttach}
>
  <PaperclipIcon />
</Button>
```

Delete:

- the mode types, props and raw state
- `submitRawEvents` and the CodeEditor branch
- the `yaml` dependency (apps/agents/package.json:36)
- `onAppendRaw` and its cast
- the README exception

### What changes

Raw appends move one tab over to Events. There they gain envelope checks, completions and examples, and default to a type outside the platform namespace.

The one thing lost is appending a raw event without leaving the Chat tab.

### Pinned by

None.

### Skeptic's amended proposal

Same as the candidate, with the measured numbers and four additions.

In apps/agents/src/components/composer.tsx (380 → 267 lines):

1. Replace the `+` DropdownMenu (:144-194) with a direct button:

```tsx
<Button
  variant="ghost"
  size="icon-lg"
  title="Attach files"
  className="rounded-full"
  disabled={isSubmitting}
  onClick={message.onAttach}
>
  <PaperclipIcon className="size-4.5" />
</Button>
```

2. Always render the message branch (:196-216).

3. Collapse the mode logic:

- `canSubmit = !isSubmitting && message.canSubmit`
- `showInterrupt = !!onInterrupt`
- `submit() { if (canSubmit) void message.onSubmit(); }`
- the button title becomes `showInterrupt ? "Stop generation" : "Send message"`

4. Drop the mode switch in onDrop (:118).

5. Delete:

- the `AgentComposerMode` and `AgentComposerRawConfig` types;
- the `mode`/`onModeChange`/`raw` props;
- the `mode` and `rawText` state;
- `submitRawEvents`;
- the `onAppendRaw` prop;
- the imports of yaml, CodeEditor, DropdownMenu*, FileCode2Icon, MessageSquareIcon and PlusIcon.

6. Update the header comment and docstring.

7. Optionally inline `runSubmit`, which now has one caller.

Elsewhere:

- **projects.$slug.tsx:** delete the `onAppendRaw` block at :601-606, including the cast and its incorrect comment.
- **apps/agents/package.json:** remove `yaml`, then run `pnpm install` so the lockfile's apps/agents importer drops it.
- **packages/iterate/README.md:242:** delete the Agents-composer exception.
  - Also either reword it to say `note` is used only in tests, or change the two `events.iterate.com/note/added` literals in apps/os/src/context/itx-expression-rewriting.test.ts (:1228, :1354) to another namespace and remove `"note"` from the NAMESPACES list in lint/event-types.test.ts.

The PR body must say that raw appends now live only in the Events tab's shared composer. Raw mode was ported on 09-17 for apps/os parity, and #3144 added that composer to the same page on 09-25. Prove it by hand on a preview:

- the paperclip opens the picker, on desktop and on a touch tap;
- an attachment still sends;
- the Events tab's Append event still lands.

### Skeptic's verdict

Checked on origin/main at b3daf4846. PR #3446 has already merged, and it did not touch the composer or the `onAppendRaw` wiring (its only change to projects.$slug.tsx was 4 lines elsewhere).

(a) The semantics claim holds.

- Both composers call the same `context.append`. ContextView gets `onAppend={context ? (events) => context.append(...events) : undefined}` at :525; the raw one is at :601-606.
- The raw path at composer.tsx:338-345 only parses the YAML. It sends whatever parses, through a cast at the page (:605).
- The comment on that cast is false: it says "The raw editor parsed each event with the stream's own input schema", but nothing does that.

Behaviour that changes:

1. Raw appends move to the Events tab, one click away through the `view` search param.
2. The Events composer (append-events.ts:22-49) rejects some input before it reaches `append`: non-mapping entries, unknown top-level fields, a non-string `type`, a non-object `payload` or `metadata`, a non-string `idempotencyKey`, and an empty list. `append` itself also requires a non-empty string `type`.
3. The default draft changes from `events.iterate.com/note/added`, which breaks the README naming rule and is why the README carves out an exception, to `manual/note-added`.
4. The one real loss is appending while watching the Chat rendering, for example appending an `agent/context-added` event and seeing the chat react. The Events tab shows the raw feed instead. Switching tabs unmounts ContextView, so its draft resets; the raw draft resets the same way today.
5. The `+` radio menu becomes a single paperclip tap. Two smaller things go with raw mode: the send button acting as "Append" while a turn runs, and a file drop switching the composer back to Message.

Callers: projects.$slug.tsx is the only one.

Tests: none pin this. A search of the repo finds no spec, unit test or e2e test for "Raw event", "Composer mode" or `onAppendRaw`. The shared composer is covered by specs/admin/admin.spec.ts:88 and specs/dash/contexts.spec.ts:27.

(b) The new shape really is simpler. The page goes from 2 raw-append composers to 1, and the composer from 2 modes to 1. These all go:

- the `AgentComposerMode` and `AgentComposerRawConfig` types;
- the mode, raw draft and submitRawEvents state;
- 4 mode ternaries: canSubmit, submit, the button title and the onDrop switch;
- the CodeEditor branch;
- the radio group and its 7 extra imports;
- the unchecked cast and its false comment;
- the `yaml` dependency;
- the README exception.

(c) No guarantee is dropped. The server-side `append` validation is the real wall. The raw mode was a developer tool for trusted clients, not a safety mechanism.

History shows the reason for raw mode has expired:

- #2706 (2026-09-17) ported raw mode for "apps/os parity", and Jonas asked for that parity at the time. No append composer existed on this page then.
- #3144 (2026-09-25) added the shared append composer to this same page's Events tab.
- #2837 removed the legacy apps/os.

This still removes a user-visible feature Jonas once requested, so say so in the PR.

One small addition to the proposal: `runSubmit` is left with a single caller and can be inlined into `submitMessage`.

On the README: `note` stays an allowed namespace in lint/event-types.test.ts:28, and two os test lines still use `events.iterate.com/note/added`. Either reword README:242 to say `note` is used only in tests, or move those two lines to another namespace and drop `note` from the lint list. Either option is optional.

Risk is low. #2702 showed that a direct button's onClick opens the picker inside the tap on iOS.

## Streamed text is a plain string plus a tail offset, not a sharded ChunkedText with a wire schema nothing parses

- Sweep index: 75; risk: medium; payoff: 5/10
- LOC: Full version: about −170 (−122 product, −48 test).

Conservative step: about −53 (chunked-text.ts −36, test −17). (skeptic measured: I drafted the full version in a scratch copy of apps/agents/src, formatted it with the repo's oxfmt, typechecked it with tsc (exit 0) and ran the agents vitest suite (4 files, 69 tests, all pass). Net change is -155 lines (73 added, 228 deleted). Product code is -116: chunked-text.ts -99, streaming-text.tsx -8, agent-events.ts -4, full-text-snapshot.tsx -4, agent-feed.tsx -1, agent-inspectors.tsx -1, agent-ui-reducer.ts +1. Tests are -39: chunked-text.test.ts -48, a new 10-line blockStarts table test +10, agent-ui-reducer.test.ts -1. The candidate's -170 is about 15 lines too high because it leaves out the new block-start function and its test. For the conservative step, making the schema a plain TS type and dropping negative indexes comes to about -50.)

- Concepts: Before: 2 text representations, a wire schema, and append/slice helpers.
  After: a string plus a tail offset.

### Evidence

Merges the parallel (full removal) and heavy (schema only) rows.

- apps/agents/src/lib/chunked-text.ts:1-99 is a two-level block map with `appendText` and `sliceText`.
- It carries a zod `ChunkedText` schema whose superRefine (:10-47) validates a wire form nothing sends. Only chunked-text.test.ts:11, :31 and :38 parse it.
- The reducer rebuilds the text from the first frame on every publish: projects.$slug.tsx:376 runs `reduceAgentFeed`, which starts from `initialAgentUiState()` (agent-events.ts:43). So each render gets new group objects, and the memo in streaming-text.tsx:9-57 TextGroup never hits.
- sliceText's negative-index branch (:85-88, 'a TUI tail') is used only by the test.
- Four places branch on `typeof text === 'string'`.

### Current shape

Streamed thinking and answer text is held either as a string or as a sharded map. The map's sharing never reaches React, because the feed re-folds from scratch on every publish.

### Proposed shape

Full version:

```ts
// AgentUiLlmStep
thinkingText: string;
responseText: string;
responseTailFrom: number;
// llm-response-frame: { ...step, responseTailFrom: step.responseText.length, responseText: step.responseText + responseDelta, … }
// streaming-text.tsx: blockStarts(text) every 1024 units (surrogate-safe), last 32 shown, the tail animated from tailFrom
```

This deletes chunked-text.ts and its test.

Conservative first step (low risk): keep the rope, and make `ChunkedText` a TypeScript type with no zod schema and no negative-index slicing.

### What changes

- Full version: the DOM is the same (spans, 1024-unit blocks, a window of about 32K characters, the surrogate rule, the tail animation). The re-fold concatenates V8 rope strings instead of copying group maps. The wire validator goes.
- Conservative step: no runtime change.

### Pinned by

- apps/agents/src/lib/chunked-text.test.ts
- agent-ui-reducer.test.ts:71-72, :114-115 and :1301
- No rendering test.

### Skeptic's amended proposal

Make it one PR with the full version only; skip the conservative step. Measured at -155 lines (product -116, tests -39), not -170.

```ts
// agent-ui-reducer.ts, AgentUiLlmStep
thinkingText: string;
responseText: string;
/** Where the latest window's response text starts: the tail the feed fades in. */
responseTailFrom: number;

// llm-response-frame
return updateLlmStep(state, llmRequestOffset, (step) =>
  step.status !== "running" ? step : {
    ...step,
    ...(responseDelta && { responseTailFrom: step.responseText.length }),
    responseText: step.responseText + responseDelta,
    thinkingText: step.thinkingText + thinkingDelta,
  });
// sliceText(x) becomes x at reducer :261 and :527, agent-feed.tsx:335,
// agent-inspectors.tsx:235 and full-text-snapshot.tsx:23

// streaming-text.tsx: TextGroup and the chunked-text import go
export function blockStarts(text: string): number[] {
  const starts: number[] = [];
  for (let at = 0; at < text.length; ) {
    starts.push(at);
    at += 1024;
    if (/[\uD800-\uDBFF]/.test(text[at - 1] ?? "") && /[\uDC00-\uDFFF]/.test(text[at] ?? "")) at += 1;
  }
  return starts;
}
export const StreamingText = memo(function StreamingText({ text, tailFrom = null }: { text: string; tailFrom?: number | null }) {
  const starts = blockStarts(text);
  const first = Math.max(0, starts.length - 32);
  return (<>
    {first > 0 ? <FullTextSnapshot text={text} /> : null}
    {starts.slice(first).map((start, index) => (
      <TextBlock key={first + index} text={text.slice(start, starts[first + index + 1])}
        revealFrom={tailFrom !== null && first + index === starts.length - 1 ? Math.max(0, tailFrom - start) : null} />))}
  </>);
});

// LiveStepStream
<StreamingText text={step.responseText} tailFrom={step.responseTailFrom} />

// looksLikeCode(text: string) checks the whole text (the settled view already
// does), or keep text.slice(0, 4096) at the live call site for zero change
```

- Delete `chunked-text.ts` (99 lines) and `chunked-text.test.ts` (48 lines).
- Move the three surrogate cases into a `blockStarts` table test: `[0,1025]`, `[0,1024]`, `[0,1024,2048]`.
- Prove it in the browser: stream an answer over 32K characters and check the "Latest ~32K characters" banner, "View full text", and the fading tail.

### Skeptic's verdict

The claims check out against origin/main (b3daf4846).

**Why the rope exists and why that reason is gone**

- `git log --follow` shows the rope arrived in #2614 ("Move feed processing to server facets with incremental live state"). Back then the feed was folded on a server facet and published as live state. That is where the zod wire schema, the "structural diffs" comment and the negative-index TUI tail (`streamingTail` in stream-tui) came from.
- #3150 and #3183 moved the fold to the client, so that reason no longer holds.
- Today `projects.$slug.tsx:376` runs `useMemo(() => reduceAgentFeed(events, idle), [events, idle])`. `reduceAgentFeed` (`agent-events.ts:43`) starts from `initialAgentUiState()` on every event-log publish, which happens once per animation frame. Ephemeral `llm-response-frame` rows carry offsets, so `toAgentEvent` keeps them.
- So every publish calls `appendText` once per frame, starting from `""`. Every group object is new, and neither the `StreamingText` memo nor the `TextGroup` memo ever hits. Only `TextBlock` bails, and it bails because string props compare by value; it would do the same with plain strings.
- The `ChunkedText` zod schema, with its `superRefine`, is parsed only in `chunked-text.test.ts`. `sliceText`'s negative indexes are also used only there.

**(a) Semantics.** I checked the block and tail behaviour against the real `appendText`. In 3000 random streams, with split surrogate pairs, lone surrogates and appends spanning several blocks, the blocks from `blockStarts(string)` matched the rope's blocks exactly. The rope's `tailOffset` also always equalled `max(0, tailFrom - lastBlockStart)`: 0 mismatches. What actually changes:

1. `looksLikeCode`. Today the live view checks only the first 4096 characters, because it goes through `sliceText(text, 0, 4096)`. The settled view (`LlmResponseText`) already checks the whole string. With the whole string in both, a live answer whose first ``` or `<codemode` line arrives after character 4096 switches to the plain code block mid-stream, the way the settled view already renders it. Keeping `text.slice(0, 4096)` at the live call site instead makes this change zero.
2. `StreamingText`'s string branch, which renders the whole text with no window, goes away. Only running steps reach `StreamingText`, and theirs are always ChunkedText or `""`, so nothing visible changes.
3. The work per publish changes. The fold concatenates strings and flattens once, instead of copying a group index and a group map on every frame. Settled `LlmResponseText` stops rejoining all blocks on every render. `StreamingText`'s memo now bails on frames that only add thinking.

**(b) Simpler?** Yes. About 7 concepts become 3:

- Before: the `StreamText` union, the four-field `ChunkedText`, the wire schema and its invariants, `appendText`, `sliceText` with negative indexes, the `textGroupSize`/`TextGroup` level, and the `animate` flag.
- After: a string, `responseTailFrom`, and one pure `blockStarts` function.

The drafted `StreamingText` is shorter than the current one, and `TextGroup` goes entirely.

**(c) Guarantees.** Nothing is dropped. The surrogate-pair rule, the 32-block (about 32K) window, the "View full text" snapshot and the tail fade all stay. No wire or storage is involved; this is only client state.

**(d) LOC.** See `locMeasured`.

**What pins the current behaviour**

- `chunked-text.test.ts` is deleted. Its surrogate cases move to a `blockStarts` table test.
- `agent-ui-reducer.test.ts:71-72`, `:114-115` and `:1301` become plain string literals.
- No rendering test or browser spec covers `StreamingText` or "View full text". The one proof still needed is a browser run that streams an answer over 32K characters.

**Risk:** low to medium, UI only.

**The conservative step:** drop it as a separate candidate. It is a trim that leaves the pointless machinery in place.

## The chat input is the house Textarea, not a lazy CodeMirror editor adopted for @-mention pills that no longer exist

- Sweep index: 76; risk: medium; payoff: 5/10
- LOC: About −126 to −131 net. (skeptic measured: Measured on origin/main (b3daf4846). Deleted: composer-textarea.client.tsx (118 lines) and composer-textarea.tsx (19 lines), 137 in all. composer.tsx loses 8 lines (the import and the 7-line JSX at :208-214) and gains about 15 for the textarea, so +7 net. package.json loses 2 and the pnpm-lock.yaml apps/agents importer loses 6. Net is about −132 in source, or about −138 counting the lockfile.)
- Concepts: Two text-input implementations become one.

### Evidence

Merged from the parallel and heavy hunts.

- apps/agents/src/components/composer-textarea.client.tsx:1-118 builds an EditorView by hand: a keymap, an IME check, an update listener, a theme, and `syncingExternalValueRef`.
- composer-textarea.tsx:1-19 is its lazy SSR shell. The route is `ssr: false`, so that shell never server-renders.
- CodeMirror came in with #2574 (0f68b934a) to insert atomic @-mention pills. No mention extension remains, and the draft is plain text (composer.tsx:208-214, :323-336).
- `@codemirror/state` and `@codemirror/view` (package.json:18-19) exist only for this editor.
- packages/ui/src/components/textarea.tsx is a `field-sizing-content` textarea already used in the dash and notes.

### Current shape

The message box is a lazily loaded CodeMirror editor that re-implements a growing textarea.

### Proposed shape

```tsx
<Textarea
  value={message.value}
  onChange={(event) => message.onValueChange(event.target.value)}
  onKeyDown={(event) => {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229
    )
      return;
    event.preventDefault();
    submit();
  }}
  autoFocus={autoFocusMessage}
  rows={1}
  placeholder={message.placeholder}
  aria-label={message.placeholder}
  className="max-h-32 min-h-10 resize-none border-0 bg-transparent px-2 py-2 shadow-none focus-visible:ring-0 dark:bg-transparent"
/>
```

Delete both composer-textarea files and the two dependencies.

### What changes

Unchanged: Enter sends, Shift+Enter inserts a newline, ⌘/Ctrl+Enter sends, IME composition is respected, and text stays at 16px.

What changes:

- Growth comes from CSS field-sizing. A browser without it keeps one row and scrolls.
- Undo is the browser's native undo.
- The field renders with the page, so autofocus lands on first paint.

### Pinned by

None. Needs a manual check in Chrome, Safari and iOS.

### Skeptic's amended proposal

Replace `<ComposerTextarea …/>` at composer.tsx:208-214 with the plain textarea that #2574 removed, and delete composer-textarea.client.tsx, composer-textarea.tsx and the two `@codemirror/*` deps in apps/agents/package.json. Also update the header comment at composer.tsx:1-2, which says "CodeMirror message editor".

```tsx
<textarea
  value={message.value}
  onChange={(event) => message.onValueChange(event.target.value)}
  onKeyDown={(event) => {
    // Enter (⌘/Ctrl too) sends, Shift+Enter is a new line, never while an IME is composing (Safari reports 229).
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229
    )
      return;
    event.preventDefault();
    submit();
  }}
  autoFocus={autoFocusMessage}
  rows={1}
  aria-label={message.placeholder}
  placeholder={message.placeholder}
  className="field-sizing-content max-h-32 min-h-10 min-w-0 resize-none bg-transparent px-2 py-2 text-base leading-snug outline-none placeholder:text-muted-foreground"
/>
```

Use `text-base` with no `md:text-sm`, so the text stays 16px at every width and iOS does not zoom on focus. If the house `<Textarea>` is preferred anyway, it must add `md:text-base leading-snug` as well as the border, ring, `dark:bg` and `min-h` overrides.

Semantic deltas to state in the PR:

- Spellcheck, autocorrect and autocapitalize turn on. CodeMirror turned them off.
- A dropped file no longer also inserts its text into the draft.
- Undo becomes native.
- Growth relies on `field-sizing`.
- Alt+Enter sends.
- Focus lands on mount rather than after the chunk loads.

Nothing pins the current behaviour, so verify by hand in Chrome, Safari and iOS.

### Skeptic's verdict

The claim holds, but the proposal is mis-specified in one place.

**History.** Before #2574 (0f68b934a), apps/os's agent-pill-composer was a plain `<textarea>` using `field-sizing-content max-h-32 … text-base leading-snug`, with an Enter/`isComposing` onKeyDown. #2574 swapped it for a lazy CodeMirror `ComposerTextarea` so it could insert atomic @-mention pills. #2706 (03080f782) then ported that composer to apps/agents "back to apps/os parity", and its own message says "No mentions". So the editor lost the one reason it was adopted, and the port kept the CodeMirror machinery anyway.

**What exists today.**

- A lazy SSR shell. `_auth.tsx` sets `ssr: false`, so that shell never renders on the server.
- An EditorView lifecycle with callback refs latched in `useLayoutEffect`.
- An `initial` / `initialFocusOnMount` capture and a `syncingExternalValueRef` two-way sync.
- A custom theme that re-creates a transparent 16px auto-growing box.

All of this re-implements a controlled textarea. `@codemirror/state` and `@codemirror/view` are imported only here within apps/agents. CodeMirror stays in the app through packages/ui's lazy CodeEditor (raw mode), so the claim is about the message path only, not the bundle.

**(a) Semantic deltas, checked against @codemirror/view 6.43.13 and the code.**

- Unchanged:
  - Enter sends and Shift+Enter makes a new line.
  - ⌘/Ctrl+Enter sends, because Enter without Shift sends whatever other modifiers are held.
  - IME is respected. The `keyCode === 229` check keeps Safari's commit-Enter guarded, which CodeMirror's composing timer handled.
  - The textarea wraps, is capped at 8rem with scrolling, is at least 2.5rem tall, and clears after a successful submit.
- Changes the candidate did name:
  - Growth depends on CSS `field-sizing`. The pre-#2574 composer and the house Textarea already rely on it.
  - Undo becomes native. Today it is effectively absent: there is no `history()` extension.
  - Focus lands at mount instead of after the lazy chunk loads.
  - Alt+Enter now sends as well.
- Changes the candidate missed:
  1. Spellcheck, autocorrect and autocapitalize turn on. CodeMirror's contentDOM defaults to `spellcheck=false`, `autocorrect=off` and `autocapitalize=off` (view dist :8308). That is a visible change on iOS, and it is the normal behaviour for a chat box.
  2. Dropping a file onto the text area stops pasting the file's text into the draft. CodeMirror's native `handlers.drop` reads dropped files with `readAsText` and inserts them (:5132-5155). It fires before React's delegated container `onDrop`, which also attaches the file, so today's drop does both. The textarea fixes that latent double handling.
  3. The house `<Textarea>` carries `md:text-sm`. The candidate's "16px unchanged" is therefore false at ≥768px widths, including iPad, where it would re-open the iOS focus-zoom issue. Default line-height also changes unless `leading-snug` is set.

No caller depends on any of these. Only projects.$slug.tsx uses AgentComposer. No spec or DOM test touches the composer: specs/ has no agents composer spec, and #3446 only deletes the skipped upgrade spec.

**(b) Simpler.** It is clearly simpler: 137 lines and 5 mechanisms (lazy boundary, view lifecycle, ref latching, value sync, theme) become one controlled element of about 15 lines. The chat surface goes from two text-input implementations to one.

**(c) Guarantees.** None are dropped. IME and 16px are preserved once the class list is amended.

**(d) LOC.** About −132 in source, re-measured.

**Amendment.** Use a plain `<textarea>` (the exact pre-#2574 shape), not the house `<Textarea>`. The house component needs about 7 override classes to strip its field chrome (border, ring, `dark:bg`, `min-h-16`, `md:text-sm`), which is a lateral move inside a pill that already draws its own border.

**Risk.** Low to medium. This shape shipped in apps/os before 2026-09-08. It still needs a manual check in Chrome, Safari and iOS for growth, IME and the Enter key. Firefox growth depends on its `field-sizing` support.

## The Dash organization tree's single-flight reload is two promises, not ask/answer counters, a flag and a waiter list

- Sweep index: 77; risk: medium; payoff: 3/10
- LOC: About −26: organization-tree.tsx goes from about 53 lines to about 27. The loaders alternative is about −100. (skeptic measured: apps/dash/src/components/organization-tree.tsx goes from 269 to 252 lines: 22 insertions and 39 deletions, net −17, measured by git diff --no-index on a written sketch. The proposal claimed about −26.)
- Concepts: Five concepts become two: the counters ×2, the flag, the waiter list and settle() become the current and queued promises.

### Evidence

This row merges the parallel and heavy hunts.

- apps/dash/src/components/organization-tree.tsx:50-157 holds a module store plus a read queue (`reader`, `asked`, `answered`, `reading`, `waiting`, `settle`, `read`). The unmount branch settles at :196.
- apps/dash/src/routes/_auth/organizations/$orgId.tsx:65-97 `useRoster` re-reads using `revision` plus its own counter.
- Other pages in the same app use loaders with `router.invalidate` instead: sessions.tsx:73-74 and :168, secrets.tsx:74-76 and :107.
- Nine call sites await `reloadOrganizationTree()`: organizations/index.tsx:150, projects/index.tsx:219 and :228, projects/$slug/index.tsx:620, invitations.$token.tsx:47, and $orgId.tsx:134, :171, :186 and :381.
- `readOrganizationTree()` is also read in a beforeLoad (projects/$slug/route.tsx:12). Child beforeLoads cannot read parent loader data, so a full move to loaders is awkward.

### Current shape

A hand-built single-flight reader keeps an ask/answer ledger and a waiter queue, about 53 lines. It is hard to explain, and the explanation is exactly what a promise chain says.

### Proposed shape

```ts
let current: Promise<void> = Promise.resolve();
let queued: Promise<void> | null = null; // the read behind the one in flight; every ask meanwhile shares it
export function reloadOrganizationTree() {
  if (!reader) return Promise.resolve();
  queued ??= current.then(() => {
    queued = null;
    return readTree();
  });
  current = queued;
  return queued;
}
```

`readTree` publishes only while `reader === api`. Unmount keeps `reader = null; publish(EMPTY)`.

Bigger alternative (high risk, about −100): route loaders plus `invalidate`, with `useRoster` also becoming a loader.

### What changes

Promise chain: a pending reload that is unmounted resolves when the in-flight RPC settles, instead of at once. Coalescing, ordering, the revision and 'a failed read keeps the tree' are unchanged.

Loaders alternative:

- The first paint waits on two list calls.
- A failed read drops the tree.
- Invalidate re-runs every active loader.

### Pinned by

- No unit test.
- specs/dash/organization.spec.ts:9
- specs/dash/project-delete.spec.ts
- The create-project flows.

### Skeptic's amended proposal

Change only apps/dash/src/components/organization-tree.tsx. Delete `asked`, `answered`, `reading`, `waiting`, `settle()` and the while-loop, and remove `settle(asked)` from the unmount cleanup.

```ts
/** the last read asked for, and the read behind the one in flight that every ask meanwhile shares */
let last: Promise<void> = Promise.resolve();
let next: Promise<void> | null = null;

async function read() {
  const api = reader; // the session mounted when the read runs, not when it was asked
  if (!api) return;
  try {
    const [orgs, projects] = await Promise.all([api.organizations.list(), api.projects.list()]);
    if (reader === api) publish(treeOf(orgs, projects, published.revision + 1));
  } catch (caught) {
    if (reader === api)
      publish({
        ...published,
        loaded: true,
        error: caught instanceof Error ? caught.message : String(caught),
        revision: published.revision + 1,
      });
  }
}

export function reloadOrganizationTree() {
  if (!reader) return Promise.resolve();
  next ??= last.then(() => {
    next = null;
    return read();
  });
  last = next;
  return next;
}
```

The unmount cleanup becomes `reader = null; publish(EMPTY);`.

Semantics change:

- On unmount, a waiter resolves when the in-flight RPC settles, not at once. Only pages under `/_auth` await it, and they unmount with the shell.
- Asks made in the same tick while idle share one read.

Net −17 lines. Do not pursue the loaders alternative.

### Skeptic's verdict

I checked this against wt-main at b3daf4846. PR #3446 does not touch apps/dash.

(a) The semantics claim holds. Every behaviour that changes:

1. On unmount, a waiter no longer resolves at once. It resolves when the in-flight RPC settles; a queued read then finds `reader` null and returns.
   - Nothing depends on this. The shell's `api` is one Proxy per tab (packages/iterate/src/app.ts:86-91), so `[api]` never changes, and `<OrganizationTree>` unmounts only when the person leaves `/_auth`.
   - Every awaiting page (organizations/index.tsx:150, projects/index.tsx:228, $orgId.tsx:171/186/381, invitations.$token.tsx:47, projects/$slug/index.tsx:620) sits under `/_auth` and unmounts with it.
   - A hanging RPC would stall both versions the same way: today `reading` stays true.
2. The first read starts one microtask later instead of synchronously. Asks made in the same tick while idle now share one read, where today the second ask forces a second read. Every ask still resolves only after a read that began after it, which is the documented contract at :134-136.
3. The chain must never reject, or it stops for good. `read()` catches everything, so only a throwing `useSyncExternalStore` listener could poison it. That is not a real state. Today the same case also leaves waiters hanging.

Coalescing, ordering, `revision`, "a failed read keeps the tree", the `reader === api` stale guard and "resolve at once when none is mounted" are all unchanged.

(b) The new shape is really simpler, not a lateral move. It replaces:

- `asked` and `answered`,
- the `reading` flag,
- the `waiting` list and `settle()`,
- the while-loop's `through`.

with two promises: `last` (the read most recently asked for) and `next` (the one queued behind the in-flight read, shared by every ask made meanwhile). The unmount `settle(asked)` goes too. The resulting idiom is explained by one comment, where the current ledger needs a paragraph.

(c) No guarantee is dropped. There are no loop limits, security walls or data involved.

(d) I re-measured by writing the sketch and diffing it against the real file: 22 insertions and 39 deletions, net −17. The file goes from 269 to 252 lines, not −26.

The proposal is mis-specified in one place. `read()` must take `reader` when it runs, not when it is asked, and return early when that is null. Otherwise a queued read after an unmount has no session to use.

Drop the "loaders + invalidate" alternative:

- It drops "a failed read keeps the tree" and makes the first paint wait.
- It breaks the snapshot reads in projects/$slug/route.tsx:12 (a `beforeLoad`) and $orgId.tsx:105 (a `head`).
- It cannot be proven at −100.

`useRoster`'s counter is an ordinary React re-run idiom and is not part of this change.

Risk is low, not medium. No unit test covers this code; only specs/dash/organization.spec.ts and project-delete.spec.ts and the create-project flows exercise it. Payoff is small: one leaf client file and −17 lines. It is still a real concept cut in a file whose explanation is currently the machinery.

## Drop the Dash's page-view processor enable: the platform already enables the account and organization folds before every fact

- Sweep index: 78; risk: low; payoff: 3/10
- LOC: About −20 lines. (skeptic measured: I applied the change to a scratch copy. apps/dash/src/components/context-activity.tsx goes from 66 to 45 lines (−21). activity.tsx:56 and $orgId_.activity.tsx:50 lose one line each (−2). The header comment at activity.tsx:3 is rewritten in place, with no net change. Total: −23 lines across 3 files, all in apps/dash, with no platform or test changes.)
- Concepts: Two enablers of the fold become one.

### Evidence

- apps/dash/src/components/context-activity.tsx:39-52 runs an effect with an `enabledFor` ref. On first visit it calls `itx.processors.enable(ensureProcessor)`.
- The same file adds `processors.enable` to ActivityItx (:16) and adds the prop (:22, :29).
- Two callers pass it: activity.tsx:56 and $orgId_.activity.tsx:50.
- The platform's appendPlatformFacts enables the owner's fold before appending every fact: session.ts:237, reached via :375-389.
- apps/os/src/session.test.ts:22-44 pins that enable for both the account and the organization.

### Current shape

Viewing a page writes `processors.enable` as the viewer, which covers a fold-less state the platform no longer produces.

### Proposed shape

Delete the effect, the ref, the `ensureProcessor` prop and `processors` in ActivityItx. The two callers stop passing it.

### What changes

- A context that never received a platform fact no longer gets a fold on first visit; it has nothing to fold anyway.
- Opening Activity makes no write.

### Pinned by

No Dash test pins this. The platform side is pinned by apps/os/src/session.test.ts:22-44.

### Skeptic's amended proposal

Change 1: in apps/dash/src/components/context-activity.tsx, delete lines 39-52, which hold the enabledFor ref, the `processors` destructure and the enable effect. Also delete the `ensureProcessor` prop (lines 22 and 29) and `processors` from ActivityItx (line 16). The type collapses to:

`export type ActivityItx = IterateContextHandle & { append: IterateContextApi["append"] };`

The react import becomes `import type { ReactNode } from "react";`. Cut the ensureProcessor sentence from the header comment (lines 2-4). The header then reads: "…with the dash's fact renderers. The view's composer appends as the signed-in person (the platform stamps the principal)."

Change 2: drop `ensureProcessor="account"` at activity.tsx:56 and `ensureProcessor="organization"` at $orgId_.activity.tsx:50.

Change 3: rewrite activity.tsx:3 in place. It says "with the account fold enabled on first visit"; it should say the platform enables the fold with every fact it appends (session.ts `appendPlatformFacts`).

Semantics delta: a context with facts but no fold row no longer gets one when Activity is opened. That only happens after a failed best-effort org-created publish followed by an org secret cross-post, or after a user disables their own row. In that case the processors sheet shows no fold until the next platform fact. Accounts get a fact at least hourly from recordGrantUse on the Dash's own grant, and orgs get one on any org verb. Platform reads snapshot from the log without a row, so they are unaffected.

LOC: −23 across 3 files. Concepts: two enablers become one, and the ref-guarded client write disappears. Risk: low. Tests: none in the Dash; the platform side is pinned by apps/os/src/session.test.ts:22-44.

### Skeptic's verdict

(a) The semantics claim holds, and it holds more strongly than the candidate says. The platform enables the owner's fold before every platform fact (session.ts:237, pinned by session.test.ts:22-44), and an account gets that enable from many directions:

- every sign-in: keepSignInToken enables "account" directly (identity.ts:655) and then calls appendPlatformFacts;
- every consent: consent-approved via publishPlatformFacts (consent.ts:484);
- every cookie session: #publishAuthenticationFact (session.ts:135/148);
- the Dash's own OAuth grant, at most hourly: recordGrantUse → appendPlatformFacts (oauth.ts:318).

So by the time anyone opens /activity, the account row already exists. The same guard was already on the platform side (apps/os-next session.ts:177-187) when #2763 added it to the Dash on 2026-09-21. It was redundant from the day it landed.

Organizations get the enable from every org verb through publishOrganizationFacts: created, renamed, member and invitation changes, project-added.

The row can still be missing while facts exist, in one of three rare ways:

- an org-created publish, which is best-effort in waitUntil, fails and no later org fact follows, and then an org secret is cross-posted (crossPostSecretFact, built-ins.ts:900-909, only enables "instance");
- a person disables their own row with processors.disable;
- data written before the platform enabled on every fact, which prd erased.

In those cases the Dash's processors sheet shows no fold, and so no live state, until the next platform fact re-enables the row. Nothing on the platform side depends on the row. The platform's own reads (facets.get(name).snapshot in identity.ts, oauth.ts `accountStateOf`, session.ts `endLendsOutOfReach`, and the secrets catalog through ownerRootFacet) catch up from the log without a row: processor.ts:409 `snapshot` runs catchUpFromLog when nothing pushed it.

The other change: opening a read-only page no longer writes. Today a failed enable, for example a member refused on the org context, re-arms the ref and retries whenever processors.rows changes. That noise goes away.

No Dash, spec or UI test pins the enable. `grep` finds no spec that visits /activity.

(b) The new shape really is simpler. It removes a client-side repair of platform state: a once-per-context ref state machine with retry-on-failure, a prop, a member on the ActivityItx type, a React effect and its imports, and 4 lines of comment explaining all of that. Two enablers become one, and the one that stays is on the platform, where user-invisible safety belongs.

(c) No guarantee is lost. The fold row is a display and push concern for this page, and the platform re-establishes it on every fact.

(d) The re-measured delta is −23 lines, not "about −20" (see locMeasured).

This is peripheral Dash code, which is why the payoff is modest. It is still a clean instance of "two mechanisms, one job" and "defensive code for a state the platform does not produce". PR #3446 does not touch apps/dash or session.ts.
