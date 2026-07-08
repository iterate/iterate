# Outbound subscribers — design review A (external prior art)

Reviewer lens: what the rest of the industry learned building exactly this thing — a durable,
at-least-once, per-subscriber-cursor delivery lane out of an event log — and three genuinely
different ways to build it here. Sibling review covers the inside-the-codebase view; this one
cross-references code only where a decision hangs on it.

Code ground truth used throughout (all paths relative to `apps/os/src` unless noted):
`domains/streams/stream-durable-object.ts` (append fan-out ~210–237, cross-post ~623–666,
in-memory wake retry ~728–748, DO-namespace wake ~797–806, dynamic-worker wake ~808–827),
`domains/streams/core-processor-contract.ts` (v9; main adds JSONata `condition` + `rule-removed`),
`domains/streams/stream-connections.ts` (live pump, idle teardown rationale ~105–110),
`domains/streams/stream-processor.ts` + `stream-processor-host.ts` (checkpoint `{offset,state}`,
`MAX_CONSECUTIVE_INGEST_FAILURES = 3`, generation fencing),
`domains/projects/project-processor-implementation.ts:175–183` (the lossy worker fan-out this
feature replaces), `itx/path-proxy.ts`, `domains/capability-host/itx-expression.ts`,
`apps/os/project-repo-template/worker.ts:100` + `sdk.ts` `ProjectWorker.processEvent` (the
userspace receiving surface).

---

## 1. Prior art, on our axes

### 1.1 Kafka consumer groups — broker-stored cursors, consumer-driven commit, pull

- **Cursor ownership/storage:** the broker _stores_ committed offsets (in the internal compacted
  `__consumer_offsets` topic) but never advances them — the _consumer_ commits. Storage and
  authority are split, and this split is the design's core insight.
- **Crucially, commit chatter is kept OUT of the data log.** Offsets live in a separate store
  precisely so per-consumer progress doesn't pollute the topic. Direct lesson for us: per-batch
  cursor advances must be **rows, not core events**; only config/state _transitions_ deserve events.
- **Push vs pull:** strictly pull (long-poll fetch). Kafka's own design doc argues pull wins
  because the consumer controls rate, batching falls out naturally when behind, and the broker
  needs no per-consumer delivery state machine or retry timers.
- **Filter:** none at the broker. Selectivity is downstream — literally the house philosophy
  ("event volume is fine; select downstream of capture") twenty years early.
- **Poison/retry:** none broker-side. Ecosystem answer is consumer-side DLQs (Kafka Connect
  `errors.tolerance=all` + dead-letter topic = "skip poison, record it, keep going").
- **Lag is THE metric:** `log-end-offset − committed-offset`, monitored everywhere (Burrow etc.).
  Any stream-owned cursor design must surface lag per subscriber as a first-class number.
- **Membership is the hard part:** a decade of rebalance-storm pain (fixed only by KIP-429
  incremental cooperative rebalancing) is evidence that _tracking live connected consumers_ is the
  most failure-prone part of a broker. Kafka keeps membership out of the log. (Relevant to our
  presence facts — §2.3.)

### 1.2 Postgres logical replication slots — the retention wedge and slot invalidation

- Server-side named cursor per subscriber (`confirmed_flush_lsn`), advanced only by consumer ack —
  the closest ancestor of the proposed `outbound_subscriptions` row.
- **The canonical failure mode:** an abandoned slot pins WAL forever → disk fills → the _database_
  goes down. A server-tracked cursor without a lifecycle is a loaded gun pointed at the server.
  PG13's fix is instructive: `max_slot_wal_keep_size` bounds what a slot may pin, and a slot that
  exceeds it is **invalidated** (`wal_status='lost'`) — i.e. the server _parks the subscriber and
  revokes its replay guarantee_ rather than dying. Later versions added inactivity-based
  invalidation too.
- Lessons: (a) `parked` must be a real state with a real consequence, not just a paused retry
  loop; (b) parked cursors must never pin resources unboundedly — when stream truncation/R2
  offload arrives, a parked subscription's replay window must be allowed to lapse, with resume
  forcing an explicit replay choice; (c) visibility is table stakes (`pg_replication_slots` is a
  monitored view; ours should be `runtimeState()` + a UI column).

### 1.3 NATS JetStream — the push→pull consumer evolution, and why pull won

- Durable consumers store server-side progress richer than one offset (ack floor + pending set).
- JetStream shipped **both** push consumers (server pushes; flow-control frames, idle heartbeats,
  max-ack-pending all interacting) and pull consumers. Over 2021–2023 the ecosystem converged on
  pull; the new client APIs (`consume()`/`fetch()`) are pull-based and the legacy push API is
  deprecated. Why pull won: push flow control was three fiddly mechanisms deep; pull scales
  horizontally for free (work-queue semantics); server-side push loops had their own failure
  modes (slow-consumer detection, interest-loss drops). This is the strongest industry datapoint
  **against** building more machinery on the wake→handshake→retained-live-stub modality.
- **Replay vocabulary worth stealing:** `DeliverPolicy = all | new | by_start_sequence |
by_start_time | last | last_per_subject`, plus `ReplayPolicy = instant | original` (paced!).
  Much better than our current magic values (omitted = live-tail, 0 = full replay).
- **Poison:** `max_deliver` exhaustion emits an advisory event (`$JS.EVENT.ADVISORY.CONSUMER.
MAX_DELIVERIES`) — poison-as-event, exactly the proposed idempotent park event.
- **Cursor lifecycle:** `InactiveThreshold` garbage-collects abandoned consumers. Cursors need
  death, not just birth.

### 1.4 AWS EventBridge — rules as outbound subscriptions; input transformers as the cautionary tale

- A rule = **declarative pattern filter** (exact/prefix/numeric/anything-but/exists over JSON) +
  target ARN + per-target **retry policy** (defaults: 24h max age, 185 attempts) + per-target
  **DLQ**. This is the industry's closest "rule = selector + address + retry + dead-letter" shape,
  and it validates folding our cross-post rules and outbound subscriptions into one concept.
- **Filters-in-config are loved; transforms-in-config are hated.** Input transformers (JSONPath
  extraction + template splice) are notorious: JSON-in-JSON quoting hell, no functions, failures
  surface only at delivery time. AWS itself conceded the point by adding an _enrichment Lambda
  step_ to EventBridge Pipes — transforms belong in code at a named receiver. This is external
  confirmation of the already-articulated "expression = ADDRESS ONLY, never transform" doctrine.
- EventBridge is a router, not a log: no cursor, per-event delivery with per-event retry state.
  Replay was bolted on later (archive + replay) and re-delivers **without ordering** and with a
  replay-name stamp consumers must dedupe on — a warning about what replay looks like when you
  don't have a log. We have a log; we get ordered replay for free. Don't give that up.

### 1.5 Stripe & Svix — the per-endpoint delivery state machine, auto-disable, and dashboards

- **Stripe:** events retained 30 days; webhook retries with exponential backoff up to ~3 days;
  endpoints that fail for days get **warning emails, then auto-disabled** — parking must be loud
  and staged, never silent. Signed deliveries (HMAC + timestamp). Crucially Stripe _also_ exposes
  `/v1/events` for polling and officially recommends reconciliation by pull because push is lossy
  in practice — belt (push) and braces (pull) from the same log.
- **Svix** (webhooks-as-a-service) is our `outbound_subscriptions` row productized:
  per-endpoint attempt schedule (now, 5s, 5m, 30m, 2h, 5h, 10h, 10h), endpoint **disabled after
  ~5 days** of consistent failure, dashboard-driven "recover since date" bulk replay, per-endpoint
  rate limiting, and — the detail worth stealing — a **stable delivery id (`svix-id`) across
  retries** so receivers can dedupe at-least-once redeliveries.
- Svix's repeatedly-blogged core lesson: **per-endpoint independence.** One slow/dead endpoint
  must never block delivery to the others; retries are queued per endpoint, never inline in the
  fan-out. (Our current cross-post `runInBackground` violates this in spirit: one cold-start RPC
  exception loses the forward forever — the "Slack router dropped forward" incident class.)
- Both chose **per-event jobs, no cursor**, because third-party endpoints can't be trusted to do
  ordered cursor consumption and per-event visibility is the product. The cost: no ordering
  guarantee, O(events×endpoints) state. With first-party receivers we can have the cursor's
  ordering + O(1) state — but we inherit its failure mode: **head-of-line blocking** (one poison
  batch wedges the whole subscriber). Every design below must pick a side per subscriber, or
  offer both (`onPoison: park | skip`).

### 1.6 Outbox, Debezium, Flink/Connect — checkpoint ownership settles the modality question

- The transactional outbox pattern: event + state committed in one transaction; a relay pumps the
  outbox to the transport, tracking its cursor transactionally **with the outbox**, not with the
  target. Our stream DO already _is_ the outbox; the new subscription rows next to the event log
  are the textbook relay cursor. (DO SQLite makes "transactional with the log" free: all writes
  in one await-free turn commit atomically under the output gate.)
- **Where do checkpoints live in mature systems? Wherever the state they must be consistent with
  lives.** Kafka Connect _sink_ connectors (stateless effect) use broker-stored consumer-group
  offsets; Flink and Kafka Streams (stateful folds) checkpoint offsets _inside the operator/job
  state_, because committing the offset separately from the fold state is exactly how you get
  silent double-folds or gaps. Industry practice therefore **independently confirms the stated
  modality criterion**: stateful fold → subscriber-tracked (today's wake modality, keep);
  stateless effect → stream-tracked push (the new lane). This is not a house idiosyncrasy; it's
  the settled answer.

### 1.7 Durable execution & event routers — Temporal, Inngest, Restate, Knative, SQS

- **Temporal signals:** durable point-deliveries into named durable entities, retried by the
  platform against an idempotent receiver. Precedent that "notify a durable object, let it act
  from its own state" is a sound modality — our wake lane, kept for stateful subscribers.
- **Inngest / Trigger.dev:** event→function bindings with platform retries (Inngest default 4),
  then the run is marked failed **and a `inngest/function.failed` event is emitted** — poison
  becomes an event on the bus (our idempotent `error-occurred`/park event), and dashboard
  **Replay** re-drives a time range in bulk. The operator surface we should copy: park loudly,
  redrive cheaply.
- **Restate:** the closest architectural cousin — a log-first runtime pushing into handlers with
  **per-key ordered queues** and platform-owned progress. Validates "ordered per-subscription
  cursor push into a durable handler" as a modern, deliberate choice, not a legacy one.
- **Knative Triggers / CloudEvents Subscriptions API:** subscription = filter (+ named "filter
  dialects": exact/prefix/suffix/SQL) + sink URI + delivery spec (retries, backoff,
  `deadLetterSink`). The spec-shaped confirmation that `{selector, target, retryPolicy}` is the
  complete, sufficient record. (We should _not_ import the dialect registry — one fixed selector
  shape, per house style — but it's useful confirmation that `eventTypes` + one condition
  language covers the space.)
- **SQS redrive:** `maxReceiveCount` → DLQ, then **redrive back to source** as the un-park verb.
  Good vocabulary: _redrive_ = resume + replay window in one operator action.

### 1.8 Capability systems — persisting a reference to a live thing

- **Cap'n Proto SturdyRefs / CapTP:** a persisted capability is _data naming an object_, restored
  to a live ref through an explicit restore step **where authority is re-checked**. An itx
  expression evaluated against a freshly-constructed `ProjectRpcTarget` (the PR #1710 in-process
  loopback precedent) is precisely a SturdyRef restore: persist the _name_, re-derive the
  _authority_ at dial time. This is the correct pattern, and it means expression evaluation is
  also the **security boundary**: a source stream's evaluation root can only reach same-project
  capabilities, so the cross-project invariant currently enforced by handwritten checks
  (`#validateStreamRuleTarget`, `#validateConfiguredSubscriberTarget`) becomes
  **validation-by-reachability** — unexpressible rather than checked.
- Revocation in cap systems is done by interposition (revocable membranes), not by hunting down
  copies — for us: removing the subscription row _is_ revocation, because the stream is the only
  holder and dials fresh per delivery. No dangling live stubs to chase — an argument for
  dial-per-delivery over retained stubs.
- **E-lang/Waterken web-keys:** persisted _bearer_ authority leaks (logs, referers). Expressions
  are names-not-bearers — keep it that way; never let an expression carry a token or secret arg.
- CapTP's reconnect dance (offer, withdraw, re-handshake, session fencing) is the direct ancestor
  of `stream-processor-host.ts`'s generation fencing — and its documented pain is why industrial
  systems moved to pull or queued push. The complexity there is inherent to the modality, not to
  the implementation.

### 1.9 Synthesis: the two industry shapes

Everything above collapses into two proven shapes for "log → durable outbound delivery":

|            | **Cursor per subscriber** (Kafka, JetStream, PG slots, Restate) | **Ledger of per-event jobs** (Stripe, Svix, EventBridge, Inngest) |
| ---------- | --------------------------------------------------------------- | ----------------------------------------------------------------- |
| State      | O(1) row per subscriber                                         | O(events × subscribers) rows                                      |
| Ordering   | guaranteed per subscriber                                       | best-effort / per-job                                             |
| Poison     | head-of-line blocks → park or skip-with-bisect                  | skip one job, park only the endpoint                              |
| Visibility | lag number                                                      | per-event attempt history                                         |
| Fit        | first-party, ordered, idempotent receivers                      | third-party endpoints, per-event forensics                        |

We control both ends (receivers are first-party capabilities), we have a log, and receivers can
dedupe on offsets — the cursor shape is the natural fit, with the ledger's per-event skip
available as a _policy_, and the ledger shape kept in the back pocket for true external webhooks.

---

## 2. Past decisions worth unshackling from (prior-art vantage)

1. **Wake→handshake→retained-live-stub as the only durable delivery modality.** JetStream
   deprecated exactly this (push consumers); CapTP's session fencing pain is reproduced almost
   line-for-line in `stream-processor-host.ts` (generations, supersede races, dual idle timers on
   both ends) and in the DO-duration incident (cross-script RPC sessions pinning DOs for hours —
   `incident_do_duration_worker_split_subscriptions`). Keep it _only_ where the modality criterion
   demands it (stateful folds), and stop letting its constraints (nothing durable may schedule a
   wake, because a woken DO finds no stubs) leak into lanes that don't retain stubs at all.
2. **In-memory retry state** (`#wakeRetryTimers`/`#wakeRetryAttempts`, 6 attempts, dies with the
   incarnation; the code comment itself concedes write-once streams can stall —
   `tasks/stream-subscriber-deliveries-stall-mid-turn.md`). No system in §1 keeps retry state in
   RAM. The "no durable alarms" rule was derived from retained-stub teardown (correct there,
   `stream-connections.ts:105–110`) and then over-generalized: an alarm that wakes the DO to
   _dial fresh and push_ is exactly what alarms are for.
3. **Presence facts and membership in the core state/log** (`connectionsByKey`, woken-clears-
   roster, connected/disconnected chatter, contract announcements riding connect events). Kafka
   spent a decade learning to keep membership out of the log; Svix models delivery _outcomes_,
   never "connectedness". The roster is genuinely useful as runtime observability — but it's
   `runtimeState()` material. At minimum: do not extend presence facts to the outbound lane
   (rows carry status), and expect the worker feed to want them filtered out (housekeeping noise).
4. **Cross-post rules as a third config concept** (`rulesById` ≠ `configuredSubscribersByKey` ≠
   live connections), delivered inline at append via fire-and-forget `runInBackground` with
   sender-side provenance/idempotency stamping. EventBridge unified rule = filter + target +
   retry + DLQ; Svix says retries must be queued per endpoint, never inline. Fold rules into
   outbound subscriptions; move the stamping into a first-party receiver.
5. **The root-only, lossy worker fan-out** (`project-processor-implementation.ts:175–183`,
   try/catch console.log) — the acknowledged tech debt this feature replaces.
6. **Magic replay values** (`replayAfterOffset` omitted = live-tail, 0 = full) → name them, per
   JetStream `DeliverPolicy` (`all | new | { afterOffset }`), at least on the new config surface.
7. **The "no ack" doctrine** (old design doc: `processEventBatch()` return "must not be used for
   acknowledgement"). Right for live fan-out; wrong to inherit into durable outbound. Every
   at-least-once system in §1 is built on acks; for stream-tracked cursors the awaited RPC
   result IS the ack. State the asymmetry deliberately instead of carrying the doctrine over.

---

## 3. Proposal 1 — Consumer slots: per-stream cursor rows + alarm-driven push pump

### ("JetStream durable consumers inside the Stream DO")

**Thesis.** Each stream keeps a small SQLite table of _outbound slots_ next to its event log —
one row per subscriber: itx-expression address, selector, acked offset, and a Svix-style
endpoint state machine — pumped post-commit and by a durable alarm, delivering ordered,
selector-filtered, acked batches by dialing the expression fresh each time against an in-process
`ProjectRpcTarget`. Config and state _transitions_ are core events (auditable); per-batch cursor
progress is row-only (Kafka's `__consumer_offsets` separation). Cross-post rules and the
every-stream worker feed both become slots; the wake modality survives untouched for stateful
processors, now justified by the Flink/Connect checkpoint-ownership rule rather than by default.

**Data model** (in the stream DO's SQLite, transactional with `events` by the await-free-turn
invariant):

```sql
CREATE TABLE outbound_subscriptions (
  subscription_key     TEXT PRIMARY KEY,
  target_expression    TEXT NOT NULL,   -- JSON ItxExpression; ADDRESS ONLY
  selector             TEXT,            -- JSON { eventTypes?: string[], condition?: string }
  on_poison            TEXT NOT NULL DEFAULT 'park',  -- 'park' | 'skip'
  acked_offset         INTEGER NOT NULL,
  status               TEXT NOT NULL,   -- 'active' | 'retrying' | 'parked'
  attempt              INTEGER NOT NULL DEFAULT 0,
  next_attempt_at      INTEGER,         -- ms epoch; NULL unless retrying
  last_error           TEXT,
  configured_at_offset INTEGER NOT NULL,
  updated_at           TEXT NOT NULL
);
```

**Core events** (control surface, folded into rows by the core processor in the same commit
turn; the row is the projection, the events are the audit):

- `stream/outbound-configured` `{subscriptionKey, target: ItxExpression, selector?, deliver?:
"all" | "new" | { afterOffset }, onPoison?}` — `"new"` initializes `acked_offset` to the config
  event's **own offset**: deterministic under replay, no clock.
- `stream/outbound-removed` `{subscriptionKey}` — deletes the row (= revocation, §1.8).
- `stream/outbound-parked` `{subscriptionKey, atOffset, attempts, error}` — appended by the pump,
  idempotency key `outbound-parked:{key}:{atOffset}` (NATS max-deliveries advisory / Inngest
  `function.failed`).
- `stream/outbound-resumed` `{subscriptionKey, deliver?: { afterOffset }}` — operator redrive
  (SQS): resets attempts, optionally moves the cursor.
- `stream/outbound-cursor-set` `{subscriptionKey, ackedOffset}` — explicit seek, audited.

Per-batch acks do **not** append events (§1.1 — commit chatter stays out of the log).

**Pump.** A `StreamDeliveries` module, deliberate sibling of `StreamConnections` (inbound = live
connections; outbound = durable slots — the direction symmetry the old design doc named). On
post-commit fan-out and on alarm: for each row with `status != 'parked'`, `acked_offset <
maxOffset`, `next_attempt_at <= now`, and no in-flight batch (in-memory set; eviction-safe
because redelivery is idempotent): read ≤100 events (bounded by bytes too — events can be
multi-MB) after `acked_offset`, apply the selector (skip-not-defer, cursor advances past
non-matches, identical to the inbound filter), evaluate the expression against an in-process
`ProjectRpcTarget` with trusted-internal auth (PR #1710 precedent), call with the fixed frame:

```ts
{ stream: { projectId, path, streamMaxOffset },
  subscriptionKey,
  deliveryId,   // stable across retries: `${subscriptionKey}:${firstOffset}-${lastOffset}` (svix-id)
  attempt,      // 1-based
  events }      // ordered, filtered
```

Await the result: resolve = ack (row: `acked_offset = lastOffset`, `attempt = 0`,
`status='active'`), reject = nack. Slots pump concurrently, one in-flight batch per slot
(max-ack-pending = 1; per-endpoint independence, §1.5). `ctx.storage.setAlarm(min
next_attempt_at)`; the alarm handler scans due rows. One DO alarm multiplexes all slots.

**Retry/park state machine.** `active → retrying` on first failure; backoff tuned for
first-party targets (1s, 5s, 30s, 2m, 10m, 30m, then hourly; ±20% jitter against herds), capped
at ~24h of attempts → `parked` + the idempotent park event. `onPoison: 'skip'` instead bisects
the failing batch (halve until the poison event is isolated — Kafka Connect
`errors.tolerance=all`), records an idempotent `error-occurred` for the skipped offset, advances
past it, and only parks when _consecutive_ events die (endpoint down, not event poisoned).
Default for the worker feed: `skip` (one bad event must not silence a project's entire feed);
default for cross-post: `park` (skipping = silent gaps in the target stream). Parking is loud:
event + `runtimeState()` + a lag/status column in the stream UI (Stripe warns before disabling;
a silent park is a data-loss bug discovered weeks later).

**Replay controls.** `deliver` at configure time (`all` / `new` / `{afterOffset}`, per JetStream
DeliverPolicy); `outbound-cursor-set` to seek; `outbound-resumed {deliver}` as redrive. Ordered
replay falls out of the log (unlike EventBridge's unordered bolt-on replay).

**Cross-post.** `outbound-configured {subscriptionKey: "cross-post:<ruleId>", target: ["streams",
["get", targetPath], "ingestCrossPost"], selector: {eventTypes, condition}}`. `ingestCrossPost
(delivery)` is a small first-party verb on the Stream capability that stamps `source.crossPost`
provenance, derives idempotency keys `cross-post:{key}:{srcProject}:{srcPath}:{offset}`, drops
already-stamped events (loop guard), and appends — the transform lives in named receiver code
(the EventBridge Pipes lesson), and the same-project invariant holds by reachability (§1.8).
Retries, parking, and lag come free — the class of silently-dropped forwards dies.

**Worker feed.** The project processor's `child-stream-created` hook (where birth certificates
already come from) appends idempotently to every new stream:
`outbound-configured {subscriptionKey: "worker", target: ["worker", "processEvent"], deliver:
"all", onPoison: "skip", selector: {condition: <exclude events.iterate.com/stream/* housekeeping>}}`
— exclusion is _selection downstream of capture_, so it doesn't violate the capture doctrine, and
it keeps woken/connected/disconnected chatter out of userspace; overridable. The template
`worker.ts` `processEvent` and `sdk.ts` `ProjectWorker.processEvent` change to the batch frame
(clean break, per house rules). The worker returning normally acks; throwing nacks the batch.

**Deleted:** `project-processor-implementation.ts:175–183`; `#crossPostMatchingRules` +
`rulesById` + `rule-configured`/`rule-removed` (core state v10); `#wakeRetryTimers` /
`#wakeRetryAttempts` / `#scheduleConfiguredWakeRetry` (~stream-durable-object.ts:80–91, 728–748)
— configured-subscriber wake retries move onto the same durable alarm scheduler (fixes the
write-once-stream stall the comment admits).

**Bookkeeping symmetry note.** The slot row is exactly a `StreamProcessorSnapshot` —
`{offset: acked_offset, state: {status, attempt, ...}}` — checkpoint-before-advance and the
poison counter rhyme with `stream-processor.ts`/`-host.ts`. Recommend _rhyme, don't reuse_:
hosting N `StreamProcessor` instances inside the stream DO to get this would be spec-machinery;
a ~250-line `StreamDeliveries` with the same snapshot shape is the house style (N rhyming
imperative implementations over generic machinery).

**Falls out for free:** per-slot lag (Kafka's metric: `maxOffset − acked_offset`) queryable and
UI-renderable; pause/resume/seek per subscriber; external webhooks later = a slot whose target is
an egress-fetch capability, zero pump changes; "call capability X when event matching Y lands" =
EventBridge-rule-as-a-primitive for agents/scheduler; cross-post becomes observable and durable;
an at-least-once worker feed makes userspace event-driven apps actually buildable (reliable
projections in the project repo).

**Cons / risks / failure modes (honest):**

- **Head-of-line blocking** on `park` slots — inherent to cursors (§1.9); mitigated by `skip` +
  bisect, but bisect on a 100-event batch is up to ~7 extra delivery attempts.
- **Thundering herd:** a deploy or outage ending fires many streams' alarms into the _same_
  project worker → CF dynamic-worker loader isolate cap ("Too many concurrent dynamic workers",
  `itx_dynamic_worker_loader_cap`). Jitter helps; a per-project delivery-concurrency governor may
  eventually be needed (Proposal 2 has it structurally; here it's a follow-up).
- **Feedback loops:** worker `processEvent` appending back to the same stream = self-amplifying
  (the codemode self-loop incident, but structural). The circuit breaker (token bucket → paused)
  is the backstop; deliveries must keep draining on paused streams (reads are legal; park events
  pass the pause door as `error-occurred` does).
- **Rows are the first non-log-derivable durable state in the stream DO** (progress can't be
  rebuilt from events — same is true of PG slots and `__consumer_offsets`). A lost row re-inits
  from config events = re-delivery storm; at-least-once absorbs it, but say so in the contract.
- **Future retention wedge:** when truncation/R2 offload lands, parked slots must _not_ pin the
  log — copy PG's slot invalidation (parked-beyond-horizon ⇒ resume forces an explicit
  `deliver` choice).
- Per-stream pump = per-stream wake cost: an append to a quiet stream now also runs delivery
  bookkeeping (one row scan; cheap, but on the hot path).

**Build cost:** ~medium. One table + one module (~250 lines) + 5 core events + selector
extraction shared with rules/inbound + template/sdk break + tests. Deletes more concept-count
than it adds.

---

## 4. Proposal 2 — The project dispatcher: outbound delivery as ONE stateful subscriber

### ("Kafka Connect worker / Debezium server for the project")

**Thesis.** Streams stay exactly as they are — pure logs with live connections and the wake
modality; **zero new code in the Stream DO**. All outbound push for a project is owned by one
`DeliveryProcessor` (a normal `StreamProcessor`) hosted on the Project DO (or a dedicated
per-project Delivery DO): every stream gets a configured subscription to it at birth (the
existing `subscription-configured` machinery — the dispatcher is just another wakeable
subscriber), it folds `outbound-configured` events from each stream into its own state, and its
delivery cursors live in _its_ checkpoint — satisfying the modality criterion the other way
round, because the dispatcher IS a stateful fold whose state is the cursor table (the Flink
answer: offsets live with the operator state). This is Kafka Connect's topology: brokers stay
dumb; a worker runtime owns connectors, offsets, retries, and DLQs centrally.

**Data model & events.** Config events identical to Proposal 1 and still appended to the
_source_ stream (auditability stays per-stream). Dispatcher state (its DO's SQLite/KV,
transactional with its checkpoints): `delivery_cursors(stream_path, subscription_key,
target_expression, selector, acked_offset, status, attempt, next_attempt_at, last_error)`. Its
per-stream ingest checkpoints are the existing `{offset,state}` snapshots.

**Pump/delivery.** Streams wake the dispatcher exactly as they wake any configured subscriber
today; delivered batches land in `ingest`; `processEventBatch` upserts cursor rows (on
`outbound-configured`) and enqueues delivery work; a durable alarm on the dispatcher DO drives
retries. Delivery = evaluate expression against in-process `ProjectRpcTarget`, same frame, ack →
advance the cursor row. Because the dispatcher sees every stream, it can enforce a **global
delivery concurrency cap per project** (the loader-cap herd from Proposal 1 is solved
structurally) and offers one place to see _all_ of a project's outbound delivery.

**Retry/park, replay, cross-post, worker feed:** same state machine and events as Proposal 1,
but park/resume events are appended back to the _source_ stream by the dispatcher (audit stays
local to the data). Worker feed = the project processor auto-appends the same
`outbound-configured` to each new stream; the dispatcher picks it up on its next batch.
Cross-post = same `ingestCrossPost` receiver.

**Deleted:** the same fan-out block and rules machinery as Proposal 1. Nothing added to the
Stream DO at all — honoring the original design doc's "Make `Stream` itself very small".

**Falls out for free:** project-wide delivery dashboard (one DO to query); global backpressure /
rate-limiting per project; cross-stream delivery policies (e.g. "at most N concurrent calls into
the worker, project-wide"); streams stay hibernation-friendly with no new duties.

**Cons / risks / failure modes (honest):**

- **It rebuilds the exact pathology of the DO-duration incident**: the dispatcher holds a
  configured live connection to _every active stream in the project_ — cross-script RPC sessions
  pinning many DOs (that incident measured 100–1000× duration cost). Idle teardown bounds it,
  but a busy project keeps the dispatcher permanently wired to every busy stream.
- **SPOF and serialization point:** dispatcher wedged/parked/poisoned = ALL outbound delivery for
  the project stops (Kafka Connect worker-cluster outages take every connector down — a known
  operational sore point). Its own per-stream checkpoints add a second cursor layer _underneath_
  the delivery cursors (cursor-on-cursor: the thing Kafka Connect is regularly criticized for).
- **Extra hop, extra latency** on every delivery (stream → dispatcher → target vs stream →
  target), and double handling of every event byte.
- Delivery for stream X is only as fresh as the dispatcher's ingest of X — lag becomes
  two-dimensional (ingest lag + delivery lag), harder to explain in a UI.
- The at-least-once wake lane it rides on is the one with the known mid-turn stall
  (`stream-subscriber-deliveries-stall-mid-turn.md`) — building the reliability feature _on top
  of_ the least reliable existing mechanism is architecturally uncomfortable.

**Build cost:** ~medium. No stream DO changes, but a new processor + contract + cursor table +
alarm loop + auto-subscription wiring + the same template/sdk break. Less deleted complexity
than Proposal 1 (rules could fold in, but the stream still needs nothing removed to make room).

---

## 5. Proposal 3 — Delivery ledger: per-event jobs with per-event state

### ("Svix in a DO")

**Thesis.** Adopt the webhook-platform shape wholesale: at append, each committed event matching
a subscription's selector inserts a **delivery job row**; a pump drains each subscription's
queue in offset order (or with skip-ahead policy); every job carries its own attempt count,
next-attempt time, and terminal state. There is no cursor — progress is the set of terminal
rows. This buys Stripe/Svix-grade per-event forensics ("show me exactly which event failed
delivery to the worker, when, with what error, and resend it") and per-event poison isolation at
the cost of write amplification and a GC obligation.

**Data model.**

```sql
CREATE TABLE outbound_subscriptions (   -- config only; no cursor
  subscription_key TEXT PRIMARY KEY, target_expression TEXT NOT NULL,
  selector TEXT, status TEXT NOT NULL DEFAULT 'active'   -- 'active' | 'parked'
);
CREATE TABLE deliveries (
  subscription_key TEXT NOT NULL, offset INTEGER NOT NULL,
  status TEXT NOT NULL,           -- 'pending' | 'delivered' | 'dead'
  attempt INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER, last_error TEXT,
  PRIMARY KEY (subscription_key, offset)
);
```

Core events: `outbound-configured/removed` as before; `delivery-dead {subscriptionKey, offset,
error}` (idempotent, per event — SQS `maxReceiveCount`); subscription-level `outbound-parked`
only when K consecutive jobs die (Svix endpoint-disable heuristic: distinguish _event poisoned_
from _endpoint down_); `outbound-redriven {subscriptionKey, fromOffset, toOffset}` flips
dead/delivered rows back to pending (SQS redrive; Svix "recover since date").

**Pump.** Post-commit: insert matching job rows (same turn, atomic with the log), then per
subscription deliver the lowest pending job (batchable: contiguous pending run → one frame; the
frame and ack semantics are identical to Proposal 1). Failure updates only that job's row;
per-subscription ordering is preserved by only dispatching offset N+1 after N is terminal —
or relaxed per subscription (`ordered: false`) for Svix-style throughput.

**Cross-post / worker feed:** same expressions and receivers; the worker feed inserts one job
per event per stream.

**Deleted:** same as Proposal 1 (fan-out block, rules machinery, in-memory wake retry).

**Falls out for free:** the endpoint-dashboard experience (attempt history per event, resend
button per event); per-event skip with zero bisect machinery; true external webhooks with
per-delivery signing later need _no_ new bookkeeping; delivery analytics (success rate,
latency percentiles) are one SQL query.

**Cons / risks / failure modes (honest):**

- **Write amplification on the append hot path:** ≥1 job row per event per subscriber — with the
  every-stream worker feed that's a guaranteed ~2× row write per append before any other
  subscriber, inside DOs that also hold the event bytes (and a 1.5MB-class row-size world).
  Kafka's and JetStream's whole cursor design exists to avoid exactly this.
- **GC is now load-bearing:** delivered rows must be pruned (retention job per stream DO) or the
  ledger outgrows the log it serves. Svix runs a large multi-tenant DB + queue infra to make
  this shape work; per-DO it's all on us.
- Replay is row surgery (flip/insert ranges) rather than moving one integer — more states, more
  invariants, more tests.
- The "which of the two tables is authoritative for progress" question invites drift bugs;
  cursors don't have it.
- Overkill for first-party ordered receivers, which is 100% of the launch surface.

**Build cost:** ~high. Two tables, insert-on-append, GC, redrive verbs, ordered/unordered
policies, plus everything Proposal 1 needs anyway.

---

## 6. Comparison and recommendation

|                          | P1 slots+pump                               | P2 dispatcher                             | P3 ledger                   |
| ------------------------ | ------------------------------------------- | ----------------------------------------- | --------------------------- |
| Stream DO change         | +1 table, +1 module                         | none                                      | +2 tables, hot-path inserts |
| State per subscriber     | O(1)                                        | O(1)×2 layers                             | O(events)                   |
| Ordering                 | per-slot guaranteed                         | per-slot, dispatcher-lagged               | configurable                |
| Poison                   | park or skip(bisect)                        | same, +SPOF risk                          | per-event native            |
| Herd control             | jitter (follow-up)                          | structural                                | jitter                      |
| Per-event forensics      | error events only                           | error events only                         | native                      |
| Symmetry w/ inbound      | high (snapshot-shaped row, shared selector) | highest reuse, lowest symmetry of concept | low                         |
| Deletes existing code    | most                                        | least                                     | most                        |
| Prior-art anchor         | JetStream/PG-slot/outbox                    | Kafka Connect/Flink                       | Svix/Stripe/EventBridge     |
| Known-incident resonance | fixes wake-retry stall, dropped forwards    | re-creates DO-pinning incident shape      | fixes both, at write cost   |
| Cost                     | medium                                      | medium                                    | high                        |

**Recommendation: Proposal 1**, with two imports: Proposal 3's per-event skip as the
`onPoison: 'skip'` policy (default for the worker feed), and Proposal 2's project-level delivery
concurrency governor held as the named follow-up if the loader-cap herd materializes in
practice. P1 is the only option that simultaneously (a) satisfies the modality criterion the way
Flink/Connect settled it, (b) keeps commit chatter out of the log the way Kafka settled it,
(c) gives the pump a durable alarm the way every §1 system does, (d) collapses three config
concepts (subscriptions, rules, worker fan-out) into one auditable record the way EventBridge
did, and (e) deletes more machinery than it adds. Its two real dangers — retention wedges and
silent parking — have named, proven mitigations (PG slot invalidation semantics; Stripe/Svix
staged-loud disable), and both should be in the v1 contract, not deferred.
