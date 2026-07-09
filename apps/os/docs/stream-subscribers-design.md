# Stream subscribers: the unified design

Status: **decided** (design review + grilling with Jonas, 2026-07-08). Ships as **ONE PR**.
History: the exploration record (two independent deep reviews — external prior art and codebase
archaeology — plus the three-way proposal shootout this design descends from) lived at the repo
root during development and was dropped before merge; see PR #1784's early commits
(`outbound-subscribers-review-a/b.md`, `outbound-subscribers-proposals.md`) if you want it. Line refs are against `spiritual-hoof` @ bc2b2e5e7 unless marked
`[main]`.

## Thesis

A stream has **subscribers**, on one axis: **durable** (a persisted `subscription-configured`
event; the stream owes them completeness and remembers, per subscriber, how far delivery got) and
**ephemeral** (session-scoped `subscribe()`; forgotten on disconnect). All durable bookkeeping —
when to poke, retry with backoff, park after sustained failure, per-subscriber lag — lives in a
**durable spine**: SQLite rows beside the event log plus the DO alarm. All warm delivery is the
**one-way streamed lane** that exists today: push frames out, no acks gating anything, subscriber
checkpoints at its own pace. Cross-post rules, the lossy worker fan-out, and in-memory wake retry
are deleted and re-expressed on this one machine.

## Requirements (hard, from review)

- **R1 — Warm latency:** append→processed in single-digit milliseconds on a warmed-up stream.
  Voice rides this. A CI latency probe asserts the envelope.
- **R2 — One-way traffic:** during warm delivery, frames flow stream→subscriber only. Ephemeral
  subscribers generate **zero** return frames (batch results disposed unpulled,
  `stream-connections.ts:402`); durable subscribers generate exactly **one non-gating resolve
  frame per batch**, kept deliberately as the prompt dead-connection signal (`:391-400`). The
  pump never awaits delivery. Wire tests enforce this (they existed —
  `packages/streams/example-app/e2e/vitest/stream-capnweb.test.ts` "delivers event batches
  without subscriber-originated return traffic" — died in the #1525 move; resurrect them).
  Note: capnweb `ReadableStream` is structurally two-way (per-chunk write acks feed a BBR-style
  `FlowController`, `capnweb dist/index.js` ~2885-2965), so the disposed-promise callback is the
  only strictly one-way primitive; it is the honest choice, not a workaround.
- **R3 — Volume envelope:** PCM-through-the-log is the real plan (order 10²–10³ events/sec/stream).
  Consequences honored now: `appendBatch` is the first-class write path, delivery batches are
  byte-capped as well as count-capped, selectors precompile. Log retention/offload: **explicitly
  deferred**, not designed for.
- **R4 — Unit-testable without workerd:** the logic module takes ports only; pure functions for
  the state-machine math; in-memory store + fake clock in vitest. The only file that knows RPC
  exists is the sink-retention quarantine.
- **R5 — Deliver everything:** no platform default filters. The auto worker feed gets every event
  (housekeeping, presence, PCM) "until it becomes a problem"; narrowing is a userspace override.
- **R6 — Presence is product:** subscriber presence facts stay in the log (collaborative
  "who's online" builds on them; the UI presence panel consumes them today via
  `agent-ui-reducer`). Events are cheap; control-flow-via-events was the fragile part, and that
  dies instead.
- **R7 — Super well documented:** the axes table below lands in
  `apps/os/src/domains/streams/README.md`; every module keeps the domain's narrative-docstring
  style; the spine's state machine ships with its transition diagram; the doctrine sentences ship
  in the docs, not just here.

## The three lanes (final; goes in the README)

| Axis            | Ephemeral subscriber                           | Durable subscriber (stateful fold)                                                           | Durable subscriber (stateless effect / push)                             |
| --------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Who             | browser tabs, vitest harnesses, `waitForEvent` | DO-hosted processors (agent, project, repo, scheduler, secret, capability-host)              | project-worker feed, cross-post `ingest`, future webhooks-out            |
| Subscription    | `subscribe()`, session-scoped                  | `subscription-configured`, `delivery.mode: "wake"`                                           | `subscription-configured`, `delivery.mode: "push"`                       |
| Offset owner    | client, in-memory                              | **subscriber** — `{offset, state}` snapshot, atomic with the fold                            | **stream** — spine row, atomic with the log                              |
| Stream-side row | none                                           | yes — _observational_ watermark (poke coalescing, retry, lag); lost row = one redundant poke | yes — _authoritative_ cursor; lost row = bounded redelivery              |
| Warm transport  | retained one-way callback                      | retained one-way sink (from the poke)                                                        | per-batch awaited capability call                                        |
| Return frames   | **zero**                                       | one non-gating resolve per batch (liveness)                                                  | one awaited return per batch (**the ack**)                               |
| Cold start      | client re-subscribes wherever it likes         | spine pokes; subscriber hands back `{checkpointOffset, sink}`                                | spine drains from `acked_offset`                                         |
| Retry/park      | none — client's problem                        | spine: backoff rows, durable alarm, parked fact                                              | same spine, same machine                                                 |
| Filter          | `EventSelector` on subscribe args              | `EventSelector` derived from `contract.consumes` (+ optional condition)                      | `EventSelector` in config                                                |
| Replay          | `replayAfterOffset` arg                        | subscriber's snapshot decides                                                                | `deliver: "all" \| "new" \| {afterOffset}` + `cursor-set`                |
| Why this shape  | it's a session position                        | offset ⊗ fold-state atomicity                                                                | receiver has no storage; log ⊗ cursor atomicity; ack-gated by definition |

**The modality criterion (docs sentence):** _the offset lives with whoever owns the state it must
be transactionally consistent with; the stream-side row is authoritative exactly when the stream
is that owner, observational otherwise._

## Doctrine (docs sentences)

- _Acked offsets are storage, not facts; park and resume are facts, not storage._
- _Selectors filter; receivers transform; platform config never embeds code._ (The scheduler's
  script actions are user intent, authored per schedule; a subscription is platform-migratable
  config. That is the line.)
- _Persist the name, re-derive the authority at dial time._ Expressions are evaluated against a
  freshly built in-process project itx (`itxForScope` + `trustedInternalAuthContext`, the #1710
  precedent); deleting the row is revocation.
- _Control facts must be first-hand._ The core processor refuses to fold any
  `events.iterate.com/stream/*` control event carrying cross-post provenance — copies are stored,
  visible, inert.
- _The awaited call is the ack on the push lane; every other lane is ack-free by design._
- _Events are data, never control flow._ Nothing triggers off presence facts; the spine triggers
  off watermark lag.

## Config: one event (core state v10)

`subscription-configured` is the only config event; `rule-configured`/`rule-removed` and
`rulesById` are deleted (`[main]` included — GitHub webhook cross-post re-expressed below).

```ts
payload: {
  subscriptionKey: string,          // opaque; no `${doName}#${slug}` parsing (host:154-161 dies)
  selector?: EventSelector,         // { eventTypes?: string[], condition?: string /* JSONata, compile-validated pre-commit */ }
  deliver?: "all" | "new" | { afterOffset: number },   // push-mode initial cursor; "new" = this event's own offset
  onPoison?: "park" | "skip",       // push-mode; default "park"
  delivery:
    | { mode: "wake", target: ConfiguredStreamSubscriber }   // today's union unchanged
    | { mode: "push", expression: ItxExpression },           // the EXISTING type, third consumer
}
```

Latest-config-wins per `subscriptionKey` (existing replacement semantics — also the worker-feed
override story, R5). `subscription-removed` deletes the row. New facts:
`subscription-parked {subscriptionKey, atOffset, attempts, error}` (idempotency
`parked:{key}:{atOffset}`), `subscription-resumed {subscriptionKey, deliver?}`,
`subscription-cursor-set {subscriptionKey, ackedOffset}`.

**EventSelector is THE filter type across all three lanes** — `subscribe()` args, wake mode
(derived from `contract.consumes`, which already flows into the filter at
`stream-processor-host.ts:235`), push config. One zod schema, one `applySelector`, one compiled-
JSONata cache (relocated from `[main]`'s rules path), `"*"` semantics defined once. Skip-not-defer
everywhere: cursors advance past non-matching events.

## The durable spine

```sql
-- stream-storage.ts, beside events/event_chunks; transactional with the log
CREATE TABLE IF NOT EXISTS subscriptions (
  subscription_key TEXT PRIMARY KEY,
  acked_offset     INTEGER NOT NULL,  -- push: authoritative cursor. wake: observational watermark
  attempt          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER,           -- epoch ms; alarm target when backing off
  last_error       TEXT,
  updated_at       TEXT NOT NULL
);
```

Rows are projections of config events (created on configure, deleted on remove); config itself is
read from folded core state, never duplicated into rows. Parked status lives in the **fold** (it
is a fact), not the row.

State machine (diagram goes in the README):

```
            deliver/poke ok                    attempt > N (or wall-clock cap)
  active ──────────────────▶ active     retrying ────────────────────────────▶ parked
    │  failure                              ▲ │ backoff: min(30m, 1s·2^attempt) ±20% jitter,
    └───────────▶ retrying ─────────────────┘ │ durable alarm = MIN(next_attempt_at)
                                              ▼
                              parked ── subscription-resumed {deliver?} ──▶ active
```

- **Triggers:** post-commit fan-out (same slot as today's `#connections.wake()`,
  `stream-durable-object.ts:210-237`) + the DO's first-ever `alarm()`. The in-memory-timer
  doctrine (`stream-connections.ts:105-109`) is correct for retained stubs and deliberately
  inverted here: the alarm acts on durable rows, so waking a hibernated DO is exactly the point.
- **Wake mode:** if watermark < maxOffset and no live sink → poke (below). In-memory retry
  (`#wakeRetryTimers`/`#wakeRetryAttempts`, `stream-durable-object.ts:82-91, 728-748`) is deleted;
  the spine's rows retry pokes durably, fixing the documented write-once-stream stall.
- **Push mode:** drain serially per subscription, concurrently across subscriptions: read ≤100
  events / ≤1 MiB after `acked_offset`, apply selector, evaluate expression, one awaited call with
  the frame, ack → advance row. `onPoison: "skip"`: bisect the batch (halve until the poison
  offset is isolated, ≤~7 extra calls), append idempotent `error-occurred`, step over; park only
  on _consecutive_ failures (endpoint down ≠ event poisoned).
- **Coalescing falls out of the cursor:** fifty appends while a poke/batch is in flight produce
  one follow-up, not fifty.

## The warm lane: sink-from-poke

`wakeStreamSubscriber` becomes the whole handshake — **one dial instead of two**, deleting the
subscribe-back race that motivated generation fencing:

```ts
// subscriber side (host); processors are untouched — the host wraps ingest
async wakeStreamSubscriber(request: StreamSubscriberWakeRequest): Promise<{
  checkpointOffset: number,                    // from the processor's own snapshot
  sink: (batch: StreamDeliveryBatch) => void,  // ONE plain async function — no RpcTarget subclass,
                                               // produced by the HOST, never by the processor
  subscriber?: StreamSubscriberDescriptor,     // presence descriptor + processor announcement
  getRuntimeState?: GetProcessorRuntimeState,
}>
```

The stream retains the returned sink (ownership transfers with the return value — no dup dance),
streams one-way batches from `checkpointOffset + 1`, pulls each batch's resolve as the liveness
signal (R2), and on rejection: dispose sink → spine sees watermark lag → poke with backoff. Sink
replacement is unambiguous — the stream initiated the poke and owns both incarnations —so
`supersedeConnection`, generation fencing, and the trusted-internal `subscribe({configured: true})`
RPC entry (`rpc-targets.ts:290-298`) are all deleted. Durable connections stop being externally
openable; only the spine creates them. Idle teardown stays (retained stubs still pin DOs while
warm). Ephemeral `subscribe()` is untouched.

**First commit of the PR (the one unknown):** verify returned function stubs expose
`Symbol.dispose`/`dup`/`onRpcBroken` equivalently to param stubs on Workers RPC + capnweb, so
`retainProcessEventBatch` works unmodified on the poke's return value. Fallback if not: wrap the
sink in a one-method record. (Historical note: a sink-return shape was tried pre-`subscribeOutbound`
and abandoned for type-forking pain; the three fixes here — host-produced plain-function sink,
handshake cargo in the poke return, processors never seeing transport — are the design answer to
that memory. The core processor remains in-process and touches none of this; vitest-hosted
processors keep driving via ephemeral `subscribe()`.)

## The push lane

Delivery frame (also the template/sdk contract — `processEvent(event)` is replaced by
`processEventBatch(frame)`, clean break):

```ts
{ stream: { projectId, path, streamMaxOffset },
  subscriptionKey: string,
  deliveryId: string,     // stable across retries: `${key}:${firstOffset}-${lastOffset}`
  attempt: number,        // 1-based
  events: StreamEvent[],  // ordered, selector-filtered
  configuredEvent: StreamEvent }  // verbatim — receivers self-configure from committed state
```

Expression contract: **must resolve to a callable; the pump invokes it with exactly one argument,
the frame.** String steps walk properties; call steps (args allowed — the existing `ItxExpression`
shape) mount intermediates. Evaluation root: in-process `itxForScope({auth:
trustedInternalAuthContext(), ctx, path: "/", projectId})`. Push subscriptions are **rejected on
`projectId: null` streams** (no project root to derive authority from; same precedent as worker
wake targets, `stream-durable-object.ts:836-838`).

**The two flagship subscriptions:**

- **Worker feed** — **appended by the stream to itself at birth** (project-scoped streams only):
  the constructor's birth certificate becomes `created` (1), `woken` (2),
  `subscription-configured` (3) with `{subscriptionKey: "project-worker", deliver: "all",
onPoison: "skip", delivery: {mode: "push", expression: ["worker", "processEventBatch"]}}` —
  **no selector** (R5). Rationale (decided with Jonas after #1761 reconciliation): zero wiring
  window (a project-processor-appended config would leave a latency gap between birth and feed
  arming — real for voice streams that stream from birth), while remaining pure config — one
  registry, one spine, overridable by re-appending the same key. Preserves #1761's
  "nothing to drift" property because the config is _born_ in the same synchronous turn as
  `created`, not wired by a remote party that can lag. Deletes the lossy fan-out (already deleted
  by #1761) and #1761's derived pump special-case. Worker return = ack; throw = nack. The project
  processor's `child-stream-created` hook keeps appending only the _other_ subscriptions.
- **Cross-post** — `{subscriptionKey: "cross-post:<id>", selector, onPoison: "park", delivery:
{mode: "push", expression: ["streams", ["get", targetPath], "acceptCrossPost"]}}`. New first-party
  `Stream.ingest({from, events})` on the receiving stream carries what `#crossPostMatchingRules`
  does today: `crossPostedFrom` hop chain, cycle guard, `MAX_CROSS_POST_HOPS`, idempotency keys
  `xpost:{fromProject}:{fromPath}:{offset}` (at-least-once delivery collapses to exactly-once
  appends). Same-project scoping holds by reachability. `[main]`'s GitHub webhook cross-post call
  sites repoint to this in the same PR.

## Presence (kept) and authorization

Presence facts (`subscriber-connected/disconnected` + `connectionsByKey` + `processorsBySlug`)
**stay in v10** — they are product data (R6), pushed to every consumer through the log itself.
What dies is their control-flow role: nothing reconciles off them anymore (the spine triggers off
watermark lag), so the "exactly ONE event type is excluded as a re-wake trigger" delicacy
(`stream-durable-object.ts:218-225`) goes. `woken` keeps its honest jobs: mark the incarnation,
clear the roster (connections really do die with the incarnation). Handshake cargo (descriptor,
announcement, runtime-state capability) arrives in the poke return; the stream appends the
connected fact exactly as today. UI reducer: unchanged.

Authorization = three invariants, no new ACLs: (1) **appending to a stream = trusted in the
project** — any principal who can append `subscription-configured` already holds project
authority, so expressions grant nothing new; every `ProjectRpcTarget`-reachable capability is
open to them. Integration ingress can't forge config (integration code fixes event types). (2)
**Control facts must be first-hand** (reducer refuses cross-posted `stream/*` events — closes the
config-propagation-by-copy hole). (3) Pre-commit gates: expression parses, condition compiles,
wake targets same-project as today.

## Module architecture (R4)

```
apps/os/src/domains/streams/
  stream-subscribers.ts     # THE logic module: sink table (ephemeral+durable), durable spine,
                            # one shared drain loop for all three lanes. Ports only:
                            # { store, readEvents, dial, appendFact, coreState, clock, armAlarm }.
                            # Zero cloudflare:workers imports. (Absorbs stream-connections.ts.)
  subscriber-sinks.ts       # the quarantine: stub retention (dup/dispose/onRpcBroken/
                            # pulled-vs-disposed results). The only file that knows RPC exists.
  subscriber-math.ts        # pure, table-testable: computeBackoff, shouldPark, applySelector,
                            # bisectLimit, deliver-policy → initial cursor
  event-selector.ts         # EventSelector schema + compile (shared JSONata cache)
  stream-storage.ts         # + subscriptions table behind a SubscriptionStore interface
                            #   (in-memory twin for vitest)
  core-processor-contract.ts  # v10: config union, parked/resumed/cursor-set facts,
                            #   first-hand-control-facts guard, rules deleted
  stream-processor-host.ts  # slimmed: wakeStreamSubscriber returns {checkpointOffset, sink, ...};
                            #   catchUp stays; generations/supersede/openSubscription deleted
  stream-durable-object.ts  # wiring: ports → sql/setAlarm/itxForScope/DynamicWorkerRunner/exports;
                            #   gains its first alarm()
```

Ports-style (house pattern: `stream-processor.ts` readState/writeState,
`StreamConnectionsHooks`), with the intricate math extracted pure.

**Test pyramid:**

1. **Pure vitest (node, ms):** spine scenarios with in-memory store + fake clock + scripted dial
   results — fail-twice-alarm-park-resume-redeliver; coalescing (50 appends → 1 poke); bisect
   isolates poison offset; cursor-set replay; deliver-policy initialization. Table tests for the
   math. Reducer-arm tests incl. the first-hand guard.
2. **Vitest-hosted processors** via ephemeral `subscribe()` — existing lane, unchanged.
3. **workerd integration:** sink-from-poke handshake over real RPC; returned-stub retention (the
   first-commit spike lives on as this test).
4. **Wire tests (resurrected):** ephemeral = zero subscriber-originated frames; durable = push +
   resolve only; poke handshake frame budget.
5. **Warm-latency probe (R1):** append→processed measured in-process; asserts the single-digit-ms
   envelope so voice regressions fail CI.

## Deletions

`rulesById` + `rule-configured`/`rule-removed` + `#crossPostMatchingRules` + rule validation
(`:857-870`) and `[main]`'s rules-path JSONata plumbing (relocated); the worker fan-out
(`project-processor-implementation.ts:175-183`) + template `processEvent`;
`#wakeRetryTimers`/`#wakeRetryAttempts`/`#scheduleConfiguredWakeRetry` (`:82-91, 728-748`);
`openSubscription`/generation fencing/`supersedeConnection`/host idle-timer half
(`stream-processor-host.ts:169-287`); configured-`subscribe` RPC entry (`rpc-targets.ts:290-298`);
the re-wake-trigger event-type carve-out (`:218-225`); stringly `#`-parsed subscription keys
(`host:154-161`).

## Defaults (tunables — veto in review)

| Knob               | Default                                                               |
| ------------------ | --------------------------------------------------------------------- |
| Backoff            | `min(30min, 1s·2^attempt)` ± 20% jitter                               |
| Park threshold     | 10 consecutive failures (≈24h with backoff)                           |
| Batch caps         | 100 events / 1 MiB per delivery                                       |
| Poke in flight     | 1 per subscription; drains serial per subscription, concurrent across |
| Idle teardown      | unchanged (5 min, in-memory timer — correct for retained stubs)       |
| `deliver` default  | `"new"` (worker feed explicitly sets `"all"`)                         |
| `onPoison` default | `"park"` (worker feed explicitly sets `"skip"`)                       |

## Rollout

**One PR.** First commit = the returned-stub retention spike (the single unknown). Core state
v10 re-reduces from logs; prd/preview erased per house rules; no DO migrations (no new class);
template + sdk break in the same PR; `[main]` GitHub-sync call sites repointed in the same PR.

## Deferred (named, not designed)

Log retention/offload (R3 makes it _eventually_ unavoidable; parked subscriptions must not pin
the log when it lands — PG slot-invalidation semantics); global-stream (`projectId: null`) push
subscriptions; external webhooks-out (a push expression addressing an egress-backed deliverer —
zero new pump machinery when wanted); per-project delivery concurrency governor (the salvaged
dispatcher idea, if the loader-cap herd ever materializes); B's `pull`/`commit` verbs for
stateless recovery-by-poll.

## Reconciliation with PR #1761 / #1756 / #1778 (added after grilling — main moved while we designed)

A parallel session landed **#1761 (MERGED 2026-07-08): "Project worker becomes a stream
subscriber: every stream pumps checkpointed events into processEventBatch"** — the worker-feed
slice of this design, live on main — plus **#1756 (MERGED): `event.path` stamped on every
committed event**, with **#1778 (OPEN): agent birth policy → the worker via
`itx.agents.defaults`** on top. The single PR here **builds on #1761**, generalizing its pump
into the spine rather than adding a second mechanism.

**Adopt verbatim from #1761/#1756 (already on main):**

- The envelope convergence thesis: the worker speaks the _existing_ `StreamEventBatch`
  (`{projectId, path, events, streamMaxOffset, state}`) — "stream processor" is one shape across
  first-party / browser / userspace. This design's push-frame extras become **additive optional
  fields** on that same envelope (`subscriptionKey?`, `deliveryId?`, `attempt?`,
  `configuredEvent?`) — one envelope, all lanes, no fork.
- `IterateProjectWorker` base class in the template sdk (unpacks batches into
  `processEvent(event)`); the template break already happened.
- `event.path` (#1756): `${event.path}@${event.offset}` is the idempotency-key idiom; note the
  cross-post lesson from that PR for `Stream.ingest` — anything re-appending a committed event
  must strip `offset`/`createdAt`/`path` or strict input parsing kills it silently.
- Replay-from-0, per-stream order, at-least-once, 503-worker-building-as-natural-retry semantics;
  `runtime.workerDelivery` observability (grows into per-subscription spine state).

**Upgrade in this PR (the two things #1761 deliberately punted):**

- `project-worker-delivery.ts`'s **in-memory backoff (500ms→30s, 6 attempts, then wait for next
  append)** → the spine: SQLite row, durable alarm, park/resume facts. This is exactly the
  write-once-stream stall class. #1761's note "failures never append events (feedback loop)"
  becomes two invariants here: parked subscriptions don't pump, and park/error facts are
  idempotency-keyed with the cursor already advanced — appended facts can re-wake the pump but
  never re-produce work.
- **KV checkpoint (`project-worker-delivery:checkpoint`)** → a `subscriptions` row, so cursor,
  attempt, and next_attempt_at live in one scannable table (`MIN(next_attempt_at)` alarm, lag
  queries).

**Reconciliation decision (RESOLVED with Jonas):** #1761 made the worker feed **derived**
("nothing to drift"); the design wanted it **configured** (override story, one registry). Neither
won — the stream **appends the config to itself at birth** (offset 3, after `created`/`woken`),
getting derived's zero-latency arming (no wiring window — matters for voice streams that stream
from birth, and removes the project processor as a single point of failure for feed existence)
AND configured's uniformity (a real `subscription-configured` event: one registry, one spine,
same-key override). #1761's derived pump special-case is migrated onto the spine accordingly.

## Decision log (grilling, 2026-07-08)

| #   | Question                                          | Decision                                                                                                                                                                            |
| --- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Pure poke→pull for durable subscribers?           | **No** — R1/R2 (voice, one-way frames) keep the warm streamed lane; spine handles cold path + retries.                                                                              |
| Q2  | Sink returned from the poke?                      | **Yes** — one-dial handshake; fencing dies; spike the returned-stub retention.                                                                                                      |
| Q3  | Per-batch resolve frame on the durable warm lane? | **Keep** — prompt corpse detection; off the latency path. Ephemeral stays zero-return-frame.                                                                                        |
| Q4  | Presence facts?                                   | **Keep in the log** — product data (collab presence, UI panel, contract teaching). Control-flow-via-events dies instead.                                                            |
| Q5  | PCM through the log?                              | **Yes, real plan** — sizes batching/selector knobs; retention deferred.                                                                                                             |
| Q6  | Worker-feed default selector?                     | **Deliver everything** until it becomes a problem; override = same-key reconfigure.                                                                                                 |
| Q7  | Config authorization?                             | Append rights = project trust; ProjectRpcTarget-reachable = open; first-hand control facts; parse/compile gates.                                                                    |
| Q8  | Architecture                                      | Ports-style logic module + sink quarantine + pure math; test pyramid incl. wire tests + latency probe. Super well documented (R7).                                                  |
| Q9  | Staging                                           | **Everything in a single PR.**                                                                                                                                                      |
| Q10 | Worker feed: derived (#1761) vs configured?       | **Birth-certificate config** — the stream appends `subscription-configured` to itself at birth (offset 3): derived's zero wiring window + configured's one-registry/override story. |

Terminology (fixed): **durable subscriber / ephemeral subscriber** (one axis, same verb);
**parked** (EventStoreDB persistent-subscriptions precedent) caused by **poison** or sustained
failure; the **spine** (durable rows + alarm); the **sink** (the retained one-way callback);
**poke** (the wake dial).
