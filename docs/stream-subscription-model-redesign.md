# Stream subscriptions, connections, and readers — model redesign

Status: **design** (2026-08-03, not yet scheduled). Companion to
[stream processors as facets](../tasks/stream-processors-as-facets.md) —
that task decides _where processors run_; this doc decides _how anything
attaches to a stream and how it is identified_. The two are halves of one
rebuild. Evidence base: a full consumer census of this repo, three
independently produced designs reconciled against it, and the platform
verification recorded in the facets task (facet API, metering, isolation).

## Why

Today a stream serves consumers through two mechanisms — stored
subscriptions (four receiver actions) and live session connections — plus
an unacknowledged third family of pull readers. The model has five
diseases, each observable in source:

1. **The cursor column is polymorphic.** `subscription_cursors.
acknowledged_offset` means "authoritative cursor" for copy/itx-call/
   webhook rows and "non-authoritative resume hint" for processor rows —
   the docstring says so outright (`apps/os/src/domains/streams/
stream-storage.ts:257-267`), the discriminator (receiver kind) lives in
   a different store (reduced core state), and `recordReportedCheckpoint`
   (`stream-storage.ts:347`) exists solely to paper over the split.
2. **Identity is fragmented and placement leaks into it.** The default
   hosted-processor key is `${durableObjectName}#${processorSlug}`
   (`apps/os/src/domains/streams/utils.ts:31-54`) — a physical address
   baked into a durable name. Progress is keyed by slug
   (`packages/iterate/src/processors/durable-object-processor-durability.ts:31`),
   which makes two instances of one contract on one stream physically
   collide. Meanwhile connection keys already share a collision-rejected
   namespace with subscription keys (`stream-durable-object.ts:1446-1449`)
   — the unification is half-real and unstated.
3. **Absence is indistinguishable from failure.** A subscription whose
   receiver is legitimately gone (a live capability whose providing
   session closed — `capability "…" is offline`,
   `capability-host-processor-implementation.ts:476`) burns the 15-attempt
   ladder (~2–2.5 h, `stream-event-sender.ts:117`) and then halts
   permanently. There is no parked state.
4. **No receiver can own its cursor unless it speaks the wake protocol.**
   `delivery` policy is documented as existing "only when the source owns
   an awaited delivery cursor" (`core-processor-contract.ts:112-117`), and
   the webhook adapter _discards the response body_
   (`stream-durable-object.ts:328-334`) — a remote cannot ack an offset
   even if it wants to. Notably `webhook-post` has **zero production
   configs**; it was re-added in core-state v28 explicitly as the future
   lane for remotely-hosted processors (`core-processor-contract.ts:52-55`),
   so it can be redesigned for free.
5. **Pull is load-bearing but has no public model.** The runner catches
   itself up by paging its own stream (`stream-processor-runner.ts:
1050-1080`), folds rebuild by replay, the agent re-reads its whole log
   for prompts, and a dozen surfaces call `getEvents`/`getEventPage` ad
   hoc — while the remote-apps vessel consumes streams through an
   `as unknown as` cast onto a method that does not exist on the typed
   surface (`apps/tasks/src/rpc-api.ts:497-503`).

## The model

A stream has **subscriptions**, **connections**, and **readers**. Nothing
else. All three words already name these things in the code
(`subscriptions.outbound.byKey`, `StreamConnections` / `openConnection`,
`getEventPage` readers).

**Invariant: has a cursor row ⇔ named ⇔ the stream owes it delivery
across evictions.** Sessions and ad-hoc readers sit outside the durable
model by design, not by accident.

**Kinds are data, never schema.** The receiver discriminated union
(`SubscriptionReceiver`, `core-processor-contract.ts:125-176`) stays the
visible extension point. Adding a receiver kind = one union member + one
send adapter; zero tables change.

### Subscription

The durable delivery intent. Born, reconfigured, rewound, and killed by
appended events (all four event types exist today:
`subscription-configured`, `subscription-cursor-set`,
`subscription-delivery-resumed`, `subscription-delivery-halted`). A
processor is simply a subscription whose receiver runs a contract.

### Connection

The live channel currently serving someone. Two ways to get one, both
exactly as today:

- **caller-opened** — `openConnection`: browser tabs, TUIs, the mobile
  app, `waitForEvent` riders, the remote-app vessel. Offset supplied by
  the caller; no row; dies with the RPC session. Per-connection delivery
  controls (`maxDeliveryEvents` / `maxDeliveryBytes` / `state: false`,
  PR #2384, open) are connection-scoped — properties of a channel, not of
  an intent — as are `openedBy`, the ping side-channel, and close
  reasons.
- **stream-opened** — the wake feed serving a `processor-wake`
  subscription, fenced by `connectionGeneration`. Under facet placement
  this is a parent→facet dial (in-process, verified ~free); under remote
  placement it is whatever transport
  [the delivery-transport task](../tasks/redesign-high-volume-stream-delivery-transport.md)
  ships. Transports are connection implementations; nothing above the
  connection changes when one is swapped.

Connections are never identity and never durable.

### Reader

Pull, promoted to first-class. The public surface is the existing
`getEvents` / `getEventPage` (whose envelope — `{events, streamId,
streamMaxOffset}` — is already exactly what a remote puller needs). A
reader may optionally **register**: a name plus a declared checkpoint,
with no delivery obligation — so lag is visible and future
ephemeral-event eviction can know the slowest cursor. The browser mirror
is the canonical registered reader: it stays deliberately _not_ a
subscription (self-tracked checkpoints in client SQLite over a session
connection it opened), but registering makes its position visible.

### Barriers are verbs, not consumers

`waitForEvent` (log predicate, one-shot, unchanged) and one unified
`waitUntilConfirmed(name, {offset})` that works against **any**
subscription — see the cursor rule below. Today's `waitUntilProcessed`
becomes the processor-wake case of that one verb.

## Identity: names bind, epochs fence

**A name is a reusable binding chosen by a caller; an epoch fences which
occupant of the name a record belongs to.** A name alone is an address; a
name plus its current epoch is a full identity. Every late-ack guard,
rewind protection, and replace-vs-resume decision in the system is an
epoch comparison — never a name comparison. The codebase already does
this uniformly; the redesign just says it out loud:

| Binding (name)    | Epoch (which occupant)                                            |
| ----------------- | ----------------------------------------------------------------- |
| stream path       | `streamId` (storage lifetime), `incarnationId` (wake)             |
| subscription name | `configuredAtOffset` (birth), `cursorChangedAtOffset` (seek)      |
| connection key    | `connectionGeneration` (wake attempt)                             |
| facet name        | incarnation (workerd keeps name→id stable across delete/recreate) |
| processor slug    | contract `version` / `reducerVersion`                             |

Rules:

- **One name, four systems.** A subscription's name is _the same string_
  as: the catalog key at the stream, the itx address segment, the facet
  name under facet placement, and the progress-key component under own-DO
  placement. No translation conventions anywhere.
- **Names are opaque.** The platform never parses structure out of a name
  (the `${durableObjectName}#${slug}` convention was exactly that disease
  and dies). One reserved prefix survives: auto-generated names are
  `subscription:<offset>` (birth-offset-derived, stable, doctrine-pure).
- **Caller-chosen, per-stream unique, 1–500 chars, trimmed** — the
  existing `SubscriptionKey` constraints (`core-processor-contract.ts:
203-208`), applied to a better string.
- **Slug is an attribute, not identity.** `processorSlug` becomes
  _required_ on `processor-wake` and says which contract runs. Name
  defaults to slug — the single-instance case reads as today
  (`subscriptions.get("agent")`) — and two instances of one contract are
  two birth events with two names and one slug.
- **The field is renamed `subscriptionKey` → `name`** (event payload,
  state map, cursor table, wake request) under a `CORE_STATE_VERSION`
  bump. "Name" aligns with `ctx.facets.get(name, …)` and `getByName`;
  "key" stays reserved for storage internals, idempotency keys, and API
  keys, which it already means.

## The cursor row: two offsets, one rule

Keep `subscription_cursors`, one row per subscription. Replace the
polymorphic offset with two columns whose meanings never vary by kind:

```sql
create table subscription_cursors (
  name                                    text primary key,
  configured_at_offset                    integer not null,  -- birth epoch
  cursor_changed_at_offset                integer not null,  -- seek epoch
  delivered_offset                        integer not null,  -- source completed transfer through here
  confirmed_offset                        integer not null,  -- far side durably claims through here
  state                                   text not null default 'active',
                                          -- 'active' | 'parked' | 'halted'
  -- retry block, verbatim from today (already kind-independent):
  attempt                                 integer not null default 0,
  next_attempt_at                         integer,
  failing_event_offset                    integer,
  failing_event_attempt                   integer not null default 0,
  failing_event_skips_since_last_success  integer not null default 0,
  last_error                              text,
  -- in-flight block, verbatim from today:
  in_flight_deadline_at                   integer,
  in_flight_connection_generation         integer,
  updated_at                              text not null
);
-- invariant: confirmed_offset <= delivered_offset
```

**The one scheduling rule, for every kind: delivery resumes after
`confirmed_offset`.** `delivered_offset` bounds the outstanding window
and feeds telemetry; it is never authority.

Separate writers, no ambiguity: the send loop writes `delivered`; the
receiver's completion/report path writes `confirmed`; both are fenced by
`cursor_changed_at_offset` + `in_flight_connection_generation`, exactly
like today's late-ack protection.

Per-kind semantics:

| Receiver                                        | writes `delivered`       | writes `confirmed`                            | net behavior                                                                                                                                                              |
| ----------------------------------------------- | ------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| copy-to-stream                                  | receiving append commits | same ack (both at once)                       | identical to today                                                                                                                                                        |
| itx-call                                        | awaited call resolves    | same ack (both at once)                       | identical to today                                                                                                                                                        |
| webhook-post (plain)                            | HTTP 2xx                 | same ack (both at once)                       | identical to today                                                                                                                                                        |
| webhook-post (offset-acking)                    | HTTP 2xx                 | `confirmedOffset` in the 2xx response body    | remote owns its position; eviction ⇒ redelivery of the delivered-but-unconfirmed window — the at-least-once contract a remote-tracked webhook wants                       |
| processor-wake                                  | wake/batch ack           | reported checkpoint                           | today's semantics ("a stale row costs one redundant wake"), in a dedicated column; `recordReportedCheckpoint` stops being a carve-out — it is a confirm without a deliver |
| pull (registered reader / future SSE/long-poll) | page end returned        | the fetch itself declares `confirmed = after` | position-vs-committed, in existing vocabulary                                                                                                                             |

Lag becomes well-defined for every kind — `head − confirmed`, with
`delivered − confirmed` as the outstanding window — which directly feeds
[surface-durable-consumer-lag-in-stream-ui](../tasks/surface-durable-consumer-lag-in-stream-ui.md).

## Subscription states: active, parked, halted

`active` and `halted` are today's states (halt = the terminal outcome of
the retry ladder; `subscription-delivery-resumed` already un-halts).
**`parked` is new: the receiver is legitimately absent, and that is not a
failure.** Parked means the cursor row stays put, no retry alarm is
armed, and nothing is charged against the failure ladder. A receiver kind
that can signal presence parks instead of failing:

- a live capability on the itx tree — the capability host knows
  provide/revoke; the durable record already outlives the session-lived
  target (precedent: `__describe` answers from durable metadata while the
  live target is gone, `capability-host-processor-implementation.ts:461-470`);
- a remote app — connect/disconnect on its inbound session.

`halted` stays reserved for genuine failure (receiver present and
erroring). Open question below: whether the park/resume poke is an event
(fits doctrine) or an RPC to the source.

## Receiver kinds

Existing arms, adjusted:

- **`processor-wake`** — `processorSlug` required; gains a placement
  field: `facet` (no expression needed — the subscription name _is_ the
  facet name, delivery is a parent→facet dial) or an itx expression as
  today (own-DO, userspace worker). `jsonataTransform` stays forbidden
  (replay determinism, `core-processor-contract.ts:126-131`). The
  announced `consumes` still composes with the configured filter.
- **`copy-to-stream`** — unchanged, including `jsonataTransform` on the
  receiving side, inbound fences keyed `(sourcePath, name)`, cycle
  suppression, and `onFailingEvent` forced to `halt` (ordered receivers
  must never skip).
- **`itx-call`** — unchanged mechanics (expression evaluated per delivery
  against a fresh delivery-authority root); now the arm that also serves
  live provided capabilities, with `parked` handling absence. This arm —
  through a `remoteCapability` mount ([remote apps](./remote-apps.md)) —
  is also the first answer for "call RPC stub methods on a remote capnweb
  server": the remote dials in, mounts, and receives batches; if it
  implements the wake protocol it gets resumable checkpointed feeds,
  exactly as userspace SDK processors already do.
- **`webhook-post`** — the adapter stops discarding the response body; an
  optional `confirmedOffset` in the 2xx body splits confirmed from
  delivered (see table). No new config knob.

**Per-subscription delivery controls (in scope).** No subscription has
any size/shape control today — webhook page size is pinned to 1 event
(`stream-event-sender.ts:706-717`), batch limits are global constants —
while sessions gained `maxDeliveryEvents` / `maxDeliveryBytes` /
`state: false` per connection (PR #2384). These become ordinary optional
config in the subscription's birth event, honored by every push arm: a
webhook-hosted remote processor can ask for real batches, a constrained
device consumer can cap bytes.

Deferred members (add when a real consumer demands them, as data):

- **`capnweb-call`** — the stream dials _out_ to a remote capnweb
  endpoint. Every capnweb session in the repo today dials inward, and the
  only outward lane (`webhook-post`) deliberately rides
  `projectEgressFetcher` so egress rules and approval holds apply — an
  outward capnweb arm must do the same.
- A cursorless best-effort **notify** ping ("events exist past N") for
  pull-first remotes, if registered-reader pull plus the transport task's
  SSE/long-poll candidates prove insufficient.

## The itx surface

Existing nouns only; sugar follows the documented shortcut precedent
(`project.revokeCapability` → capability host, `rpc-targets.ts:6281`).

```
project.streams.get(path)                  // exists (ProjectStreamCollectionRpcTarget)
  .subscriptions.list()                    // catalog ⋈ cursor rows: name, kind, slug?,
                                           //   state, lag (head − confirmed), lastError
  .subscriptions.get(name)
     .describe()                           // config + delivered/confirmed + retry state
     .waitUntilConfirmed({offset})         // uniform barrier, every kind
     .setCursor({afterOffset})             // existing cursor-set event
     .processor                            // present iff processor-wake:
        .snapshot() .getRuntimeState()     //   dialed by placement (facet | DO | expression)
        .liveState                         //   REQUIRED on every instance — see "Live state"
  .getEvents({after}) / .getEventPage(...) // reader surface (existing)
  .waitForEvent(...)                       // log-predicate barrier (existing)
  .openConnection(...)                     // sessions (existing, + #2384 controls)

agent.processor                            // stays, as sugar for
                                           // streams.get(agentPath).subscriptions.get("agent").processor
```

## Live state

LiveState is deliberately **not** a subscription — it has no offsets, no
cursor, no replay, no durability; it is a projection push channel
(snapshot + structural patches, revision-numbered, resubscribe on gap).
Classifying it as an event consumer would be wrong. **Requiring it is
non-negotiable: every processor instance exposes `liveState`, and so does
the stream itself.** The UI's entire reactivity story rides on it.

The engine follows the instance's placement:

- **Own-DO placement** — exactly today: the registry builds one engine
  per host and reassembles on every committed state change
  (`runner.observeStateChanges(() => assembleLive())`,
  `stream-processor-registry.ts:443-455`, engine at
  `packages/iterate/src/sdk/capnweb/live-state/engine.ts`).
- **Facet placement** — the engine lives in the facet, observing its own
  runner. Subscriber callbacks are ordinary capabilities flowing _into_
  the facet through the parent hop (facet stubs can never leave the
  parent, but subscriber stubs can enter — per-hop proxying, verified
  in-process and effectively free). Every patch push transits the Stream
  DO; live subscribers therefore pin the facet and, through the
  resident-ancestor-chain rule, the Stream DO — the same pinning class as
  session connections today, and the same wake-socket/hibernation work
  applies.
- **Userspace workers / browser mirror** — unchanged: userspace hosts
  can run the same engine behind their own doors; browser-mirror
  instances serve their local UI from client SQLite and need no server
  engine.

One structural consequence: today one engine per host DO _composes_ all
of that DO's runners into a single `Live` object. Per-instance placement
dissolves that composition — subscribers attach per instance
(`subscriptions.get(name).processor.liveState`, with `agent.liveState`
remaining as the documented sugar), and cross-instance composition
happens at the stream's own `liveState`, which already carries the
per-subscription runtime rows (state, lag, last error) that the
consumer-lag UI task needs.

## Coverage: every census kind, mapped

| Kind (census)                                                                  | Lands as                                                                                                                                             |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| processor on own DO (agent, project, repo, …)                                  | subscription, `processor-wake` + expression; confirmed = reported checkpoint                                                                         |
| processor as stream facet (planned)                                            | subscription, `processor-wake` + `facet` placement; name = facet name; in-process dial                                                               |
| userspace worker processor (`createProcessorHost`, sdk)                        | subscription, `processor-wake` + expression — unchanged protocol                                                                                     |
| two instances, one contract                                                    | two subscriptions, two names, one slug; own-DO progress re-keyed by name                                                                             |
| copy-to-stream (repo links, agent-collection, catalogs)                        | subscription, `copy-to-stream` — unchanged                                                                                                           |
| project-worker feed, PostHog feed                                              | subscriptions, `itx-call` — already the target naming style (`project-worker`, `iterate-platform-posthog`)                                           |
| live provided capability on the itx tree                                       | subscription, `itx-call` + `parked`                                                                                                                  |
| remote capnweb server                                                          | remote dials in + `remoteCapability` mount + `itx-call`; wake protocol for resumable feeds; outward `capnweb-call` deferred                          |
| webhook, stream-tracked                                                        | subscription, `webhook-post` (plain)                                                                                                                 |
| webhook, remote-tracked                                                        | subscription, `webhook-post` + `confirmedOffset` ack — or registered-reader pull                                                                     |
| browser mirror (+ mirror-hosted browser processors)                            | reader (registered), deliberately not a subscription; checkpoints stay client-side                                                                   |
| session connections (tabs, TUI, mobile, state-only, ad-hoc React)              | caller-opened connections; outside the durable model; #2384 controls here                                                                            |
| remote-app vessel relay (`apps/tasks`)                                         | caller-opened connection through the vessel; **fix the `as unknown as` drift onto the real typed surface**                                           |
| `waitForEvent` / `waitUntilProcessed`                                          | verbs: `waitForEvent` unchanged; `waitUntilConfirmed` replaces the processor-only barrier                                                            |
| runner self-catch-up, fold rebuilds, agent prompt re-reads, ad-hoc `getEvents` | readers (unregistered), unchanged                                                                                                                    |
| LiveState subscribers                                                          | not an event consumer (no cursor/replay) — but `liveState` is a **required surface on every processor instance** and on the stream; see "Live state" |
| project DO `StreamDatabase` view                                               | downstream of the project-worker `itx-call` delivery; out of scope                                                                                   |
| cross-tab volatile relay, browser export                                       | client-side, out of scope                                                                                                                            |
| keepalive revival turns                                                        | ordinary delivery to the subscription after `processor-revived` — unchanged                                                                          |

## What dies, what stays

**Dies:** the `${durableObjectName}#${slug}` name convention;
slug-keyed progress (`stream-processor:<slug>:progress` → keyed by
subscription name — this is also what makes multi-instance physically
possible); the polymorphic `acknowledged_offset`;
`recordReportedCheckpoint` as a special case; `waitUntilProcessed` as a
processor-only verb; halt-as-only-terminal-state; the
`subscriptionKeyWasGenerated` flag (generated names are first-class);
the vessel's cast.

**Stays untouched:** the log and offsets; the inline core processor
(pre-commit, assigns offsets — the runner-redesign non-goal stands); the
receiver union's arms and per-arm policies; the two-cursor
`ProcessorProgress` record and its atomic commit; `blockProcessorWhile` /
`runInBackground` and the obligation pattern; copy fences and cycle
suppression; every epoch fence; session semantics and close reasons; the
keepalive/revival machinery; the LiveState engine and protocol (snapshot

- patches + revisions — only where engines live moves, per placement).

## Migration (clean break)

1. Cursor rows: copy `acknowledged_offset` into both `delivered_offset`
   and `confirmed_offset`; `state = 'active'` (`'halted'` where a halt
   event is in force). Processor kinds may see one redundant wake —
   today's documented stale-row cost.
2. Progress records: re-key slug→name on first wake, or discard the
   reduction and copy only `processing` (state is a disposable fold).
3. Event payload / state map / wake request: `subscriptionKey` → `name`
   inside a `CORE_STATE_VERSION` bump.
4. Production subscription names: the census's full inventory is small
   (`project-worker`, `iterate-platform-posthog`, `github-repo:<path>`,
   `notification-intent:<path>`, `repo-catalog`, `project-config-to-root`,
   `agent-collection`, per-connection router keys, two starter-app keys) —
   re-configure, don't shim.
5. Fix `apps/tasks/src/rpc-api.ts` onto the real typed surface.

## Scope boundaries

Explicit, so nothing is excluded silently. Three categories:

**Dependencies this design names but does not solve:**

- **Auth for remote readers.** A pull consumer across a trust boundary
  (the offset-tracking remote) needs credentials and revocation for the
  read surface; the
  [delivery-transport task](../tasks/redesign-high-volume-stream-delivery-transport.md)
  owns that (its SSE/WS candidates already list it). This model assumes
  nothing about reader trust — names and auth compose, they don't
  substitute.
- **Retention / ephemeral-event eviction.** Unshipped; this model is its
  prerequisite: the safe eviction floor is `min(confirmed)` over
  subscriptions plus registered readers — hence the reader-registration
  open question.

**Named punts — consciously not designed here:**

- **Durable waiters.** `waitForEvent` stays a one-shot (the project DO
  says so explicitly, `project-durable-object.ts:663-670`). A
  survive-evictions predicate waiter is expressible later as a one-shot
  subscription (configure; halt after first match); not designed now.
- **The browser mirror's future.** Collapse-vs-move is an open decision
  (`tasks/stream-mirror-collapse-vs-move.md`); this model covers both
  outcomes — registered reader today, session consumer over a
  server-owned feed if collapsed.
- **Subtree/wildcard subscriptions.** Per-stream only, deliberately.
  "All child streams" remains the configure-at-birth pattern the
  project-worker feed already uses (`stream-durable-object.ts:545-570`).

**Genuinely out of scope (different concern, unchanged by this design):**

- The write side entirely: append API, idempotency keys, validation, the
  circuit breaker, canonicalization — plus the conditional-appends and
  event-kind-metadata tasks.
- Transport implementations: the transport task's candidates A–E slot in
  as connections; semantics above them are what this doc fixes.
- Domain RPC doors (`scheduler.setSchedule`, `invokeCapability`,
  `agent.message`, …) — domain surfaces, unchanged; only the processor
  facade's inner dial changes with placement.
- The project DO `StreamDatabase` view — unchanged; coupled only to the
  itx-call delivery's failure semantics (a storage failure still rejects
  and re-drives the batch).
- Deployment-global streams (`projectId: null`) — same model, different
  delivery-authority root, as today.
- Ordering and at-least-once guarantees — unchanged.
- LiveState pinning/transport fixes (wake sockets PR #2386, hibernatable
  RPC) — adjacent work; the Live state section above defines _where
  engines live_, not how their sockets hibernate.

## Open questions

1. **Park/resume poke protocol** — who may wake a parked subscription,
   and is the poke an appended event (fits creation-is-an-event doctrine)
   or an RPC to the source DO?
2. **Reader registration and retention** — must the browser mirror (and
   any pull remote) register before ephemeral-event eviction ships, or
   does eviction simply ignore unregistered readers?
3. **Bound on subscriptions per source stream** —
   `MAX_SUBSCRIPTIONS_PER_RECEIVING_STREAM = 64` bounds inbound copies;
   nothing bounds total outbound rows. Add a cap.
4. **`capnweb-call` timing** — wait for a consumer that composition
   (inward dial + mount) genuinely cannot serve.
5. **Sequencing vs facets** — the cursor split, naming, and `parked` are
   independent of placement and can land first; facet placement of the
   wake arm rides [stream-processors-as-facets](../tasks/stream-processors-as-facets.md).
