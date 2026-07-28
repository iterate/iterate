---
status: in-progress
size: large
branch: simplify-streams
---

# Simplify the stream processor contract: the processor decides, the framework informs

Direction: a stream processor is a contract (schemas + metadata), a pure
`reduce`, and a synchronous `processEvent` that enacts side effects. Different
stream modalities — a must-process-every-message queue (financial
transactions) vs a coding agent that mildly prefers not to double-start LLM
requests — are AUTHOR choices expressed inside `processEvent`, given honest
delivery information. They are not framework machinery. The framework owes the
author exactly: ordered at-least-once delivery, honest "is my fold complete"
info, two side-effect lanes (block vs background), and revival after eviction.
Everything beyond that is surface for reviewers to invent pathological cases
against.

Post-#2002 state: batches are already invisible to authors (runner processes
one event at a time; the harness pins partition-invariance — one batch,
singletons, or random partitions produce identical outcomes,
`stream-processor-runner.ts:21-25`). What remains is vocabulary and appendages.

**The proving ground (agreed 2026-07-20): a clean-room re-implementation of
the agent processor** on the simplified contract, real — context, files, LLM
request construction, itx script execution, response parsing — with really
clean tests. See the last section.

## Framework simplifications

1. **Purge "reconcile" as framework vocabulary.** 16 uses across
   `docs/writing-stream-processors.md` + `docs/domain-objects-and-stream-processors.md`,
   47 in `packages/iterate/src/processors` comments. There is no reconcile
   hook (that was the point of #2002) — there is only `processEvent`, and a
   processor that derives side effects from its accumulated state guards them
   with one line: `if (!args.delivery.caughtUp) return`. The docs should say
   that sentence instead of teaching a concept. Processors' own private method
   names are author code — theirs to keep or rename.

2. **Delete `blockProcessorWhileCaughtUp` (the third primitive).** It exists
   only because `blockProcessorWhile` starts registered work immediately and
   awaits all blockers concurrently (`stream-processor-runner.ts:664-680`), so
   a second, deferred lane was needed to order fold-derived appends after
   per-event appends. Fix the cause: run `blockProcessorWhile` work in
   registration order (FIFO per event). Then authors order work by writing it
   in order, and the primitive count returns to two. Verify first that no
   production processor registers multiple blockers on one event and needs
   them parallel (survey says none do).

3. **Delete dead author surface.** Of 18 production processors, zero use
   `eventsBehindObservedHead`, `streamMaxOffset`, or `checkpointOffset`; the
   `validate` hook (`stream-processor.ts:409`) has no caller until the gated
   Phase-2 inline runner exists and no overrider. Cut all four.
   `DeliveryContext` shrinks to `phase` + `caughtUp` (check browser projection
   before also cutting `cursorRevision`/`observedHeadOffset`). Fewer honest
   fields = less for AI reviewers to fantasize about.

4. **Retire the "future high-throughput batches" justification.** Zero code,
   comments, or tasks reference the PCM/voice case. If it ever comes, that
   traffic is ephemeral, and ephemeral events never reach durable processor
   delivery in either lane (`stream-event-sender.ts:605-609`, `1086-1096`;
   storage default excludes them). Batches need no defense as a semantic
   concept because they aren't one: they are a catch-up paging unit (1000
   events / 1MB) and an append-coalescing unit. Say exactly that, once, in the
   docs, plus: any "pathological batch" scenario that does not reproduce under
   singleton delivery is not real, and the partition-invariance harness
   property is the proof.

5. **Decide the fate of the event-less pass** (`processEvent` with
   `event: null`, `stream-processor-runner.ts:696-738`). Not batch-caused — a
   singleton frame whose head event is an unconsumed type (e.g.
   `stream/connection-closed`) triggers it too. Options:
   (a) make it opt-in (contract flag, or consuming a core head-advance event
   type) so the majority of processors never see `event: null` and never
   write the guard; (b) keep, but documented in one sentence as "your view of
   head can advance without an event you consume"; (c) always-an-event purity —
   manufacture a durable consumed fact at head (rejected so far: write
   amplification on every presence fact). Leaning (a).

6. **Rewrite the two docs around modalities.** Lead with the queue-vs-agent
   contrast and the two-lane choice (`blockProcessorWhile` = the next event
   waits; `runInBackground` = droppable attempt). Explain `caughtUp` as the
   one load-bearing fact catch-up imposes: behind the observed head your fold
   is partial — outcomes may sit in journal pages not yet replayed — so
   state-derived effects fired there act on stale desires. That is
   information, not policy; what to do with it is the author's call.
   Frame it as the filter-aware form of "the stream's max offset at the
   moment this event was dispatched to you": for a `"*"`-consumer the author
   could compute it themselves from `event.offset` vs the max offset, but a
   subset-consuming processor cannot — whether the events between its last
   consumed event and the raw head are consumable is invisible to it (they
   were never delivered), so the runner must answer "is anything you'd
   consume still ahead of you?". `caughtUp` is that answer, precomputed;
   `observedHeadOffset` stays alongside it as the raw fact. (Jonas: the term
   "caughtUp" is not loved; keep for now.)

7. **Cost honesty.** The duplicate-work risk that `caughtUp`-gating avoids is
   the cheap half (a start-then-cancel LLM request is ~500ms of spend; and
   state-keyed idempotency already dedupes most replay double-fires). The
   machinery's real justification is the expensive half: LOST work — a
   dropped background attempt with nothing to restart it (the 2026-06-10 /
   2026-07-07 incidents). Keepalive + revival stays, and the revived fact is a
   real consumed event, consistent with always-an-event.

8. **Auto-wire `stream/processor-revived`.** Its definition already lives in
   the core (`processor-contracts.ts:854`, surfaced via
   `processorDeps: [CoreProcessorContract]`), but authors must still list it
   in `consumes` by hand and the runner THROWS if they forget
   (`stream-processor-runner.ts` construction check). When recovery is wired,
   add it to the consumed set automatically instead of policing.

### Non-goals

- Removing transport batching. Catch-up pages + frame-end commit cadence are
  why a 1M-event replay went from never to 206s (#1870); singleton frames
  would mean one durable commit per event.
- Changing the wire protocol or the `blockProcessorWhile` / `runInBackground`
  pair's guarantees.

### Open questions

- Does any browser projection read `cursorRevision` / `observedHeadOffset`
  from `DeliveryContext` (as opposed to the progress record)?
- For note 5(a): flag on the contract vs consuming a core event type — which
  reads better in a template app?

## Style guide for writing stream processors (agreed in jam, 2026-07-20)

- **Two files per processor, no more**: `<name>-processor-contract.ts`
  (self-contained: state schema, events, consumes/emits, `processorDeps`) and
  `<name>-processor-implementation.ts` (the class). Tests alongside.
- **Implementation is `reduce` + `processEvent`, each ONE switch.** Cases stay
  inline in the switch (a big case can be the LAST one); only genuinely
  reusable logic becomes a helper. `processEvent` comes before `reduce`.
- **The class opens the file** with a generous docstring explaining how the
  whole processor works end to end; auxiliary types and pure helpers go at
  the bottom.
- **Destructure `args` at the top** of each hook.
- **Event type strings are typed out inline, everywhere** —
  `"events.iterate.com/agents/context-added"`, never an
  `AGENT_CONTEXT_ADDED` constant. Duplication for clarity is good so long as
  refactors are easy and cheap (review round, 2026-07-20).
- **The contract OPENS its file; schemas are spelled inline in it.** A schema
  the contract genuinely uses twice becomes a HOISTED FUNCTION below the
  contract (function declarations dodge the const temporal dead zone) —
  never a top-of-file export. If the implementation needs a schema slice
  (config re-parse), it reaches through `contract.stateSchema.shape.<field>`
  rather than a second export. Prefer restructuring over sharing: the
  context-added payload went from a four-arm discriminated union with shared
  spreads to ONE flat object (role enum + optional fields) precisely to kill
  multi-arm reuse (round 2, 2026-07-20).
- **Every schema property carries `zod.meta({ description })`** — the schema
  is the single source of the docs (tasks/zod-schema-docstrings.md tracks
  extracting hover docstrings from it).
- **Tuning knobs are config, not constants**: every threshold lives in the
  contract's config schema with a default and a doc comment saying why the
  value; `<slug>/configured` events merge partial patches
  (`mergeProcessorConfig` + re-parse), so omitted keys keep their values.
  Policy-like knobs are objects (`llmRequestRetryPolicy: { maxAttempts,
  backoffBaseMs, backoffMaxMs }`) so the same shape can be reused elsewhere.
- **Block vs background, the rule**: per-event consequences (renders,
  transcriptions — the event is delivered once and never again) use
  `blockProcessorWhile`; state-derived consequences (anything under
  `delivery.caughtUp` that a later delivery would re-derive) use
  `runInBackground`. `blockProcessorWhile` takes only the work function; don't
  block without justifying it in a call-site comment.
- **Events that must never be durable declare `ephemeral: true` in the
  contract** (EventDefinition flag): every append/parse lane then defaults
  the envelope flag to true and rejects `ephemeral: false`.
- **Lanes are chosen at the dispatch site**: `blockProcessorWhile` /
  `runInBackground` are invoked inside `processEvent` itself, never inside
  helpers — helpers are plain async functions, unaware of their lane.
- **Policy is a user-space one-liner** over honest facts
  (`if (!args.delivery.caughtUp) return`), not a framework knob.
- **No synthetic ids: identity = journal offset.** The journal already
  assigns every event a unique ordered identity. The real agent contract is
  already halfway there (`llmRequestOffset` in `llm-request-completed`,
  `agent-processor-contract.ts:769`); the residual `requestId` strings
  (`"llm-request:gen-3"`) are the part to delete. Idempotency keys derive
  from offsets too.
- **One terminal event per obligation, named `-settled`, with a result
  union in the payload** (matching capability-host's
  `script-run-requested`/`script-run-settled` promise vocabulary;
  "completed" reads like success). Cancellation is a result KIND inside the
  union — it is a way the obligation settles — so the settle idempotency key
  and the stale-settlement fold-guard cover it automatically. The USER'S
  intent to stop (`agent/interrupted`) stays its own event: "the human said
  stop" and "the request ended cancelled" are different facts. Not
  `-succeeded`/`-failed`/`-cancelled` type triples: they split one obligation's
  terminal state across three types, and every consumer's switch grows three
  near-identical cases.
- **The contract owns every nested data structure** (result unions, message
  shapes, tool-call shapes — all defined and exported in the contract file).
  Anyone needing a piece reaches INTO the contract for it; the contract never
  imports its shapes from users.
- **Core events come from `processorDeps: [CoreProcessorContract]`** — never
  re-declared locally (`stream/processor-revived`, `stream/woken` are core).
- **Concrete names over process-words**: `#inFlightLlmCall` not `#driving`,
  `#runLlmRequest` not `#drive`, `pendingLlmRequestTrigger` not
  `wantsTurnSince`. Comments explain the concrete thing ("the LLM call runs
  for minutes; the journal, not this closure, survives an eviction"), not an
  abstraction.
- **Errors ride `stream/error-occurred`** (core-owned): a processor journals
  its failures as error-occurred events next to the settlement, and the agent
  transcribes EVERY error-occurred on its stream into model-visible context
  (`dont-trigger-request` — retries are the fold's job, visibility is the
  transcript's).
- **Tests are step scenarios on the generic harness**
  (`makeProcessorHarness` in `iterate/processors/testing`): tuple steps
  `["append", ...typed events]` / `["advanceTime", ms]` / `["crash"]` plus
  function steps for processor-specific fakes; assertions via
  `toMatchObject` partial matching on `h.events(type)` / `h.state()`. No
  wrapper functions around append — event literals and spreadable event
  bundles only. The harness knows nothing about the processor under test.

## The test case: clean-room agent processor

Plan: prove the simplified contract by re-implementing the agent processor
clean-room in this worktree — REAL, not stylized: `context-added`, file
handling, actual LLM request construction, itx script execution, response
parsing. Two files plus a clean test suite on the in-memory harness. Jam
continues until it is real; it then doubles as the reference example for the
rewritten docs.

Design decisions already made in the jam (2026-07-20):

- **Request identity = the offset of its `llm-request-requested` event.**
  Settlement events point back with that offset; the in-memory abort map is
  keyed by it. Deleted the `generation` counter (a post-interrupt desire
  necessarily has a newer offset) and a whole dedupe-collision bug class (a
  retry's intent is keyed on the FAILURE's offset, so it can never collide
  with the original intent's key).
- **Desire = `wantsTurnSince { offset, atMs }`** — the offset and timestamp
  of the newest uncovered input (or of a failure warranting a retry).
- **The intent append is blocking; the LLM call is background.** The start
  branch only journals the intent: the processor consumes its own requested
  event, so it returns at head carrying its committed offset, and the adopt
  branch ("open request nobody here is executing") is the ONE place LLM work
  ever starts. Starting fresh and recovering after eviction are the same code
  path; cost is one journal round-trip per turn start.
- **Debounce with NO wake event** (dropped `agent/turn-due`, and
  `stream/woken` isn't needed either): the delayed append IS the intent.
  When the window is open, the at-head pass schedules background
  sleep-then-append-`llm-request-requested`, idempotency-keyed on the desire
  offset. The stale-closure hazard moves into the FOLD, where it belongs:
  `reduce` of `llm-request-requested` folds to nothing when no desire is
  open or a request already is — a late intent (desire interrupted away, or
  a sibling intent won) becomes a harmless journal fact, exactly like a
  stale settlement. Semantic shift, accepted deliberately: the window runs
  from the FIRST uncovered input (each desire schedules its own intent; the
  first to land wins and the turn covers everything folded by then), i.e.
  gather-for-100ms with bounded latency, not trailing wait-for-silence.
  That also closes the old max-wait question — continuous input can no
  longer delay a turn indefinitely.
- **Recovery = adopt-the-same-request, carried by `stream/processor-revived`
  alone.** Eviction with owed work → keepalive alarm fires in a fresh
  incarnation → appends the revived fact → its ordinary delivery at head runs
  the same processEvent code → open request not in `#inFlightLlmCalls` → run it again
  under the SAME requestedAtOffset (a zombie racing us collapses on the
  settle key). No crash-cancel, no `llm-request-started`: the prod contract's
  cancel-started-attempts-then-restart flow needs both, and buys attempt-level
  observability we can add later (settle `{ kind: "cancelled", reason:
  "incarnation-died" }` + a started event + an attempts-per-desire poison cap)
  without changing the shape. Also NOT consumed: `stream/woken` and
  `stream/connection-opened` — prod consumes them as extra "re-check at
  head" signals to paper over exactly the stranded-head problem note 5's
  head-turn guarantee solves in the framework; with that guarantee they are
  redundant here.
- Open: expiry on a quiet stream at the 10-minute horizon still wants a real
  durable alarm, not a background sleep (`tasks/agent-llm-deadline-alarm.md`).

### Implementation status (2026-07-20, same day)

DONE, split across two PRs:
- **PR #2153 (`simplify-streams`)** — framework + docs: `blockProcessorWhile`
  is FIFO per event; `blockProcessorWhileCaughtUp` deleted (8 call sites
  migrated, guestbook template + generated mirror regenerated); `validate`
  hook deleted; `eventsBehindObservedHead`, author-facing `streamMaxOffset`
  and `checkpointOffset` deleted; runner spec pins FIFO ordering;
  `writing-stream-processors.md` rewritten (no named concept — state-derived side effects are plain processEvent code,
  filter-aware `caughtUp` framing, "Batches are transport, not semantics"),
  doctrine doc + CLAUDE.md index updated.
- **This PR (`agent-next-processor`, stacked)** — clean-room processor:
  `apps/os/src/domains/agents/next/` — contract, implementation, tests. 16
  tests prove: full turn, burst coalescing (late intent folds to nothing),
  interrupt mid-flight (abort + cancelled settlement with partial text +
  zombie settle-race loss), eviction mid-debounce, eviction mid-flight
  (same-request adoption), two-live-incarnation zombie race, expiry with
  transcribed admission, retry-via-fold to the configured cap, pause/resume
  breaker, script roundtrip, error transcription, config patch merge, forced
  chunk ephemerality, projection/prompt helpers.

  Reworked wholesale in the 2026-07-20 review round (41 threads): all
  constants deleted (event strings typed out inline; tuning constants →
  config defaults with `agent/configured` partial merge; retry caps →
  `llmRequestRetryPolicy` object, rate-limited special-casing deleted;
  system-prompt key and execution-id prefix constants deleted — prod's
  `agent-output:` prefix reused inline since this REPLACES prod);
  `agent/loop-stopped` → `agent/paused`/`agent/resumed` mirroring
  stream/paused/resumed (user input auto-resumes); LLM failures/expiry emit
  core `stream/error-occurred` next to the settlement and the agent
  transcribes every error-occurred into context; retries are fold arithmetic
  (settled(failed) sets the next trigger under the cap — no rendered nudge);
  framework exports `ReduceArgs`/`ProcessEventArgs` (HookArgCarrier hack
  deleted); `EventDefinition.ephemeral: true` forcibly marks
  `llm-response-chunk` ephemeral at every append/parse lane; single
  `#inFlightLlmCall` slot (at most one open request by construction); settle
  races resolved by the journal's same-key-different-body rejection with a
  conflict-tolerant settle append (first writer wins — also fixes Bugbot's
  harness-masks-conflicts finding, by testing on the shared MemoryStream);
  tests rewritten as step scenarios on the new generic
  `makeProcessorHarness` in `iterate/processors/testing`.

  Round 2 (13 threads, commit 7119a3543): contract-first file layout with
  the one twice-used schema (context-item payload) as a hoisted function
  below the contract; config inlined into the state schema (implementation
  re-parses via `stateSchema.shape.config`); context-added union collapsed
  to one flat object; ONE accumulating `contextItems` list (no
  system/history lanes — system items sit in place; providers accept
  mid-history system content); projection simplified to the one-sentence
  rule (uncovered keyed item replaces in place, covered appends;
  `lastLlmRequestOffset` is the coverage mark; `updatesOffset` deleted);
  trigger source renamed `external | agent-loop` (a webhook is not a
  "user"); `zod.meta({ description })` on every property +
  tasks/zod-schema-docstrings.md; two Bugbot races fixed with regression
  tests (pause clears only self-driven triggers so a raced external message
  survives and auto-resumes; the debounced intent body is deterministic —
  expiresAt anchors to the trigger — so re-schedulings dedupe on the key).

### Outstanding to-do list

- DO/registry wiring for `agent-next` + a cutover plan from the production
  agent processor (journal compatibility: shared event names fold; old
  scheduled/started/cancelled/completed events are unconsumed or
  parse-skipped; decide healing vs fresh-slug migration).
- Note 5: event-less-pass opt-in (contract flag vs core event type) so most
  processors never see `event: null`.
- Note 8: auto-add `stream/processor-revived` to consumes when recovery is
  wired, instead of throwing at construction.
- "Reconcile"/legacy-vocabulary comment sweep through the rest of the
  framework package (processor-contracts.ts, keepalive, registry — the two
  author-facing files are done).
- v2 scope for the clean room: compaction, summary/presence, lifetime token
  totals, script-result spill-to-workspace, `web-message-sent` and
  `token-usage-reported` collapse decisions.
- Quiet-stream expiry alarm (`tasks/agent-llm-deadline-alarm.md`) expressed
  against the clean-room shape.
- Runner-side `stream/error-occurred` emission for failed background /
  blocked side-effect work (today the runner journals it for poison skips;
  processor code journals its own failures) — so "transcribe every error"
  covers framework-detected failures too.

### Implementation plan (recorded 2026-07-20 — Jonas at lunch, decisions per his direction)

Build order: (1) framework simplifications in `packages/iterate/src/processors`
(flag-day, migrate call sites), (2) parallel clean agent processor in
`apps/os/src/domains/agents/next/` — three files: contract, implementation,
test (with its own minimal in-memory harness riding the REAL
StreamProcessorRunner so framework + processor are proven together), intended
as a near-term drop-in. Cleanest possible implementation wins ties.

Decisions resolved by "model context-added / interruption policy after prod":

- D1 RESOLVED: assistant output stays a `context-added` (prod's context model,
  keyed slots/roles/files verbatim), appended ATOMICALLY with `settled` in one
  append call. The interrupt-vs-settle currency race is closed by a
  FOLD-GUARD on assistant context (its `llmRequestOffset` must equal
  `openRequest.requestedAtOffset`, else folds to nothing) — replacing prod's
  `#isRequestStillCurrent` full re-fold.
- D2 RESOLVED: NO `agent/interrupted` event — prod's `llmRequestPolicy` on
  `context-added` is the interrupt mechanism (user/developer input with
  interrupt policy → processor aborts in-flight call, settles
  `{ kind: "cancelled" }`, renders partial text). Bare stop-button lane =
  a content-light context-added with the interrupt policy; revisit only if
  product needs more.
- D3 v1 scope: turn lifecycle, debounce (delayed-intent, window =
  DEBOUNCE + backoff(failure streak)), interrupts + partial-text, adopt
  recovery, expiry settle, rate-limit-aware retry caps (3/7), autonomous loop
  breaker (100), script extraction → capability-host lane → result render,
  files on context, ephemeral chunks, prompt building (role/trust demotion,
  timestamp-last). v2: compaction, summary/presence, lifetime token totals,
  result spill-to-workspace.

Framework changes (this branch, in-place):
- `blockProcessorWhile` becomes FIFO per event (a registration chains after
  the previous blocker); `blockProcessorWhileCaughtUp` DELETED — under FIFO a
  later registration in the same `processEvent` body already runs after the
  per-event work, which is the ordering the third primitive existed for.
  Migrate all call sites mechanically (semantics-preserving rename).
- DELETE `validate` hook (no caller), `eventsBehindObservedHead`, and the
  author-facing `streamMaxOffset` / `checkpointOffset` args (pending grep
  confirmation of zero users incl. tests).
- KEEP for now: the event-less pass (opt-in redesign deferred), `phase`,
  `caughtUp`, `observedHeadOffset`, `cursorRevision`.
- Update the runner's executable-spec tests to pin the NEW invariant (FIFO
  blocker order) and drop assertions on deleted surface.

### Gap vs the production agent processor (audited 2026-07-20)

Prod = `agent-processor-contract.ts` (1008 lines) + implementation (1948).
Structurally it already matches the clean-room design (state-derived side effects at
head, journaled intent, everything downstream keyed on `llmRequestOffset`);
the gap is bridge machinery. Event dispositions:

- KEEP as-is: `created`, `configured`, `context-added` (the projection with
  keyed slots/roles/files is the real conversation fold — adopt wholesale),
  `llm-response-chunk` (ephemeral), `loop-stopped`, capability-host
  `script-run-requested`/`settled` via deps, `processor-revived`.
- RENAME: `llm-request-completed` → `llm-request-settled`; result union gains
  `cancelled` kind; payload keeps `{ requestOffset, durationMs, result }`.
- DELETE `llm-request-scheduled`: the journaled debounce decision. Desire
  lives in the fold; the delayed append IS the intent. Kills `requestId`
  ("llm-request:gen-N" only bridges scheduled→requested) and
  `requestGeneration`.
- DELETE `llm-request-started` + `llm-request-cancelled`: adopt-recovery
  needs neither; requested-phase cancel = settled{cancelled}; scheduled-phase
  cancel has no event to cancel anymore (late intent folds to nothing).
- DELETE from consumes: `stream/woken`, `stream/connection-opened`
  (re-check workarounds; framework head-turn guarantee covers).
- COLLAPSE candidates (decide): `web-message-sent` (sender appends
  context-added itself); `token-usage-reported` (usage already in
  settled.result; compaction usage rides compaction metadata).
- DEFER to v2: compaction, `summary-updated`/presence, lifetime tokenUsage.

State: `currentRequest` two-phase enum + `llmRequests` record →
one `openRequest` (fold-guard forbids a second); `pendingTriggerOffset/
Source` → `wantsTurnSince { offset, atMs, source }`; DELETE
`requestGeneration`; KEEP `birthCertificate`, `config`, `context`,
`autonomousTurnCount` (loop breaker), failure streak
(`consecutiveLlmFailures` + `lastLlmFailureRateLimited` — retry backoff adds
into the debounce window: `DEBOUNCE_MS + backoffMs(streak)`),
`activeScriptExecutionIds`. DELETE the 30-min backstop (the at-head pass settles expired
requests; quiet-stream noticing = the alarm task).

Open decisions for the jam:
- D1: assistant text enters context BY the settled event's fold (result
  carries it; projector derives the history item) instead of a separate
  assistant `context-added` — would delete the `#isRequestStillCurrent`
  re-fold race entirely. Files/keys on assistant output need a home in
  result. Leaning yes.
- D2: explicit `agent/interrupted` event vs prod's policy-on-input
  (`llmRequestPolicy: "interrupt-current-request"` on context-added).
  Stop-button (interrupt without content) argues for the explicit event;
  new-input-interrupts stays a reduce-derived policy. Leaning both, with
  interrupted as the only cancel path a UI may append.
- D3: keep `#partialLlmResponseTexts` (runtime map) + interrupted-partial
  context render — yes, cheap and product-visible.
- Must-keep user-space machinery: script extraction from assistant text +
  result render/spill (30k limit), prompt building (role/trust demotion,
  timestamp-last for prompt cache), rate-limit detection (3 vs 7 caps),
  autonomous-turn circuit breaker (100).
