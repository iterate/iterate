# Outbound subscribers — consolidated proposals

Cooked from two independent deep reviews:

- [`outbound-subscribers-review-a.md`](outbound-subscribers-review-a.md) — external prior art
  (Kafka, PG replication slots, NATS JetStream, EventBridge, Stripe/Svix, outbox/Flink, Temporal/
  Inngest/Restate, Cap'n Proto SturdyRefs).
- [`outbound-subscribers-review-b.md`](outbound-subscribers-review-b.md) — inside the codebase
  (delivery-mechanism inventory, scheduler/capability-host internal prior art, deletion map,
  file:line grounding; line refs against `spiritual-hoof` @ bc2b2e5e7, `[main]` = includes #1751).

Three preference-ordered proposals follow. They are deliberately different shapes, not variants:
**P1** keeps the stream as the delivery agent (cursor rows + pump), **P2** deletes the public
surface entirely (userspace router), **P3** deletes push itself (pull-only). P2 and P3 are both
_reachable from_ P1 — that reachability is part of why P1 is first.

---

## 0. Where the two reviews independently converged (treat as settled)

Both reviews, from unrelated starting points, landed on the same nine conclusions:

1. **This is a deletion, not an addition.** The platform has five "event in, call out" mechanisms
   (ephemeral connections; wake→handshake→retained-stub; cross-post rules; scheduler; worker
   fan-out). Two are provably lossy today: cross-post (fire-and-forget `runInBackground`,
   idempotency keys exist but nothing retries — `stream-durable-object.ts:623-666, 885-897`) and
   the worker fan-out (try/catch `console.log`, per-event, root-stream-only —
   `project-processor-implementation.ts:175-183`). The feature should leave the codebase with
   fewer mechanisms than it started with.
2. **The modality criterion is industry-settled, not a house idiosyncrasy.** Offsets live with
   whoever owns the state they must be transactionally consistent with. Stateful fold →
   subscriber-tracked checkpoint (Flink/Kafka-Streams; our wake modality, kept). Stateless
   effect → stream-tracked cursor (Kafka Connect sinks / broker offsets; the new push lane).
3. **Cursor progress is storage; state transitions are facts.** Kafka keeps `__consumer_offsets`
   out of the topic; the scheduler journals every execution and would double stream volume at
   fan-out grain. Doctrine sentence (review B): _acked offsets are storage, not facts; park and
   resume are facts, not storage._
4. **Filters in config yes, transforms in config no.** EventBridge input transformers are the
   industry cautionary tale (AWS itself conceded via Pipes' enrichment-Lambda step). Selector =
   `{ eventTypes?, condition? }` may reject events, never construct. Transforms live in named
   receiver capabilities.
5. **Reuse `ItxExpression` verbatim — do not invent a sibling type.** It already exists with two
   consumers (capability mounts, agent-birth mounts) and already carries arg-bearing call steps.
   Subscriptions become its third consumer. Validation (parse + compile) happens pre-commit at
   configure time. An expression evaluated against a freshly built in-process project itx is a
   SturdyRef restore: persist the _name_, re-derive _authority_ at dial time — which also makes
   same-project safety **validation-by-reachability** (a project itx cannot name another project),
   deleting the bespoke target checks.
6. **In-memory wake retry is indefensible once any durable per-subscriber state exists.** The
   "no durable alarms" rationale (`stream-connections.ts:105-109`) is correct for retained-stub
   teardown and wrong for durable cursors; the stream DO's alarm slot is unused today.
7. **Rules die as a concept.** `rulesById` vs `configuredSubscribersByKey` vs the fan-out are
   three config concepts meaning "on matching events, call something". EventBridge unified rule =
   filter + target + retry + DLQ; we should too.
8. **Parking must be loud and staged** (Stripe warns before disabling; a silent park is data loss
   discovered weeks later), and **replay must be named, not magic** (JetStream `DeliverPolicy`:
   `all | new | { afterOffset }` — `"new"` pins to the config event's own offset, deterministic
   under replay).
9. **Wake→handshake→retained-stub should stop being the default modality.** JetStream deprecated
   push consumers; the generation-fencing/idle-teardown/dup-dispose complex reproduces CapTP's
   documented pain; the DO-duration-leak incident was this modality's bill. Keep it only where
   its one power (push batches into a stateful fold) is used.

---

## P1 (first preference) — Consumer slots: one subscription concept, stream-tracked cursors, persisted calls

_Review A's Proposal 1 ≅ review B's Proposal A — the convergent design, merged, with A's policy
imports (skip/bisect, deliveryId, named deliver policies) and B's verbs (pull/commit) and
naming (keep `subscription-configured` as the one config event)._

**Thesis.** A stream keeps a small SQLite table beside its event log — one row per outbound
subscriber: persisted `ItxExpression` address, selector, acked offset, and a Svix-style endpoint
state machine — pumped post-commit and by a durable alarm, delivering ordered, filtered, acked
batches by evaluating the expression against an in-process `ProjectRpcTarget`
(`itxForScope` + `trustedInternalAuthContext`, the #1710 precedent). Config and transitions are
core events; per-batch progress is row-only. Cross-post rules and the worker fan-out are deleted
and re-expressed as subscriptions. The wake modality survives untouched for stateful DO
processors — but its retries move onto the same durable ledger, killing the in-memory maps.

### Data model

```sql
-- next to events/event_chunks in stream-storage.ts; transactional with the log
CREATE TABLE outbound_subscriptions (
  subscription_key     TEXT PRIMARY KEY,   -- opaque (unshackle from `${doName}#${slug}` parsing)
  acked_offset         INTEGER NOT NULL,   -- exclusive; delivery resumes at +1
  attempt              INTEGER NOT NULL DEFAULT 0,
  next_attempt_at      INTEGER,            -- epoch ms; alarm target when retrying
  last_error           TEXT,
  updated_at           TEXT NOT NULL
);
```

Config (expression, selector, policies) is NOT duplicated into the row — it is read from the
folded `subscription-configured` event in core state; the row holds only what must not be an
event. Wake-mode subscriptions get a row too (cursor ignored) so wake retries share the
alarm/backoff/park machinery.

### Core events (state v10)

`subscription-configured` becomes the one config event:

```ts
payload: {
  subscriptionKey: string,
  selector?: { eventTypes?: string[], condition?: string },  // JSONata, compile-validated pre-commit
  delivery:
    | { mode: "wake", target: ConfiguredStreamSubscriber }    // today's union, unchanged
    | { mode: "push", expression: ItxExpression },            // evaluated against project itx
  deliver?: "all" | "new" | { afterOffset: number },          // initial cursor; "new" = this event's offset
  onPoison?: "park" | "skip",                                 // default park
}
```

Plus: `subscription-removed` (exists; deletes the row = revocation — the stream is the only
holder and dials fresh per delivery, so removal is complete, no stub-hunting);
`subscription-parked { subscriptionKey, atOffset, attempts, error }` (pump-appended, idempotency
`parked:{key}:{atOffset}` — the NATS max-deliveries advisory / Inngest `function.failed` shape);
`subscription-resumed { subscriptionKey, deliver? }` (operator/agent redrive — SQS vocabulary);
`subscription-cursor-set { subscriptionKey, ackedOffset }` (audited seek).
Deleted events: `rule-configured`, `rule-removed`. Deleted state: `rulesById`.

### Pump

A `StreamDeliveries` module (~250–350 lines), deliberate sibling of `StreamConnections` — inbound
= live connections, outbound = durable slots; the old design doc's direction symmetry, and its
"different types of subscriptions — including those where the server keeps track of the offset"
future-work line (orig design doc line 543) finally built.

On post-commit fan-out and on alarm, for each non-parked row with lag and `next_attempt_at <=
now`, drained serially per subscription (one in-flight batch per slot — Svix's per-endpoint
independence), concurrently across slots:

1. `readEvents({ afterOffset: acked_offset, limit: 100 })`, bounded by bytes as well as count.
2. Apply selector, skip-not-defer (cursor advances past non-matches — identical to the inbound
   filter; the `[main]` compiled-JSONata cache moves out of the rules path and is shared).
3. Evaluate the expression against `itxForScope({ auth: trustedInternalAuthContext(), ctx,
path: "/", projectId })` and call with the fixed frame:

```ts
{ stream: { projectId, path, streamMaxOffset },
  subscriptionKey,
  deliveryId,        // stable across retries: `${subscriptionKey}:${firstOffset}-${lastOffset}` (svix-id)
  attempt,           // 1-based
  events,            // ordered, filtered
  configuredEvent }  // verbatim — old design doc's self-configuration rule
```

4. Awaited resolve = ack: `acked_offset = lastOffset, attempt = 0` (synchronous same-DO SQLite;
   a crash between remote success and the update ⇒ redelivery ⇒ honest at-least-once — receivers
   dedupe on offsets/deliveryId). Reject = nack: `attempt++`, `next_attempt_at = now +
min(30m, 1s·2^attempt) ± 20% jitter`, `setAlarm(min next_attempt_at over all rows)`.

The awaited RPC result IS the ack. The old doc's "processEventBatch must not be used for
acknowledgement" doctrine stays true on the live lane and is deliberately inverted here — state
the asymmetry in the module docstring.

### Retry / park / poison

`active → retrying` on failure; after ~N=10 consecutive failures (≈24h of backoff), park + the
idempotent park event + loud surfacing (stream UI row: status, lag = `maxOffset − acked_offset`
— Kafka's one metric; `runtimeState()` grows the ledger).

`onPoison: "skip"` (imported from review A's ledger proposal): bisect the failing batch (halve
until the poison event is isolated, ≤7 extra attempts on a 100-batch), record an idempotent
`error-occurred` for the skipped offset, advance past it; park only when _consecutive_ events
die (endpoint down ≠ event poisoned — the Svix disable heuristic). Defaults: **skip** for the
worker feed (one bad event must not silence a project's whole feed), **park** for cross-post
(skips = silent gaps in the target stream).

### The two flagship subscriptions

**Worker feed.** The project processor appends on project-create (to `/`) and in its existing
`child-stream-created` hook (`project-processor-implementation.ts:265-323` — no new trigger
mechanism) to every new stream, idempotency-keyed:

```ts
{ subscriptionKey: "project-worker",
  delivery: { mode: "push", expression: ["worker", "processEventBatch"] },
  deliver: "all", onPoison: "skip",
  selector: { condition: "<exclude events.iterate.com/stream/* housekeeping>" } }  // overridable — decision D3
```

Template `worker.ts` + `sdk.ts` replace `processEvent` with `processEventBatch(frame)` (clean
break). Return = ack; throw = nack. Delete `project-processor-implementation.ts:175-183`.

**Cross-post.** `{ subscriptionKey: "cross-post:<id>", delivery: { mode: "push", expression:
["streams", ["get", targetPath], "ingest"] }, selector: { eventTypes, condition } }`. New
first-party `Stream.ingest({ from, events })` (trusted lane) on the _receiving_ stream does what
`#crossPostMatchingRules` does today: stamps `source.crossPostedFrom` hops, enforces the cycle
guard + max hops, mints `xpost:{fromProject}:{fromPath}:{offset}` idempotency keys, appends.
Sender-side rule machinery deleted; same-project scoping by reachability.

**Pull verbs (cheap import from P3).** `Stream.pull({ subscriptionKey, limit })` and
`Stream.commit({ subscriptionKey, offset })` on the same table (~50 lines). Gives stateless
consumers a recovery path when parked, Stripe's belt-and-braces reconciliation-by-poll, and a
debugging tool ("what would this subscriber see next?") — and leaves the P3 door open.

### Deletions

- `project-processor-implementation.ts:175-183` (lossy fan-out) + template `processEvent`.
- `#crossPostMatchingRules`, `rulesById`, `rule-configured`/`rule-removed`, rule target
  validation (`stream-durable-object.ts:857-870`), `[main]`'s rules-path JSONata plumbing
  (relocated to the shared selector helper).
- `#wakeRetryTimers` / `#wakeRetryAttempts` / `#scheduleConfiguredWakeRetry`
  (`stream-durable-object.ts:82-91, 728-748`) — wake retries ride the durable ledger, fixing the
  documented write-once-stream stall.

### What falls out for free

Per-subscriber lag as a queryable number + UI column; pause/resume/seek per subscriber; ordered
replay from the log (EventBridge's bolt-on replay is unordered — we get ordering free); durable
observable cross-post (the dropped-forward incident class dies); an at-least-once worker feed
that makes userspace event-driven apps buildable (reliable projections in the repo); external
webhooks later = a subscription whose expression addresses an egress-backed deliverer — the old
doc's never-built `external-url` spec with zero new pump machinery; "call capability X when
events matching Y land" as an agent-usable primitive (EventBridge-rule-as-a-verb).

### Risks (named, with mitigations)

- **Head-of-line blocking** on park-mode slots — inherent to cursors; mitigated by skip/bisect.
- **Thundering herd** into the dynamic-worker loader cap after an outage ends (many streams'
  alarms → same project worker): jitter now; a per-project delivery-concurrency governor is the
  named follow-up (the one salvaged idea from the rejected dispatcher shape).
- **Feedback loops**: worker appends back to the stream feeding it — structural codemode
  self-loop. Circuit breaker (v9 token bucket) is the backstop; deliveries must keep draining on
  paused streams (reads are legal; park events pass the pause door like `error-occurred`).
- **Rows are the first non-log-derivable durable state in the stream DO** (like PG slots and
  `__consumer_offsets`). Lost row ⇒ re-init from config ⇒ redelivery storm; at-least-once absorbs
  it — say so in the contract.
- **Future retention wedge** (when truncation/R2 offload lands): parked slots must never pin the
  log — copy PG slot invalidation (parked-beyond-horizon ⇒ resume forces an explicit `deliver`
  choice).
- **Two modes survive** (wake + push). Justified by the modality criterion, but it's two modes to
  document; the criterion is the documentation.

**Cost: M.** One table + one module + 4 event types + shared selector helper + `Stream.ingest` +
project-processor/template/sdk edits + tests. Deletes more concept-count than it adds. prd/
preview reset per house rules; no migration code; core state v10; no DO migrations (no new class).

---

## P2 (second preference) — One pipe to userspace: the worker is the only public subscriber

_Review B's Proposal C. Same engine as P1 under the hood; radically smaller product surface._

**Thesis.** The platform exposes NO general outbound configuration. Every project stream has
exactly one implicit outbound edge — P1's pump with the subscriber hardcoded to
`["worker", "processEventBatch"]`, durable, at-least-once, per-stream cursor, park/resume facts.
ALL routing, filtering, cross-posting, fan-out, and webhooks-out are userspace code in the
project repo's `worker.ts` — typed against `sdk.ts`, reviewed in PRs, versioned with the
project, editable by agents via `itx.workspace`. Platform-critical flows never ride it: DO
processors keep wake-mode as internal infrastructure, and GitHub→repo sync is re-expressed as
the repo DO wake-subscribing to the connection stream directly (consume where the events live,
no copies) — arguably cleaner than today's rule-driven copy.

**What exists in config:** nothing public. No selector DSL, no JSONata, no expressions in
userland — `worker.ts` is the selector, the condition, and the router. One operator verb:
`itx.streams.get(path).resetWorkerFeed({ afterOffset })`. The template ships a small routing
switch (rhyming with its existing `APPS` table) so the cross-post-in-code pattern is
discoverable; `crossPostedFrom` stamping becomes an sdk helper convention.

**Deletes** everything P1 deletes PLUS: rules _without replacement_ (no `Stream.ingest` needed —
userspace appends are appends), JSONata from the streams domain entirely, the public subscription
surface from docs, and `worker` as a public member of `ConfiguredStreamSubscriber`.

**Why it's tempting (the honest case for it):** it is the strongest possible
conventions-over-frameworks answer — there is no config language to document because there is no
config; arbitrary transforms/joins/debounce (things no selector will ever express) are trivially
available; the platform's outbound contract is ONE frame shape; every stream is programmable the
day it's born, and "ask the agent to edit the router" is literally the product thesis.

**Why it's second, not first:**

- It puts user code on the delivery path for anything platform-adjacent: a worker build break
  parks feeds project-wide until fixed — needs first-class surfacing, and first-party features
  can never assume the feed works.
- Multi-consumer patterns (two external systems with independent cursors, independent
  park/replay) must be hand-rolled in userspace or foreclosed.
- No no-code story for "just mirror these events" — acceptable only if the agent-edits-code bet
  is fully committed.
- Crucially: **P2 is reachable from P1 as a policy** (ship P1's engine; expose only the worker
  feed; don't document the general surface). The reverse — discovering you need general
  subscriptions after building only the hardcoded pipe — is a schema-and-surface retrofit. Build
  the general engine, decide the surface exposure separately.

**Cost: M** (P1's pump minus expressions, plus repo-sync re-plumb + park-surfacing UI). The risk
is product, not engineering.

---

## P3 (third preference) — Pokes and pulls: the pull-only collapse

_Review B's Proposal B, with review A's strongest industry datapoint behind it (JetStream
deprecated push consumers; Kafka's pull argument; Stripe recommends poll-reconciliation because
push is lossy in practice)._

**Thesis.** Outbound _delivery_ dies as a platform concept. The stream emits exactly one thing: a
**poke** — tiny, durable, at-least-once, alarm-retried — to a persisted call:
`{ stream: { projectId, path, streamMaxOffset }, subscriptionKey }`. Every machine consumer
pulls: DO processors keep their own checkpoints and their `wakeStreamSubscriber` body becomes the
already-existing `catchUp` (`stream-processor-host.ts:365-386`); stateless consumers pull and
`commit` back to broker-stored cursors, Kafka-style. Ephemeral live connections survive only for
humans (browser tails, `waitForEvent`). One transport for machines, one for people.

**What it deletes** — the big prize: `openSubscription`, generation fencing, `ingestChain`
gating, `supersedeConnection`, idle teardown on the host side (~half of
`stream-processor-host.ts`); retained-stub dup/dispose defense, `onConfiguredConnectionLost`,
configured idle teardown from `stream-connections.ts` (shrinks to the browser pump); the
presence-fact churn and the "woken clears the roster" trick for machine consumers; the
DO-duration-leak class becomes **structurally extinct** — nothing retains stubs across turns,
both DOs hibernate between batches. Largest net-negative diff of the three.

**Cross-post without copies:** the consumer subscribes at the source (repo DO pulls the GitHub
connection stream). Where a literal copy is wanted, the _target_ pulls:
`poke → ["streams", ["get", target], "pullFrom"]`, a first-party verb that pulls from its own
broker cursor at the source and appends stamped copies — cursor-correct cross-post, zero new
concepts. Worker feed: poke `["worker", "pokeStream"]`; the handler pulls, processes, commits.

**Why it's third, not first:** widest blast radius (every host DO changes, even if mostly by
deletion); ingest-ordering guarantees the generation machinery bought must be re-proven for
concurrent catchUps; poke→pull→commit is 3 RPC legs vs push's 1 on chatty agent streams; and the
coalescing watermark (re-poke only when `maxOffset` passes the last poked watermark) must be
right or busy streams poke every subscriber per append. **It is the direction, not the build**:
P1 ships `pull`/`commit` on the same table, so P3 becomes an incremental host-by-host retirement
of the wake handshake — undertaken when (a) the DO-duration economics bite again, or (b) the
handshake complex causes its next incident. No big-bang required, ever.

**Cost: L** as a project; ~free as a _direction_ if P1 carries the verbs.

---

## Rejected shapes (and what was salvaged from each)

- **Per-project dispatcher DO** (review A's P2, Kafka-Connect topology): central cursors, global
  concurrency governor, one dashboard — but it re-creates the DO-pinning incident shape (a
  dispatcher wired to every active stream), is a per-project SPOF, adds cursor-on-cursor lag, and
  builds the reliability feature atop the least reliable existing mechanism (the wake lane with
  the known mid-turn stall). **Salvaged:** the per-project delivery-concurrency governor as P1's
  named follow-up for the loader-cap herd.
- **Per-event delivery ledger** (review A's P3, Svix-in-a-DO): native per-event forensics and
  skip — but O(events × subscribers) write amplification on the append hot path and a
  load-bearing GC obligation. Kafka's whole cursor design exists to avoid this. **Salvaged:**
  `onPoison: "skip"` with bisect as a policy on cursors; the ledger shape stays in the back
  pocket for true third-party webhooks (per-delivery signing, per-event resend buttons).
- **Subscriptions-as-streams / outbox-of-the-outbox** (both reviews): a DO hop and a second
  journal per edge to reify state that fits in one row beside the log; the event log already IS
  the outbox. Its one virtue (delivery history as events) is served by park/resume facts.
- **JS script strings in subscription config.** Sharpened by review B: the scheduler already
  crossed this Rubicon (`{kind:"itx-script", script}` run with project-root authority), so the
  argument is not "we don't do script strings" — we do. The line that survives: a scheduler
  script is _user intent, authored per schedule_; a subscription is _platform-appended config_
  the platform must be able to migrate forever. Platform config never embeds code. When users
  want code on the event path, it goes in `worker.ts` (P1's feed / P2's whole thesis).
- **Construction DSLs / arg templates** (EventBridge input-transformer lesson): selectors filter,
  receivers transform. Never construct in config.

---

## Decisions to make (P1 assumed)

1. **D1 — Surface exposure:** ship P1's general `subscription-configured` surface documented, or
   P2-as-policy (engine general, only the worker feed exposed)? Recommendation: expose general —
   cross-post config already needs it, and agents are first-class consumers of "call X when Y".
2. **D2 — Frame & template break:** `processEventBatch(frame)` replacing `processEvent(event)` in
   template + sdk. Recommendation: yes, batch-first (matches inbound; catch-up amortization).
3. **D3 — Worker-feed default selector:** exclude `events.iterate.com/stream/*` housekeeping
   (woken/connected/disconnected/subscription chatter) by default, overridable? Recommendation:
   exclude — it's selection downstream of capture, not capture filtering; presence noise in
   userspace is pure confusion. (Counter-position: deliver absolutely everything; simpler to
   explain.)
4. **D4 — `onPoison` defaults:** skip for worker feed, park for cross-post (as proposed)?
5. **D5 — Pull verbs in v1:** include `pull`/`commit` (~50 lines, P3 door-opener + parked-state
   recovery) or defer? Recommendation: include.
6. **D6 — Park thresholds:** N=10 consecutive failures / ~24h backoff ceiling / 30m max interval
   ± jitter; per-subscription overrides deferred until a real need.
7. **D7 — Wake-retry unification:** move wake-mode retries onto the ledger+alarm in the same PR
   (deletes the in-memory maps and fixes the write-once-stream stall) or as a fast-follow?
   Recommendation: same PR — it's the proof the ledger is the one retry machine.

## Doctrine (write down wherever this lands)

- _Acked offsets are storage, not facts; park and resume are facts, not storage._
- _Offsets live with whoever owns the state they must be transactionally consistent with._
- _Selectors filter; receivers transform; platform config never embeds code._
- _Persist the name, re-derive the authority at dial time_ (expressions are SturdyRefs; removal
  of the row is revocation).
- _The awaited call is the ack on the durable lane; the live lane stays ack-free._
