---
status: in-progress
size: large
---

# Processor audit 2026-07: findings and plan

Five parallel critical reviews of the stream-processor estate, run 2026-07-21
right after the agent-next flag-day refactor (#2168) and the
`blockProcessorWhile(work)` signature change (#2170). Scope: the framework
(`packages/iterate/src/processors/`) and all first-party implementations in
`apps/os/src/domains/` plus browser-feed. Review dimensions: code smells,
code volume, testing harness, consistency of the simple abstractions, and
extractable patterns.

Overall verdict: the refactor held. Implementations are lean (ceremony ≈5% of
implementation lines), the two-switch shape is universal, all 17 suites use
`makeProcessorHarness`, replay tests exist. The remaining problems are
concentrated: one stringly-typed cross-DO error contract copy-pasted four
times, docs that still teach the pre-#2168 shape, pockets of dead code with
lying comments, and a harness that stops one level short of what four suites
need.

Each finding below has a stable ID for PR references. Status values: `open`,
`decided` (direction picked, not implemented), `in-pr #NNNN`, `done #NNNN`,
`wontfix` (with reason). Line numbers are as of `cdc370e64`.

---

## A. Shared mechanics (the bug classes)

### A1. Idempotency-conflict tolerance is a message regex, copy-pasted 4×

**Status:** in-pr #2183. **Found independently by 4 of 5 reviews.**

The "losing an idempotency race is success" dance ends in the byte-identical
line

```ts
if (!/idempotency key .* already names a different event/.test(message)) throw error;
```

in four processors:

- `apps/os/src/domains/agents/agent-processor-implementation.ts:1004-1014`
  (`#appendUnlessLostIdempotencyRace`, 11 call sites in-file)
- `apps/os/src/domains/integrations/telegram-agent-processor-implementation.ts:404-414`
  (same method, signature drifted to rest-params)
- `apps/os/src/domains/devices/device-processor-implementation.ts:505-515`
  (array signature)
- `apps/os/src/domains/email/email-agent-processor-implementation.ts:158-169`
  (inlined in a catch)

The message it matches is minted independently in **two** places:
`apps/os/src/domains/streams/stream-durable-object.ts:420` and the harness
`packages/iterate/src/processors/testing.ts:96`. Six files must agree on
wording. Reword the DO's message (or let an RPC layer prefix it) and all four
processors start rethrowing on benign settle races — blocking frames fail,
transport backs off, agents/devices wedge — while harness-backed tests stay
green because `testing.ts` mints its own copy. Conversely, an unrelated error
containing the phrase is silently swallowed.

Sibling strategies for the same race show it's one problem solved three ways
(these are legitimate — they need read-back / observe semantics — but their
message checks should share the predicate):

- `capability-host-processor-implementation.ts:909-979` — on any append
  error, read back `stream.getEvent({idempotencyKey})` and verify a valid
  settlement stands.
- `scheduler-processor-implementation.ts:212-246` — observe-before-append;
  a key occupied by a non-matching event is a loud error.

**Proposals:**

- (a) **Give the string one owner + a predicate.**
  `packages/iterate/src/processors/idempotency.ts` (which already exports
  `sameIdempotentEvent` precisely so prod and tests cannot drift) grows
  `idempotencyConflictMessage(...)` (used by the stream DO and the harness)
  and `isIdempotencyConflict(error)`. Call sites keep their visible
  try/catch and their four different load-bearing comments. A typed error
  class is the wrong fix: the rejection crosses Workers RPC, which preserves
  the message but not class identity — the message IS the wire contract.
- (b) Append option (`{ onIdempotencyConflict: "tolerate" }`): nicer API,
  touches the append primitive's surface.
- (c) Discriminated append result (`{committed} | {conflict}`): cleanest end
  state, biggest change.

**Recommendation:** (a). Smallest surface, kills the drift class, no invented
concept.

### A2. Devices: race tolerance is asymmetric across writers of the same keys

**Status:** in-pr #2183.

Device's at-head sweep tolerates the settle race
(`device-processor-implementation.ts:178`), but the two other writers of the
*same* `notification-settled@<offset>` keys — `checkReceipts` (`:399-416`)
and `#sendNotification` (`:463-485`) — use plain `this.append`. The alarm
lane and a zombie incarnation surface the identical benign race as a thrown
error. Benign today; exactly the drift A1's shared predicate makes visible.

**Fix:** apply the same tolerance at all three writers (lands naturally with
A1).

---

## B. Dead code and duplication (mechanical deletions)

### B1. Agent compaction coalescing machinery is dead, guarded by lying comments

**Status:** in-pr #2178.

`agent-processor-implementation.ts:137-140` and `:780-821`
(`#pendingCompaction` / `#compactionWork` / the microtask yield in
`#queueCompaction`) were built for the pre-#2153 concurrent-blocker world —
the comments still say "Per-event blocking work starts concurrently, so a
microtask boundary lets one batch coalesce several reports". Blockers are now
FIFO per event (`stream-processor-runner.ts:653-671` awaits the chain before
the next event is even reduced), so a second `token-usage-reported` blocker
cannot register until the first — containing the entire compaction — has
settled. `#pendingCompaction` can never hold a superseding entry;
`#compactionWork` is always `undefined` at the next call. The actual
coalescing is done by the stream probe `#laterOverThresholdReportPending`
(`:414-424`).

**Proposals:** (a) delete the machinery, call `#compactHistory` directly from
the blocker, keep the stream-probe supersession guard, fix the comments to
name FIFO as the safety argument. (b) If cross-frame coalescing is actually
wanted (compaction is slow), make it real by moving the trigger to the
at-head pass — a design change, file separately if desired.

**Recommendation:** (a).

### B2. Agent `#configNow()` re-reduces the entire stream for one in-scope field

**Status:** in-pr #2178.

`agent-processor-implementation.ts:893-897`: doc comment claims it serves "the
rare code path (compaction) that runs outside a delivery frame and has no
`args.state`" — false; its sole caller chain starts inside a
`blockProcessorWhile` where `state.config` is in scope, and `#compactHistory`
(`:845`) already holds the events from `#readConsumedEvents()`. Compaction
fires precisely when the stream is longest, and this doubles a full paged
read + full re-reduce to fetch one config field.

**Fix:** thread `config` (or the derived deadline) through
`#queueCompaction`'s input; delete `#configNow`.

### B3. `DeliveryContext.phase` / `observedHeadOffset` / `cursorRevision` have zero readers

**Status:** open.

Defined at `stream-processor-runner.ts:171` (`DeliveryPhase`) and `:182-197`,
computed per event at `:637-642` and `:694-699`. Grep across every
`*-processor-implementation.ts` and the browser client libraries: only
`caughtUp` is ever read (repo:221, scheduler:96, capability-host:142,
agent:447, slack-agent:348, telegram-agent:139, device:134). No importer of
`DeliveryPhase` outside the runner. `tasks/simplify-stream-processor-contract.md`
note 3 already wanted this checked before cutting — the check comes back
empty.

**Fix:** `DeliveryContext` becomes `{ caughtUp: boolean }`. ~50-60 lines, and
three fewer honest-but-unread fields for reviewers to invent cases against.
The runner keeps its internals; this is author surface only.

### B4. Keepalive fire-and-forget→promise bridge duplicated inside the framework

**Status:** in-pr #2178.

`StreamProcessor.#runKeepAliveBackedWork` (`stream-processor.ts:556-571`) and
`StreamProcessorRunner.#keepAliveBackedWork`
(`stream-processor-runner.ts:1023-1046`) are near-identical copies of subtle
resolve/reject/rethrow choreography — the runner's comment admits it ("Same
fire-and-forget→promise bridge as the legacy…"). The runner's copy adds an
`isBlocked` boolean whose only effect is choosing a log line (`:1041-1043`).

**Fix:** one module-level `awaitKeepAliveBacked(keepAliveWhile, work)` (a
plain function, not a concept) used by both; the blocked-failure log stays at
the runner call site.

### B5. Dead harness exports

**Status:** in-pr #2178.

`driveProcessor` (`testing.ts:253-266`) and `eventsOfType`
(`testing.ts:269-272`) have zero users outside `testing.ts`;
`driveProcessor`'s docstring describes the cutover suites' `drive()` helpers,
and the cutover is done. The streams-example-app already shows the real
minimal host (`apps/streams-example-app/e2e/vitest/stream-processor-node.test.ts:70-103`).

**Fix:** delete both.

### B6. slack-agent re-implements readers that `integrations/utils.ts` exports

**Status:** in-pr #2178.

`slack-agent-processor-implementation.ts:910-924` defines private
`readStringField` / `readRecordField` / `readNestedMessageStringField`
shadowing `readString` / `readRecord` from `integrations/utils.ts`
(telegram-agent uses the real ones).

**Fix:** switch to the shared readers; pure deletion.

### B7. capability-host: vestigial `void` + side-effecting wait predicate

**Status:** in-pr #2178.

`capability-host-processor-implementation.ts:527-531`: `void
observedSettlement;` is a no-op that reads like rejection-observation (the
`.then` at `:514-517` already does that job) — delete the line.
`#waitForScriptSettlement` (`:688-711`) smuggles its result out of
`waitUntilEvent` by assigning inside the predicate, then throws an
"impossible" branch — correctness is coupled to the runner evaluating the
predicate on exactly the matching event and never again. **Fix:** re-read the
settled event after the wait resolves (`stream.getEvent({idempotencyKey})`,
the key is derivable) so the predicate stays pure. Alternative (a
`waitForEvent`-returning-the-event runner API) is framework growth for one
caller — skip unless a second caller appears.

### B8. Duplicated slack-agent status-paint block with drifted guards

**Status:** in-pr #2178.

`slack-agent-processor-implementation.ts:486-499` (`#paintRuntime`) vs
`:564-577` (`#repaintPresence`): both compose
`(summary.activity ?? fallbackActivity) + "…"`, dedupe on
`#paintedActivityText`, call `assistant.threads.setStatus`, record the memo —
with drifted gating (one on `hasAssistantThreadUi || generation` checked
twice, the other on `fresh && hasAssistantThreadUi`) and drifted memo
discipline (conditional vs unconditional write). One copy can record a paint
it didn't make after an interleaving — the sticky-status incident shape.
Related: `#callSlackApi` (`:660-668`) string-fishes Slack error codes out of
`Error.message` ("already_reacted" etc.).

**Fix:** one private `#paintActivityStatus(...)` used by both call sites,
gating stays at the call sites where it genuinely differs; have the injected
`callSlackApi` dep surface Slack's `error` code as a property instead of
message-parsing.

### B9. Contract `examples` volume (LOW priority)

**Status:** open (convention only).

~1,080 lines of `examples:` across the 8 largest contracts (repo 266/832
lines = 32% of the file, project 226/767, agent 167/1,039, email 121/468).
Single consumer: `apps/os/src/lib/event-docs.ts` (the public docs site) + a
CI test parsing each example. These are product content — keep, but adopt
"one example per event unless the payload is a result union" as a review
convention and trim repo/project on next touch. No dedicated PR.

---

## C. Type safety

### C1. Registry type-erasure cluster (six erasure points)

**Status:** open.

`stream-processor-registry.ts:161` (`runner: StreamProcessorRunner<any>`),
`:456` (`processor as unknown as StreamProcessor<any, any>`), `:390`
(`new LiveState<Live>({} as Live)`), `:400-401` (`as Live | undefined` +
second `{} as Live`), `:513`, `:527-529`. The documented invariance argument
(`:102-112`) justifies one erasure point; the file has six, and nothing
compiler-checks that `entry.processor` and `entry.runner` share a contract.
`{} as Live` additionally publishes an empty object to subscribers if
`assembleLive` runs before any runner registers.

**Proposals:** (a) a small generic `makeEntry<P>()` constructor so the
pairing is checked at the single creation site; map value stays existential
(~20 lines). (b) LiveState lazy initializer / explicit unassembled sentinel
instead of `{} as Live`. (c) status quo with comments.

**Recommendation:** (a); (b) separately if the empty-`Live` window ever bites.

### C2. browser-feed double-casts events across the UI package boundary

**Status:** open.

`apps/os/src/domains/streams/client-libraries/processors/browser-feed/implementation.ts:86-89`
and `:206-209`:
`event as unknown as Parameters<typeof reduceAgentUi>[1]`. Asserts forever
that the mirror's `StreamEvent` and `@iterate-com/ui`'s reducer event are the
same shape, with the compiler told not to check — drift compiles silently and
corrupts the rendered feed at runtime, in the browser. Also `:275`
`localIndex as number` (use `typeof localIndex === "number"` which narrows).

**Fix:** make `reduceAgentUi` accept the published `StreamEvent` type from
`iterate/processors`. Fallback: one module-level adapter function
centralizing the cast.

### C3. `defineProcessorContract(contract: unknown): any`

**Status:** open.

`processor-contracts.ts:603`, plus schema-boundary double assertions at
`:428`, `:468`, `:542`. The typed overload carries everything; the runtime
`Object.assign` result and the four attached helpers are never checked
against it — a helper whose runtime behavior diverges from the overload is
invisible to tsc.

**Proposals:** (a) type the implementation signature and `satisfies`-check
the assembled object against a runtime-shape type (partial checking). (b)
accept the sanctioned erasure point but add `expectTypeOf` type-tests pinning
each helper's input/output against a sample contract (cheap, catches drift).
(c) leave.

**Recommendation:** (b) at minimum; (a) if it stays readable.

### C4. email-agent: unsound type predicate immediately contradicted

**Status:** in-pr #2178.

`email-agent-processor-implementation.ts:99-113`: the filter asserts
`attachment is StoredInboundAttachment & { size: number }` while checking
only `path`; the mapper then distrusts its own assertion (`path!`,
`size ?? 0`). **Fix:** narrow honestly
(`(a): a is typeof a & { path: string } => typeof a.path === "string"`), drop
the `!`, keep the `??` normalization the mapper already does.

### C5. telegram-agent: four `birthCertificate!` assertions instead of narrowed params

**Status:** in-pr #2178.

`telegram-agent-processor-implementation.ts:241, 258, 275, 355` —
`state.birthCertificate!.config…` inside helpers whose guard lives one frame
up (`:91`); `#repaintTypingAtHead` (`:301`) re-checks null instead, so the
file can't decide whether helpers may assume birth. A future call path that
forgets the guard NPEs at runtime. **Fix:** helpers take the narrowed fields
they need (`connection`, `chatId`) instead of whole nullable state.

### C6. devices: paired credential fields modelled as independent nullables

**Status:** in-pr #2178.

`device-processor-implementation.ts:392-397` — `pushTokenSecretPath` and
`pushTokenSecretUpdatedOffset` are always set/cleared together (reduce arms
`:235-236`, `:258-259`, `:267-268`) but typed independently, so joint use
needs `!` and a desync compiles fine, flowing `undefined` into a fenced
Secret compare-and-clear. **Fix:** one nullable object in the state schema:
`pushTokenSecret: { path: string; updatedOffset: number } | null`. (Contract
change; this contract is young.)

### C7. Agent `raceAbort` discards the abort reason

**Status:** in-pr #2178.

`agent-processor-implementation.ts:1103-1110` — both reject paths manufacture
`new Error("aborted")`, ignoring `signal.reason`, while the runner's own
`abortReason()` helper (`stream-processor-runner.ts:1191-1193`) preserves it.
**Fix:** `reject(signal.reason ?? new Error("aborted"))` — one line, twice.

### C8. Orphaned doc comment in `StreamProcessor`

**Status:** in-pr #2178.

`stream-processor.ts:417-425`: two stacked docblocks on `#parseConsumedEvent`
— the first (carrying the load-bearing "throwing here would wedge the cursor
forever" invariant) describes `#reduceRawEvent`, which now sits at `:452`
undocumented. **Fix:** move the block to its method.

---

## D. Lane use and consistency

### D1. Three coexisting at-head retry strategies; repos keeps a deleted workaround

**Status:** needs decision (recommendation below), then mechanical.

Fleet answers to "what retries a transiently failed at-head append":

- background attempt + keepalive revival (agent
  `agent-processor-implementation.ts:442-447`, devices `:172-190`, repos
  `repo-processor-implementation.ts:235-256`);
- one outer `blockProcessorWhile` holding the frame so redelivery retries
  (capability-host `:144-150`, scheduler `:96-99` — both with real
  justifications: promptness of settle appends);
- repos **additionally** consumes `stream/woken` + `stream/subscriber-connected`
  as re-check triggers (`repo-processor-contract.ts:620-627`) — the
  workaround the simplify-streams task marked DELETE for the agent, and a
  hidden third recovery lane the docs never mention.

**Proposals:** (a) legitimize the first two lanes with a written decision
rule in `docs/writing-stream-processors.md` ("settle appends that must land
promptly → one outer blocked frame; everything re-derivable at leisure →
background attempt") and delete repos' wake-event consumption. (b) align all
to outer-block. (c) align all to background + make keepalive retry transient
failures.

**Recommendation:** (a).

Doc rule shipped in the docs PR; code half still open.

### D2. slack-agent blocks a cosmetic repaint that telegram-agent backgrounds

**Status:** needs decision.

`slack-agent-processor-implementation.ts:341-350` blocks the frame on
`#repaintPresence` — Slack `setTitle`/`setStatus` vendor calls hold the
cursor for the thread's durable message pipeline. The call-site comment
explains ordering, not why losing the paint would lose a per-event
consequence (it wouldn't: freshness-gated cosmetics).
`telegram-agent-processor-implementation.ts:137-141` backgrounds the exactly
analogous typing repaint with a textbook justification. A hanging Slack API
call head-of-line-blocks transcription and sends — the failure mode
`stream-processor.ts:95-98` warns about.

**Proposals:** (a) move to `runInBackground` (the memo fields already make it
latest-fact-wins); split out only title-clear-on-revival if that truly needs
at-least-once. (b) keep blocking but bound with a timeout and write an honest
justification. (c) doc note legitimizing durable-state paints blocking.

**Recommendation:** (a).

### D3. agent-collection's reducer throws on committed facts

**Status:** open.

`agent-collection-processor-implementation.ts:68-71` and `:124` — the only
reducer in the fleet that can wedge its cursor on a committed event, against
the doctrine every sibling states in-file (workspace, secrets `:73-75`,
capability-host `:242-244`, notifications `:68-69`) and the docs checklist.
One out-of-order or provenance-less committed copy (raw append, subscription
misconfig) wedges the project's whole agent catalog forever, on a pure
projector with no recovery story.

**Fix:** skip-and-log (return state, `console.error`), or skip-and-journal a
`stream/error-occurred` if operators need the trail.

### D4. Obligation terminal naming split (+ scheduler hybrid)

**Status:** decided direction, migrations deferred.

New shape (`-settled` + result union incl. cancellation): agent,
capability-host, devices, projects. Old split terminals: repos
(`repos/created`+`create-failed`, `repo/github-import-completed`/`-failed`,
`github-push-completed`/`-failed`, `repo-processor-contract.ts:175,335-355,466-503`).
Hybrid: `scheduler/trigger-completed` with an outcome union
(`scheduler-processor-contract.ts:266`). Wire formats are stable — no urgent
renames; renames need journal-compat thinking like the agent cutover.

**Plan:** fix the docs now (E1); new obligations must use `-settled`;
consider renaming scheduler's single event opportunistically; leave repos.

### D5. Idempotency-key spelling: three dialects, one fan-in hazard

**Status:** open (doc rule + targeted fix).

Dialects: (1) the framework helper `this.idempotencyKey(key, event)` (most
processors); (2) hand-rolled literals reimplementing the format — the whole
telegram pair (`telegram-processor-implementation.ts:192`,
`telegram-agent:163,196,214,268,278`), which also **omit the `@path`
component** the helper's docstring calls load-bearing for fan-in safety;
(3) deliberate cross-processor collision keys (`agent/binding:…`,
`slack-agent/created:…`, `email-route:…` — email `:89,260,277`, slack
`:90,196,213`) where collision is the point, indistinguishable from drift.
Inside the agent file the helper is used with three separators (`settle/`,
`assistant-context@`, `resume/`).

**Plan:** style-guide rule (helper with `@<identity>` for processor-scoped
keys; raw literal ONLY for intentional cross-processor convergence, flagged
by comment). Telegram's committed keys are declared stable wire formats
(`telegram-agent:20-21`) — migrate new streams only, note the fan-in caveat.

Doc rule shipped in the docs PR; code half still open.

### D6. Birth-gate placement varies four ways

**Status:** open (doc rule only).

Whole-hook gate (slack-agent:121, telegram-agent:91, telegram:84,
scheduler:73); per-case (email:65, email-agent:59, slack:58); caughtUp-branch
only — unborn agent still transcribes context and errors (agent:448,
capability-host:143); explicit allow-created-through formula (projects:87-93,
repos:113-114). Consequence drift: an unborn slack-agent silently drops
forwarded webhooks without transcribing them; an unborn agent transcribes.
Nothing records which choice is deliberate.

**Plan:** doc rule — "gate the whole hook unless a pre-birth event
legitimately has a consequence; then gate per-case with a comment." No
mechanical alignment (agent semantics look intentional).

Doc rule shipped in the docs PR; code half still open.

### D7. Only the agent emits `stream/error-occurred`

**Status:** in-pr #2188.

The style guide says failures journal `stream/error-occurred` next to
settlements; in code only the agent does (`:562,699`). Everyone else uses
settle unions, domain `-failed` events, console, or throw-to-hold-frame.
Runner-side emission is already on the simplify-streams outstanding list —
that's the right long-term home. Meanwhile reword the style rule to match
reality (settle unions ARE the error record outside agent-visible streams).

Doc rule shipped in the docs PR; code half still open.

### D8. Scheduler: base-class background lane + synthetic UUID, both unjustified in-file

**Status:** open (comments only).

`scheduler-processor-implementation.ts:338-348` — `#launchExecution`, called
from delivery, uses `this.runInBackground`, whose docstring says
delivery-hook work should use the hook-args lane. Sound (the domain alarm IS
the scheduler's recovery, `:49-52`; the method is shared with the alarm
sweep) but the exemption isn't written at the site. Same for
`crypto.randomUUID()` executionId (`:302`) vs the "identity = stream offset"
style rule. **Fix:** two one-line comments naming the exemptions. A redesign
of trigger identity onto the requested event's offset is a separate task if
ever wanted.

### D9. Small stragglers

**Status:** open (batchable).

- browser-feed spells hook args as `Parameters<StreamProcessor<…>["reduce"]>[0]`
  (`implementation.ts:109-117`) instead of the exported `ReduceArgs` /
  `ProcessEventArgs` added by #2154 as the one sanctioned spelling. (done in this PR)
- Two clock idioms: five identical `#now()` methods (agent:1027,
  slack-agent:677, slack:151, capability-host:991, projects:542), two inline
  `(this.deps.now ?? Date.now)()` (telegram-agent:240,300), and
  optional-vs-required `now` dep split with no principle. Doc rule: required
  `now` for anything with expiry logic. Doc rule shipped in the docs PR; code
  half still open.
- Expiry stamp types drift: epoch-ms (agent, capability-host, devices,
  notifications) vs ISO strings (project approvals, scheduler) — visible
  where `notification-processor-implementation.ts:55` converts at the
  boundary. Pick epoch-ms for new contracts (majority). Doc rule shipped in
  the docs PR; code half still open.
- `<slug>/configured` implies three different merge semantics (agent/workspace
  patch-merge via `mergeProcessorConfig`; sandbox per-key null-unset;
  telegram wholesale replace). Fine per-domain; one doc sentence so the
  suffix stops implying the recipe. Doc rule shipped in the docs PR; code half
  still open.
- `.meta`/examples coverage is bimodal: agent contract 105 descriptions,
  repos 87, projects 74 — vs email-agent 5, telegram-agent 7, slack-agent 9,
  notifications 2, browser-feed 1; four facet contracts have zero examples.
  Backfill opportunistically.
- `repo-processor-implementation.ts:126-130` — the only laneless synchronous
  side effect in the fleet (idempotent in-memory cache poke); one doc
  sentence legitimizes it. Doc rule shipped in the docs PR; code half still
  open.
- 10 inline `error instanceof Error ? error.message : String(error)` across
  8 files plus two named variants — below the threshold where a shared
  helper beats visible code; leave.

---

## E. Docs debt (one PR, outsized leverage)

### E1. `docs/writing-stream-processors.md` teaches the pre-#2168 contract

**Status:** in-pr #2188. **Urgent and free.**

- `:199-201` and `:290-292` narrate `llm-request-scheduled` and
  `llm-request-completed {failure: orphaned}` — both deleted by #2168 (the
  shipped contract settles with `agent/llm-request-settled` and retries via
  reduce arithmetic).
- `:152` and the `:393` checklist teach "requested/started/completed" while
  the agreed style is one terminal `-settled` with a result union
  (cancellation as a result kind). A new processor written from the doc today
  reproduces the shape #2168 removed.

**Fix:** sweep the dead names; import the `-settled` style bullets from
`tasks/simplify-stream-processor-contract.md` into the doc (the discoverable
home).

### E2. The same-key-different-body conflict rule is implemented 5×, documented 0×

**Status:** in-pr #2188.

The doc's replay story (`:170-172`) stops at "races collapse at the append
dedup layer" — identical bodies only. Real settle bodies carry
incarnation-dependent fields (`durationMs`, partial text, signed URLs), so
the raced append is a same-key-different-body **conflict**, and the required
responses (tolerate-as-settlement / read-back-the-winner /
observe-before-append) live only in call-site folklore. **Fix:** one
paragraph after the idempotency-keys section naming all three shapes and
when each applies (pairs with A1's predicate).

### E3. "Deterministic body: anchor to `event.createdAt`, never `now`" — codify

**Status:** in-pr #2188.

The replay-wedge rule (a `now`-stamped expiry turns redelivery into a
same-key conflict forever) is re-explained in near-identical comments at 5+
sites (slack-agent:266-270, telegram-agent:155-160, agent:318-324 and
:514-521, notifications:22-26, repos:151-153 for the deterministic-diff
variant). **Fix:** one doc paragraph under reprocessing safety; site comments
shrink to one line naming the concrete hazard.

### E4. `<domain>-defaults.ts` creation-batch convention — write it down

**Status:** in-pr #2188.

~9 files export deterministic birth batches (`capabilityHostCreationEvents`,
`schedulerCreationEvents`, `agentCreationForPath`, …); the load-bearing
property ("the same events an explicit create would append, **so the keys
collide by design**") is stated once, in a comment
(`project-processor-implementation.ts:220-224`). Consumers differ: slack and
email routers send the batch only on first contact; the telegram router
re-appends the whole batch on every forward and relies on key-dedupe — both
correct only because the batches are deterministic. One future `now`/random
in a defaults builder breaks the telegram-style consumer while leaving the
slack-style one green. **Fix:** style-guide bullet: fully deterministic
bodies, keys derived from (projectId, path) only, safe to re-append on every
contact, shared by create doors and birthing routers.

### E5. Chat-facet transcription wire shape — convention, not code

**Status:** in-pr #2188.

slack-agent/telegram-agent/email-agent share an identical `refs` block
(email:141-148, telegram:225-232, slack:191-197), identical YAML transcript
header, identical attachment-loss note (email:117-119, slack:315-317), and
identical `dont-trigger-request` policy spread. A shared "chat facet" base
class would be an invented noun sized wrong; the payload assembly is the
thing reviewers must see whole. **Fix:** one style-guide bullet describing
the transcription shape (one `agents/context-added` per source event,
`role: developer`, YAML headed by the literal source event type, one `refs`
entry, explicit in-content loss note on permanent enrichment failure); the
three files become greppable checks of each other.

### E6. At-head memo repaint pattern

**Status:** in-pr #2188 (one sentence).

slack-agent `#unpaintedPresenceFact` (`:91-109,525-588`) and telegram-agent
`#unpaintedTypingFact` (`:75-79,296-308`) deliberately mirror each other with
cross-referencing comments. Worth one sentence in the doc's freshness-gated
section; no code.

---

## F. Testing harness

### F1. Recovery suites hand-roll ~120 lines of registry simulation each

**Status:** needs decision (mode vs exported substrate).

`telegram-agent-recovery.test.ts:35-156` (harness) vs `:158-236` (the one
test); the same fake `DurableObjectState` + alarm cell + `boot`/`wake`/
`deliverPending`/`advance` block reappears in `email-agent-recovery.test.ts:16-200`,
`repo-recovery.test.ts:58-170`, `capability-host-recovery.test.ts:66-175`,
already drifting (fixed 5 settle rounds vs fixpoint). `testing.ts:5-7`
declares registry harnesses out of scope by policy, while the doc checklist
tells every author to write these tests.

**Proposals:** (a) export a registry substrate (fake DO state + alarm cell +
advance-fires-alarm + deliverPending) from `processors/testing` (or
`processors/cloudflare/testing`); suites keep their scenarios. (b) opt-in
registry mode on `makeProcessorHarness` (`recovery: true`) booting the real
registry so `["crash"]` + `["advanceTime", …]` fires real revival and
recovery scenarios become ordinary step scenarios. (c) status quo.

**Recommendation:** (b); (a) as fallback if one-harness-two-modes feels like
creep.

### F2. `settle()`'s fixpoint under-waits; failure output is thin

**Status:** open.

`testing.ts:424-431`: settle stops on the first head-quiet round after
draining exactly two macrotasks — the "2" is load-bearing and undocumented.
Work needing more hops lands after settle returns, so suites bolt
`vi.waitFor` on top (the `waitFor`+`settle` pair co-occurs 18× in
`scheduler-processor.test.ts` alone; 35 `vi.waitFor` across in-memory
suites). `releaseDueSleeps` (`:390-397`, also a quadratic spread-reduce) runs
only inside `advanceTime`, so an already-due sleep parks until the next
advanceTime step. Failure says "did not reach a fixpoint in 50 rounds" with
no event types/offsets; a failing `play()` doesn't name the step.

**Fix:** require N (2-3) consecutive quiet rounds; release due sleeps at the
top of every round; settle failure lists the last round's appended event
types + head offset; `play` wraps step failures with step index/kind via
`cause`. Deletes most waitFor+settle pairs.

### F3. `h.events()` is untyped → 50 payload casts across suites

**Status:** open.

Harness returns `payload: unknown`; suites cast (`payload as {…}`) 50 times —
one executionId extraction repeated verbatim 8× in `agent-processor.test.ts`
(`:852,945,996,1069,1095,1143,1189,1310`) plus 20 `[0]!` bangs. The contract
already knows every schema (consumed and emitted).

**Fix:** make `events` generic over the contract's event map — a literal in
the contract returns `z.output` of its payload schema, foreign strings fall
back to `unknown`. No new method; shortens nearly every existing test.

### F4. `MemoryStream` has no serialization boundary; runner spec double dedupes key-only

**Status:** open.

`testing.ts:102-108` stores payloads by reference — a cyclic or
symbol-carrying payload journals happily in tests and breaks at the
production JSON boundary. And the runner spec's own journal double
(`stream-processor-runner.test.ts:165-171`) dedupes on key only — the exact
masking bug `MemoryStream`'s comment (`:92-95`) warns about — so the
framework's most authoritative suite cannot catch a runner change that
appends same-key/different-body.

**Fix:** (a) JSON round-trip payloads in `MemoryStream.append` (flag-day:
suites passing Dates/class instances will surface — that's the point); (b)
port the spec double's commit to `sameIdempotentEvent`.

### F5. Harness hides the processor instance and registry-style `reads`

**Status:** open.

`createProcessor` swallows the instance, so suites keep mutable cells
(`const live = { scheduler: undefined as unknown as SchedulerProcessor }`,
`scheduler-processor.test.ts:99-127`) and hand-wire late-bound
`reads: { snapshot, waitUntilEvent }` per suite
(scheduler `:107-116`, capability-host `:100-110`,
`scheduler-rpc-ownership.regression.test.ts:51-63`) — wiring the harness
already owns, with a subtle late-binding requirement (`crash()` must keep
reads honest). **Fix:** expose `processor()` next to `runner()`, and
late-bound `reads` on `HarnessProcessorDeps` — both production-parity, both
delete recurring gymnastics.

### F6. Three append doors, semantics distinguishable only by context

**Status:** open (doc convention).

`["append", …]` and `h.append()` settle; `h.stream.append()` doesn't — which
is load-bearing ("committed but undelivered") but invisible: 29 raw
`h.stream.append` calls sit visually identical to the settling kind, and the
scheduler suite carries a 4-line header explaining the trap (`:10-13`).
Also 109 of ~400 `play` calls are single-step where the method form is
plainer. **Fix:** doc convention only — tuples for the scenario spine,
methods for single actions, `h.stream.append` is THE committed-but-undelivered
door. No API change.

### F7. Scheduler xfail trio: correct xfails, stale surroundings

**Status:** blocked on RPC-disposal product work.

The three `test.fails` in `scheduler-rpc-ownership.regression.test.ts:111-149`
are product gaps (no disposal), not harness gaps. But the suite predates the
harness: it duplicates `makeMemoryProgressStore` verbatim (`:20-34` vs
`testing.ts:349-363`) and a local deliver loop. When disposal ships, rewrite
the trio on `makeProcessorHarness` (+ F5) and delete the local plumbing.

### F8. Magic `advanceTime` numbers encode config defaults

**Status:** open (convention).

`["advanceTime", 10_000]` silently encodes the debounce default across the
agent suite; exactly one test reads it honestly
(`agent-processor.test.ts:796-809` via `h.state().config.llmRequestDebounceMs`).
Where the arithmetic is the point, read the config; leave the rest.

---

## Suggested sequencing

1. **This PR:** the findings doc.
2. **Docs PR (E1-E6 + the doc rules from D1, D5, D6, D7, D9):** urgent, free,
   stops new code copying dead shapes.
3. **Mechanical deletions PR (B1-B8, C4, C5, C7, C8, D9 ReduceArgs):** no
   design decisions, all deletion or one-file fixes.
4. **A1+A2 PR:** conflict-message owner + `isIdempotencyConflict` + the four
   call sites + devices asymmetry + harness minting the shared message.
5. **Type-safety PR (C1, C2, C3, C6):** registry entry constructor,
   browser-feed boundary, contract type-tests, devices credential object.
6. **Harness PRs (F2+F3+F5 together; F4 as its own flag-day; F1 after the
   mode-vs-substrate decision).**
7. **Decisions needed from Jonas:** D1 (bless two lanes, kill repos
   wake-events?), D2 (background the slack repaint?), F1 (registry mode vs
   exported substrate), F4 (accept the flag-day), D3's flavor (log vs
   journal).

Audit provenance: five subagent reviews, 2026-07-21, session
39e36840 continuation; ~1.1M review tokens over the framework + 18 processor
files + all test suites.
