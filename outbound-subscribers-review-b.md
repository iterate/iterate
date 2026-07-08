# Outbound subscribers — review B: inside the codebase

Lens: abstraction collapse, internal prior art, deletion opportunities. All file:line citations are
against this checkout (`spiritual-hoof`, bc2b2e5e7) unless marked **[main]**, in which case they are
against origin/main (0f38d0ab4, which includes PR #1751's JSONata `condition` + `rule-removed` +
`crossPostedFrom` chain). Line numbers for `stream-durable-object.ts` shift by roughly +30 on main
(jsonata import + compiled-condition cache at the top of the file).

---

## 1. What the code actually does today: the delivery inventory

The platform currently has **five distinct mechanisms** for "when an event lands, something else
finds out". This is the abstraction-collapse headline: the feature ask is not "add a sixth", it is
"pick one shape that lets us delete three of these".

### 1.1 The append commit point and its fan-out

`StreamDurableObject.append` (stream-durable-object.ts:139-239) is synchronous and await-free
through persist (204-206). Everything after is post-commit fan-out that cannot fail the append:
core `#processEvent` side effects per reduced event (210), `#connections.wake()` (211), the
configured-subscriber re-wake reconcile (226-231, with the delicately documented "exactly ONE event
type is excluded as a re-wake trigger" subtlety at 218-225), and idle-timer re-arm (236). Any new
pump slots in exactly here; the commit point itself needs no changes for any proposal below.

### 1.2 Mechanism 1: ephemeral live connections (subscriber-tracked cursor, in-memory)

`stream-connections.ts` `open()` (131-260): per-connection cursor in a closure (147-149), pump
reads `readEvents({ afterOffset: cursor, limit: 100 })` (179), eventTypes filter is skip-not-defer
(139-142, 187-191), delivery is fire-and-forget `processEventBatch` with state-at-maxOffset riding
every batch (208-216). Cursor is in-memory only; dies with the connection. Correct for browsers.

### 1.3 Mechanism 2: configured subscriptions — wake → handshake → retained RPC stub

The durable half is `configuredSubscribersByKey` in core state v9 (core-processor-contract.ts:
259-267), fed by `subscription-configured` events (322-331) validated pre-commit
(stream-durable-object.ts:295-311, 829-855: same-project-only DO addresses; worker refs allowed
only on project streams). The runtime half:

- Stream side: reconcile (683-712), wake (758-791 for DOs via `env.{AGENT,…}.getByName(...).
wakeStreamSubscriber`, 808-827 for workers via a `DynamicWorkerRunner` built from `this.ctx.
exports` — line 817), **in-memory retry** (`#wakeRetryTimers`/`#wakeRetryAttempts`, 82-91 and
  728-748: max 6 attempts, 500ms→30s backoff, explicitly "In-memory is deliberate: an eviction
  drops the timers, but the durable subscription config survives and the next append or subscriber
  read re-wakes").
- Subscriber side: `stream-processor-host.ts` — checkpoint `{offset,state}` in the host DO's KV
  (141, 344-346), re-subscribe with `replayAfterOffset = snapshot.offset` (229-232), generation
  fencing so batches from superseded connections are dropped (73-91, 209-287), poison after
  `MAX_CONSECUTIVE_INGEST_FAILURES = 3` → idempotent `stream/error-occurred` + stay disconnected
  (93, 292-326), idle teardown on both sides with the documented in-memory-timer rationale
  (stream-connections.ts:101-109, host:95-102).

**The subscriber owns the offset.** The whole generation-fencing apparatus exists because the pump
is fire-and-forget while the cursor lives on the other side of an RPC seam — two parties with
different opinions about "delivered" racing each other.

### 1.4 Mechanism 3: cross-post rules (no cursor at all — and lossy)

`rulesById` in core state (contract:268-273; **[main]** plus JSONata `condition` and
`rule-removed`), executed inline per event in `#crossPostMatchingRules` (stream-durable-object.ts:
623-666; **[main]** with `crossPostedFrom` hop chain, structural cycle guard, `MAX_CROSS_POST_HOPS
= 5`, and idempotent per-(rule,offset) `error-occurred` on condition failures). Delivery is
`env.STREAM.getByName(target).append(copy)` under the **source stream's own authority** (872-879).

The under-appreciated fact: **cross-post has no retry and no cursor.** It runs inside
`#runInBackground` (885-897), which catches and logs. The idempotency key
(`cross-post:{ruleId}:…:{offset}`) makes a retry safe — but nothing ever retries. A transient
failure appending into the target stream (cold DO, storage hiccup) silently loses that cross-post
forever. PR #1751 built prd GitHub-repo sync on this. It is the same class of loss as mechanism 5.

### 1.5 Mechanism 4: the scheduler (a persisted call, executed later)

See §2.1 — it is prior art more than a delivery mechanism, but it IS "stream event in, remote call
out, at-least-once".

### 1.6 Mechanism 5: the project-worker fan-out (the thing this feature replaces)

`ProjectProcessor.processEvent` (project-processor-implementation.ts:175-183):

```ts
if (previousState.created) {
  runInBackground(async () => {
    try {
      await this.deps.itx.worker.processEvent({ event: event as StreamEvent });
    } catch (error) {
      console.log("project worker processEvent failed", error);
    }
  });
}
```

Three defects in eight lines: (a) fire-and-forget, `console.log` on failure — **lossy**; (b)
one RPC per event, never batched (contradicting the batch-first doctrine the original design doc
insists on); (c) it only sees the **root stream** — the ProjectProcessor is the `"/"` stream's
subscriber (project-durable-object.ts:39-66), so child streams reach the worker only as
`child-stream-created` announcements (project-processor-contract.ts consumes list). "The user's
worker gets everything" is currently false twice over.

The receiving end is `worker.ts` template `processEvent` (project-repo-template/worker.ts:100-102,
a one-line console.log) reached through `itx.worker` = flattened dispatch on the default repo
worker ref (rpc-targets.ts:2964-2971, `defaultProjectWorkerRef()`).

### 1.7 Bootstrap prior art for "auto-append to every created stream"

The project processor already auto-arms subscriptions on `child-stream-created` for `/agents/**`,
`/secrets/**`, `/scheduler/**` (project-processor-implementation.ts:265-323), via
`buildDurableObjectProcessorSubscriptionConfiguredEvent` (streams/utils.ts:61-87, subscriptionKey
defaulting to `${durableObjectName}#${processorSlug}`). The feature's "every created stream gets
the worker feed" is one more arm of this existing hook — no new trigger mechanism needed.

### 1.8 Environment facts that bound the design

- **One worker.** All eight DO classes live in a single script (env.ts:10-120,
  docs/worker-topology.md). The Stream DO holds `env.AGENT/PROJECT/REPO/SCHEDULER/SECRET/
CAPABILITY_HOST` (stream-durable-object.ts:793-806) and `this.ctx.exports`.
- **The stream can build a full project itx in-process.** `itxForScope` (rpc-targets.ts:2995+,
  "THE one recipe for constructing an itx") needs `{auth, ctx, path, projectId}` — all available
  inside the Stream DO with `trustedInternalAuthContext()`, exactly as `ProjectDurableObject`
  (project-durable-object.ts:59-64) and `ItxEntrypoint` (itx/itx-entrypoint.ts:26-27) already do.
  Precedent PR #1710 (in-process `ProjectCollectionRpcTarget`). The working assumption holds.
- **The Stream DO uses no alarm today** (no `alarm()` method on the class) — the alarm slot is
  free for a durable retry pump.
- **Dispatch model** (docs/dynamic-worker-dispatch.md): a pump calling a worker method with a
  JSON frame is capability-tree dispatch — data-shaped, serialized, correct lane. No protocol
  needs, no fetch-lane involvement, no `DataCloneError` exposure.

---

## 2. Internal prior art: the platform already persists calls five ways

| #   | Persisted form        | Where                                         | Shape                                                                                                         | Executor                                                                                                                                                  | Retry model                                                                                                                              |
| --- | --------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Scheduler action      | scheduler-processor-contract.ts:43-45         | **JS function-source string** (`{kind:"itx-script", script}`)                                                 | synthetic inline stateless worker, `fn(itx, schedule, trigger)`, itx from `env.ITX.get()` at `/` (scheduler-processor-implementation.ts:388-408, 337-355) | at-least-once: pendingTriggers fold + completion idempotency key + alarm sweep re-launch (215-217) + completion-existence read (320-323) |
| 2   | Capability mount      | capability-host-processor-contract.ts:29-59   | **itx-expression** — get-chain with call steps _carrying args_, e.g. `["sandboxes", ["get", "/sandboxes/…"]]` | `evaluateItxExpression(this.#itx, expr)` per call (capability-host-processor-implementation.ts:318-321; itx-expression.ts:15-44)                          | none — evaluated per call, caller observes errors                                                                                        |
| 3   | Configured subscriber | core-processor-contract.ts:77-88              | typed DO address **or** DynamicWorkerRef                                                                      | `getByName().wakeStreamSubscriber` / `DynamicWorkerRunner.invokeCapability(["wakeStreamSubscriber"])`                                                     | in-memory 6× backoff, then silence until next append                                                                                     |
| 4   | Cross-post rule       | core contract:101-107 (**[main]** +condition) | (projectId?, path) + eventTypes + JSONata                                                                     | `env.STREAM.getByName().append`                                                                                                                           | none (idempotency key exists, nothing re-drives)                                                                                         |
| 5   | Worker feed           | project-processor-implementation.ts:175-183   | hardcoded `itx.worker.processEvent`                                                                           | flattened capability dispatch                                                                                                                             | none (try/catch log)                                                                                                                     |

Observations:

- **The scheduler already crossed the "code strings in durable config" Rubicon.** The
  "rejected-for-now: JS script strings in config" position must be argued against
  scheduler-processor-contract.ts:43-45, which stores exactly that and runs it with project-root
  authority. The distinction that survives: scheduler scripts are _runtime data authored by agents
  per schedule_, reviewed nowhere, and that is accepted because a schedule IS user intent; a
  _platform-appended_ subscription (the auto worker feed) should not embed code because the
  platform would then own code it can never migrate. Address-only expressions for subscriptions
  are still the right call — but say why, not "we don't do script strings" (we do).
- **`ItxExpression` is already more than an address.** Capability-host expressions carry call
  args (`["get", agentSandboxPath(...)]` — project-processor-implementation.ts:469-497). The
  sketch's "expression = address only, never constructs" is a _narrowing_ for the subscription
  use, not the existing type's semantics. If subscriptions adopt `ItxExpression` verbatim, they
  inherit arg-carrying call steps whether we like it or not; a narrowed
  `ItxAddressExpression` (strings + arg-less final call?) would be a new named type — or accept
  the full shape and let validation live at configure time (parse + dry-evaluate to a function).
  My take: **adopt the full existing `ItxExpression` and do not invent a sibling** — one persisted
  shape, three consumers (capability mounts, subscriptions, scheduler could grow an
  `{kind:"itx-call", expression, args}` action later), and "constructs" is bounded by what the itx
  surface itself allows, which is already the real security boundary.
- **The scheduler's execution ledger is the best retry state machine in the codebase** —
  requested/completed event pairs, idempotent completion, restart sweep, barren-wake backoff
  (scheduler-processor-implementation.ts:186-232). But it journals _per execution_. A per-delivery
  journal for stream fan-out would double every stream's event count; the working sketch's
  SQLite-row cursor (acks are storage, not facts) is the right adaptation. Park/resume _are_
  facts and belong in the log.
- **The old design doc anticipated this feature and parked it.** `/tmp/streams-design-orig.md`
  line 543, under Future work: "Different types of subscriptions — including those where the
  server keeps track of the offset for each consumer." The never-built `external-url` subscriber
  spec (orig lines 179-200) and "TODO: Add webhooks only if we want non-capnweb delivery
  semantics" are the same slot this feature fills; a persisted-call pump gets external webhooks
  nearly free later (an expression addressing a first-party `itx.egress`-backed deliverer or a
  user worker that fetches out).

---

## 3. Past decisions worth unshackling from

1. **Wake→handshake→retained-stub as the only configured delivery.** It exists because processors
   own their checkpoints (offset transactional with state — genuinely right for stateful folds)
   and because pre-#1743/#1710-era thinking wanted live callbacks. Its cost ledger is enormous:
   retained-stub dup/dispose rules (stream-connections.ts:330-433), `onRpcBroken` double-defense,
   delivery-error observation frames (363-433), generation fencing (host:209-287), idle teardown
   on BOTH sides, the DO-duration-leak incident class (memory: cross-script subscriptions pinned
   DOs for hours), and presence-fact churn. Keep it only where its one power — push batches into a
   stateful fold with state included — is used. Everything stateless should not pay this tax.
2. **In-memory wake retry** (stream-durable-object.ts:82-91, 728-748). The documented rationale
   ("durable config survives and the next append re-wakes") is honest but wrong for write-once
   streams — the comment itself cites the stalled-deliveries task. Once ANY durable per-subscriber
   state exists stream-side, the rationale inverts completely: the alarm should own retries.
3. **Rules as a separate concept.** `rulesById` vs `configuredSubscribersByKey` are two reducer
   arms, two validation paths, two config verbs, two docs — both meaning "on matching events, do
   a thing elsewhere". A cross-post is a _push subscription whose call is `streams.get(target).
ingest`_. Delete the concept, keep the behavior.
4. **Presence facts in core state for configured connections.** Every idle cycle on an agent
   stream appends ~5-6 `subscriber-disconnected` + later ~5-6 `subscriber-connected` (agent birth
   configures agent, cloudflare-ai, openai-ws, capability-host, plus slack/email —
   project-processor-implementation.ts:437-445); every wake appends `woken` + reconnects; `woken`
   clears the roster (DO:374-381). This is honest observability _of a mechanism that mostly
   shouldn't exist_. For whatever keeps wake mode, presence stays; for pump-delivered
   subscriptions, delivery state is rows + park/resume facts, not connection theater.
5. **The root "\*" fan-out as the worker feed** (§1.6). Wrong stream (root only), wrong grain
   (per-event), wrong delivery (lossy). Nothing worth keeping.
6. **Stringly subscription keys.** `${durableObjectName}#${processorSlug}` parsed back with
   `split("#").at(-1)` (host:154-161). Any rework should make subscriptionKey opaque and carry the
   processor slug in the wake/config payload explicitly.

---

## 4. The five radical options, honestly scored

1. **PULL-ONLY COLLAPSE** — strong. `catchUp` (host:365-386) already IS the pull loop; pull-only
   makes it the only loop and deletes the handshake/generation/retained-stub complex. Costs: +1-2
   RPCs per batch; browsers still want live push (keep ephemeral connections for UI/`waitForEvent`
   — so "one mechanism total" is really "one machine mechanism + one human mechanism"). The
   worker CAN be poked — `invokeCapability(["pokeStream"])` with a tiny frame is exactly the wake
   path at stream-durable-object.ts:808-827. → **Proposal B.**
2. **WORKER-AS-THE-ONLY-SUBSCRIBER** — strong as _surface_, weak as _implementation totality_.
   Platform-critical flows (GitHub→repo sync, email/slack routers, agent processors) must not
   depend on user-editable code; they stay DO-side. But everything user-extensible collapsing to
   "edit worker.ts" is maximal conventions-over-frameworks. → **Proposal C.**
3. **SUBSCRIPTIONS-AS-STREAMS/OUTBOX** — rejected. A per-subscription DO/stream adds a DO hop and
   a second journal per edge purely to reify delivery state that fits in one SQLite row next to
   the log. DO economics (per-request billing, cold starts, more names to reconcile) all point the
   wrong way; the event log IS already the outbox — an outbox-of-the-outbox is indirection with no
   new power. Its one virtue (delivery history as events) is better served by park/resume facts on
   the source stream.
4. **EVERYTHING-IS-A-PROCESSOR** — half-adopt. Making the pump literally a `StreamProcessor`
   misfits: the runner has no backoff/alarm (retries live in the _host_, host:292-326), its ingest
   contract expects an external feeder while the pump reads its own log, and parse-poison/
   announcement machinery is dead weight for a `consumes:["*"]` effect. But its _bookkeeping form_
   — `{offset, state}` snapshot per consumer, checkpoint-before-advance, dedup-by-offset,
   idempotent error facts — is exactly right and should be reused _as a shape_ (cursor row ≅
   snapshot; park ≅ poison), keeping the "subscriber keeps track of offset" rule and the "stream
   keeps track of offset" rule structurally rhyming. Folded into A and B.
5. **PERSISTED-CALL PRIMITIVE** — adopt, with §2's caveat: the primitive already exists
   (`ItxExpression`, types.ts:1618-1619) with two consumers (capability mounts; agent-birth sandbox/
   workspace mounts). Subscriptions become its third consumer. Do NOT wrap it in a new spec-object;
   the expression plus a fixed call frame is the whole contract. The scheduler stays script-shaped
   (different job: arbitrary user logic, not addressing) — note the option, don't force it.

---

## 5. Proposal A — "The delivery ledger": one subscription concept, stream-tracked cursors, persisted calls

**Thesis.** There is exactly one outbound concept: a _subscription_ = (selector, delivery). Wake
mode keeps today's handshake for stateful DO processors; push mode makes the stream itself the
delivery agent, evaluating a persisted `ItxExpression` against an in-process project itx with a
fixed frame, tracking `acked_offset` per subscriber in a SQLite table beside the event log, with
alarm-driven retries and a park/resume state machine as core events. Cross-post rules and the
lossy worker fan-out are both deleted and re-expressed as push subscriptions.

**Data model.**

```sql
-- next to events/event_chunks in the same DO SQLite (stream-storage.ts)
create table if not exists outbound_deliveries (
  subscription_key text primary key,
  acked_offset     integer not null default 0,   -- exclusive; next delivery starts at +1
  attempt          integer not null default 0,   -- consecutive failures since last success
  next_attempt_at  integer,                      -- epoch ms; alarm target when retrying
  last_error       text
);
```

Rows exist for push-mode subscriptions AND as the (cursor-less, `acked_offset` ignored) retry
ledger for wake-mode wakes — the two in-memory maps (`#wakeRetryTimers`, `#wakeRetryAttempts`)
die. Park status lives in the FOLD, not the table: parked/resumed are facts.

**Core events (state v10).** `subscription-configured` becomes the ONE config event:

```ts
payload: {
  subscriptionKey,                        // opaque
  selector?: { eventTypes?: string[], condition?: string /* JSONata, compile-validated pre-commit */ },
  delivery:
    | { mode: "wake", target: ConfiguredStreamSubscriber }        // today's union, unchanged
    | { mode: "push", expression: ItxExpression },                // evaluated against project itx
  replay?: "all" | "from-now" | { afterOffset: number },          // initial cursor for push
}
```

Plus `subscription-removed` (exists), and new `subscription-parked { subscriptionKey, atOffset,
attempts, error }` (appended by the pump, idempotency `parked:{key}:{atOffset}` — same idempotent
error-fact pattern as host:314-325) and `subscription-resumed { subscriptionKey,
afterOffset? }` (operator/agent verb; reducer flips parked off; side effect updates the row's
cursor when `afterOffset` given, then kicks the pump). Replay control ≡ resume-with-cursor; "all"
≡ `afterOffset: 0`. Deleted events: `rule-configured`, **[main]** `rule-removed`. Deleted state:
`rulesById`. Pre-commit validation merges: push expressions must parse (`assertItxExpression`),
conditions must compile (**[main]** already does this for rules), wake targets validated as today
(829-855).

**Pump.** In post-commit fan-out (after line 211): for each non-parked push row with
`acked_offset < maxOffset`, if not draining, drain serially per subscription: read
`getEvents({ afterOffset, limit: 100, eventTypes })`, apply `condition` (shared JSONata helper —
the **[main]** compiled cache moves out of the rules path and gets reused), skip-not-defer exactly
like connections (cursor advances past non-matching events), then evaluate the expression against
`itxForScope({ auth: trustedInternalAuthContext(), ctx: this.ctx, path: "/", projectId })` and
call it with the fixed frame:

```ts
{ stream: { projectId, path, streamMaxOffset }, subscriptionKey, events, configuredEvent }
```

(`configuredEvent` verbatim — the old design doc's own rule: "the exact event is passed to the
subscriber … so the subscriber can configure itself from committed stream state".) On success:
`UPDATE acked_offset = lastOffset, attempt = 0` (synchronous same-DO SQLite — crash between remote
success and update ⇒ redelivery ⇒ honest at-least-once; the frame carries offsets so receivers
can dedupe). On failure: `attempt += 1`, `next_attempt_at = now + min(30min, 1s·2^attempt)`, set
the DO alarm to `min(next_attempt_at)` over all rows. After N=10 consecutive failures: append
`subscription-parked`, stop. The alarm handler re-runs due drains and re-arms. Wake-mode failures
use the same rows/alarm (attempt/backoff/park), deleting the in-memory retry wholesale. The
in-memory-timer doctrine (stream-connections.ts:105-109) is explicitly inverted for the pump and
the comment should say so: cursor state is durable, so waking a hibernated DO to retry is exactly
what we want.

**Cross-post = push subscription.** New first-party `Stream.ingest({ from, events })` capability
(trusted lane) on the target stream that stamps `source.crossPostedFrom` hops, enforces the
structural cycle guard + `MAX_CROSS_POST_HOPS`, and mints `xpost:{fromProjectId}:{fromPath}:
{offset}` idempotency keys — i.e. the **[main]** `#crossPostMatchingRules` body moves to the
_receiving_ side and the sending side becomes `delivery: { mode: "push", expression: ["streams",
["get", "/repos/foo"], "ingest"] }` with `selector: { eventTypes, condition }`. Same-project
scoping falls out of the itx root (a project itx can't reach other projects); the bespoke rule
validation (857-870) dies.

**The worker feed.** ProjectProcessor's create-requested arm appends to `/`, and its
`child-stream-created` arm (265-323) appends to every new child stream:
`{ subscriptionKey: "project-worker", delivery: { mode: "push", expression: ["worker",
"processEventBatch"] }, replay: "all" }` (idempotency-keyed per stream). The template worker
replaces `processEvent` with `processEventBatch(frame)` (default: no-op with a comment — the
router extension point). Delete project-processor-implementation.ts:175-183.

**Deletions.** `rulesById` reducer arms (490-502 + main's rule-removed arm) and state field;
`#crossPostMatchingRules` + rule validation + **[main]** rule JSONata plumbing (relocated, not
kept twice); `#wakeRetryTimers`/`#wakeRetryAttempts`/`#scheduleConfiguredWakeRetry` (82-91,
728-748); project worker fan-out (175-183); template `processEvent`. Wake mode, connections,
processor host: untouched.

**What falls out for free.** (1) Cross-posts gain retry, cursors, park/resume, and replay — they
are lossy today (§1.4). (2) JSONata conditions become available to every subscriber, not just
rules. (3) External webhooks-out (the never-built old-doc spec) = the same pump with an expression
addressing an egress-backed deliverer or user worker — zero new machinery. (4) One inspection
surface: `runtimeState()` grows the ledger rows and the stream page shows outbound lag per
subscriber the way it shows connections today. (5) The wake retry becomes observable/durable as a
side effect of sharing the ledger. (6) Replay-from-zero of a new consumer is one config event.

**Cons / risks.** Two delivery modes survive (wake + push) — the modality criterion justifies it
(offset lives with whoever owns the state it must be transactional with), but it is still two
modes to document. A second bookkeeping _location_ (table beside KV state) needs a doctrinal
sentence: cursors are storage like event rows, not folded state — high-churn acks must not
double the journal. Expression evaluation inside the Stream DO makes the stream a caller into
arbitrary project capabilities: a slow callee occupies the DO's request budget (bounded by serial
per-subscription drains + fire-and-forget-with-timeout on the call), and re-entrancy
(expression → back into this same stream) must be tolerated (it already is: cross-post re-enters
streams today; idempotency + cycle guard cover it). The `"*"`-feed doubles per-event work on busy
agent streams (one extra RPC per batch per subscriber — fine; the frame is batched).

**Build cost.** M. One new module (`stream-outbound.ts`, ~250-350 lines incl. alarm), contract
v10, `Stream.ingest`, project-processor edits, template edit, delete rules, lifecycle e2e
additions. prd/preview reset acceptable per house rules; no migration code.

---

## 6. Proposal B — "Pokes and pulls": the pull-only collapse

**Thesis.** Outbound _delivery_ dies as a platform concept. The stream only ever emits one thing:
a **poke** — a tiny, durable, at-least-once nudge `{ stream: { projectId, path, streamMaxOffset },
subscriptionKey }` to a persisted call. Every machine consumer pulls: DO processors keep their
own checkpoints and pull via the existing `catchUp` shape; stateless consumers (the project
worker, cross-target ingestion) pull and then `commit(subscriptionKey, offset)` back to
broker-stored cursors, Kafka-style. One transport for machines; ephemeral live connections are
retained ONLY for humans (browser tails, `waitForEvent`).

**Data model & events.** Same `outbound_deliveries` table as A but per-subscriber columns are
`committed_offset` (written by `commit`, not by the pump) plus poke retry columns
(`poke_attempt`, `next_poke_at`). Config event: `subscription-configured { subscriptionKey,
selector?, poke: { expression: ItxExpression } , cursor: "broker" | "subscriber" }`.
`cursor: "subscriber"` rows never track offsets (the DO processor's KV checkpoint remains the
truth — modality criterion preserved); `cursor: "broker"` rows serve `pull`/`commit`. Park/resume
facts as in A, parking only on _poke_ failure — consumer lag is the consumer's business, visible
as `maxOffset - committed_offset` but never an error.

**Verbs.** `Stream.pull({ subscriptionKey, limit })` → `{ events, streamMaxOffset, state? }`
(reads from `committed_offset`, applies the selector) and `Stream.commit({ subscriptionKey,
offset })`. Both trusted-lane, both trivially implementable on `getEvents` (255-276). The poke is
coalesced: at most one in flight per subscriber; re-poke only if `maxOffset` advanced past the
last poked watermark; alarm-driven retry with backoff, exactly A's machine.

**What the DO-processor side becomes.** `wakeStreamSubscriber` handlers stop opening
subscriptions; the wake IS the poke and the handler body is `this.#processorHost.catchUp(slug)` —
which already exists and already checkpoint-filters (host:365-386). Delete from
stream-processor-host.ts: `openSubscription`, generations, `ingestChain` gating, the idle
timer, `supersedeConnection` (169-287) — roughly half the file; keep `add`/`catchUp`/wake→catchUp.
Delete from stream-connections.ts everything configured: retained-stub machinery for machine
consumers, `onConfiguredConnectionLost`, configured idle teardown; the file shrinks to the
browser-tail pump. Presence facts shrink to ephemeral connections; the roster subtleties at
DO:218-231 ("exactly ONE event type is excluded…") die.

**Cross-post & the worker feed.** Cross-post: don't copy — the _consumer_ subscribes at the
source. The repo DO (already a legal subscriber type) pokes-and-pulls the GitHub connection stream
directly and stamps whatever it ingests into its own journal; the generic copy machinery
disappears. Where a literal copy is genuinely wanted, the target stream is the puller:
`poke.expression = ["streams", ["get", target], "pullFrom"]` with a first-party `pullFrom` that
pulls from the source (its own broker cursor) and appends stamped copies — cursor-correct
cross-post with zero new concepts. Worker feed: poke `["worker", "pokeStream"]`; the template
worker's handler pulls (`itx.streams.get(path).pull({ subscriptionKey })`), does its thing,
commits. Auto-append per stream exactly as A.

**What falls out for free.** (1) Backpressure: a slow consumer slows itself, never the stream —
no unbounded retained-callback queues. (2) Consumers can pull WITHOUT a poke (cron, on-demand,
recovery) — resumable feeds are just readers; a broken consumer fixed a week later self-heals
from its cursor. (3) The DO-duration-leak class is structurally extinct for machine consumers —
nothing retains stubs across turns, both DOs hibernate between batches. (4) Massive deletion:
generations, dup/dispose defense, delivery-error observation, both idle teardowns. (5) The
"woken clears the roster" trick becomes irrelevant for machines. (6) `pull` doubles as the
debugging tool ("what would this subscriber see next?").

**Cons / risks.** Latency: poke→pull→commit is 3 RPC legs vs push's 1 (all in-worker, ms-scale,
but agent streams are chatty — the pump-push of A is strictly faster). Two cursor regimes
(broker vs subscriber) must be explained, though the modality criterion already draws that line.
Poke storms need the coalescing watermark done right or busy streams poke every subscriber per
append. Browser lane keeps ephemeral push, so the "one delivery mechanism total" headline is
honestly "one for machines". Biggest cost: every host DO changes (though almost purely by
deletion) — this is the widest blast radius of the three, and the ingest-ordering guarantees the
generation machinery bought must be re-proven for concurrent catchUps (serialize per processor;
`ingest` already dedups by offset, stream-processor.ts:516).

**Build cost.** L. New verbs + poke pump (shares A's ledger/alarm core), template change,
host/connection surgery across agents/project/repo/secret/scheduler hosts, e2e rewrites for
lifecycle (idle-teardown tests become deletions). Payoff is the largest net-negative diff of the
three.

---

## 7. Proposal C — "One pipe to userspace": the worker is the only public subscriber

**Thesis.** The platform offers NO general outbound configuration surface at all. Every project
stream has exactly one implicit outbound edge: a durable, at-least-once, offset-tracked batch feed
to the project worker (`["worker", "processEventBatch"]`, A's pump with the subscriber hardcoded).
ALL routing, filtering, cross-posting, fan-out, webhooks-out, and integrations glue is userspace
code in the project repo — which agents edit through `itx.workspace` and ship by committing.
Platform-critical flows never ride it: DO processors keep wake-mode subscriptions as internal
infrastructure, and the GitHub→repo case is re-expressed as the repo DO subscribing (wake-mode)
to the connection stream directly instead of receiving copies.

**Data model & events.** A's ledger degenerates to at most one push row per stream
(`subscription_key = "project-worker"`). Public config verbs for outbound DO NOT EXIST: no
selector DSL, no JSONata, no expressions in userland — `worker.ts` is the selector, condition,
and router. Core events: keep `subscription-configured` for internal wake-mode only (unchanged),
add `worker-feed-parked` / `worker-feed-resumed` facts per stream (same park machine as A,
`attempt`-driven, alarm-retried). Replay control: `itx.streams.get(path).resetWorkerFeed({
afterOffset })` — one operator/agent verb.

**Pump.** Exactly A's pump minus expressions: frame `{ stream, events, streamMaxOffset }` to the
default worker ref's `processEventBatch` via `DynamicWorkerRunner.invokeCapability` (the plumbing
at stream-durable-object.ts:808-827 already exists for worker wakes — this proposal promotes it
from wake-only to delivery). Per-stream park so one poisoned stream never stalls the project's
other feeds; a worker that fails to BUILD parks feeds project-wide, which must surface loudly in
the dashboard (this is the proposal's sharpest edge).

**Cross-post & first-party accounting (the honest part).**

- GitHub webhook→repo (#1751): becomes a wake-mode repo-DO subscription on
  `/integrations/github/{connection}` — the repo processor consumes the webhook events where they
  live. No copies, no rules. Arguably cleaner than today: the sync logic already lives in the repo
  DO; only the transport changes. Global→project fan-outs that rules' `projectId: null` scoping
  enabled must be re-audited (rule targets were same-project-only anyway, DO:857-870).
- Email/Slack routers, agent processors, scheduler, secrets: wake-mode, unchanged, invisible to
  users.
- Global streams (`projectId: null`): no project worker exists → no feed. They are admin/platform
  surfaces; wake-mode subscribers (repo type is already permitted at null, DO:852-853) remain the
  only consumers. Honest limitation, acceptable.
- User-desired cross-post: `worker.ts` code — `if (stream.path.startsWith("/integrations/x"))
await itx.streams.get("/mirror").append(...)` with the events' offsets as idempotency keys. The
  template ships a tiny routing switch (rhyming with its `APPS` table, worker.ts:21-50) so the
  pattern is discoverable.

**Deletions.** Everything A deletes, PLUS: `rulesById`/rules events _without replacement_
(no `Stream.ingest` needed — userspace appends are just appends; `crossPostedFrom` stamping
becomes a convention helper in sdk.ts), the `worker` member of `ConfiguredStreamSubscriber`
(contract:82-86) as _public_ config, JSONata from the streams domain entirely (**[main]**'s
compiled-condition cache included), and the public subscription surface from itx docs. The
capability-host `ItxExpression` stays where it is; no new consumer.

**What falls out for free.** (1) Routing logic is code in a repo: typed against sdk.ts, reviewed
in PRs, versioned with the project, editable by agents — the strongest possible
conventions-over-frameworks answer; there is no config language to document because there is no
config. (2) Arbitrary transforms/joins/debounce/aggregation — things no selector DSL will ever
express — are trivially available. (3) The platform's outbound surface area is ONE frame shape;
`sdk.ts` documents it once. (4) Park/replay UX is per-stream and uniform. (5) Every stream
becomes programmable the day it is born (the auto-feed IS the extension point onboarding can
demo: "edit worker.ts, watch events flow").

**Cons / risks.** User code sits on the platform's event path: a worker bug parks feeds (per
stream) and a build break parks everything until fixed — needs first-class surfacing, and
first-party features can never assume the feed works. Isolate pressure: every active stream's
batch invokes the worker (content-stable cacheKeys make this a warm-isolate call; the loader cap
incident shows what unstable keys would do). No no-code story for "just mirror these events" —
product accepts "ask the agent to edit the router" as the story (it IS the product thesis, but it
is a bet). Multi-consumer patterns (two independent external systems with independent cursors)
must be hand-rolled in userspace or wait for A/B later — C is deliberately not general.

**Build cost.** M. A's pump (hardcoded), repo-sync re-plumb from rules to a repo-DO subscription,
template router + sdk.ts types, park surfacing UI, deletion of rules. Smallest conceptual surface;
the risk is product, not engineering.

---

## 8. Recommendation

**A is the build; C is the bet; B is the direction.** Concretely: build **A** — it deletes rules,
fixes the two live lossy paths (cross-post and the worker fan-out), reuses `ItxExpression` as-is,
and touches neither the processor hosts nor the browser lane. Ship the every-stream worker feed as
A's flagship subscription with `processEventBatch` in the template. Then C is not a separate
project: it is a _policy_ on top of A (stop documenting the general surface, make the worker feed
the star). B's pull verbs (`pull`/`commit`) are worth adding to A's ledger opportunistically —
they cost ~50 lines given the table, immediately give stateless consumers a recovery path when a
push subscriber is parked, and leave the door open to retiring the wake handshake host-by-host if
the DO-duration economics ever bite again. What I would NOT do: subscriptions-as-streams (option
3), a new persisted-call wrapper type (the expression already exists), or per-delivery journal
events (the scheduler's shape at the wrong volume).

One paragraph of doctrine to write down wherever this lands: _acked offsets are storage, not
facts; park and resume are facts, not storage_ — that sentence keeps the ledger from drifting into
either a journal-doubling event fountain or an invisible side-table, and it is the line the
scheduler (all facts) and the connections pump (all memory) each sit on one side of today.
