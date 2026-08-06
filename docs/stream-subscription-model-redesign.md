# Stream subscriptions, connections, and readers — model redesign

Status: **core model shipped** (CORE*STATE_VERSION 30; clean break, no data
migration). The identity doctrine (`name`, `byName`, opaque names), the
single-column confirmed cursor, facet placement, and the unified
`waitUntilConfirmed` barrier are implemented. A few designed extensions were
deliberately **deferred** — each is marked "future work" inline below.
Companion to
[stream processors as facets](../tasks/stream-processors-as-facets.md) —
that task decides \_where processors run*; this doc decides _how anything
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
   session closed — `capability "…" is offline`) burns the 15-attempt
   ladder (~2–2.5 h) and then halts permanently. There is no parked state.
   _(Still true — a `parked` state was designed and prototyped but
   deliberately deferred; see "Future work" below.)_
4. **No receiver can own its cursor unless it speaks the wake protocol.**
   `delivery` policy exists "only when the source owns an awaited delivery
   cursor", and the webhook adapter _discards the response body_ — a
   remote cannot ack an offset even if it wants to. Notably `webhook-post`
   has **zero production configs**; it was re-added in core-state v28
   explicitly as the future lane for remotely-hosted processors, so it can
   be redesigned for free. _(Still true — the offset-acking webhook was
   designed and prototyped but deliberately deferred; see "Future work".)_
5. **Pull is load-bearing but has no public model.** The runner catches
   itself up by paging its own stream, folds rebuild by replay, the agent
   re-reads its whole log for prompts, and a dozen surfaces call
   `getEvents`/`getEventPage` ad hoc — and the (since-retired and removed)
   remote-apps vessel consumed streams through an `as unknown as` cast
   onto a method that did not exist on the typed surface.

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
- **Slug names the contract.** `processorSlug` is _required_ on
  `processor-wake` and says which contract runs. As shipped, the
  subscription name must EQUAL the slug — one identity, enforced at
  configure time — so the single-instance case reads as today
  (`subscriptions.get("agent")`). Two instances of one contract (two
  names, one slug) is designed but deferred; see "Future work".
- **The field is renamed `subscriptionKey` → `name`** (event payload,
  state map, cursor table, wake request) under a `CORE_STATE_VERSION`
  bump. "Name" aligns with `ctx.facets.get(name, …)` and `getByName`;
  "key" stays reserved for storage internals, idempotency keys, and API
  keys, which it already means.

## The cursor row: one offset, one rule

Keep `subscription_cursors`, one row per subscription. Replace the
polymorphic offset with ONE column whose meaning never varies by kind:

```sql
create table subscription_cursors (
  name                                    text primary key,
  configured_at_offset                    integer not null,  -- birth epoch
  cursor_changed_at_offset                integer not null,  -- seek epoch
  confirmed_offset                        integer not null,  -- far side durably claims through here
  status                                  text not null default 'active',
                                          -- 'active' | 'halted'
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
```

**The one scheduling rule, for every kind: delivery resumes after
`confirmed_offset`.** Anything sent but never confirmed redelivers —
at-least-once; receivers dedupe by `(streamId, offset)`.

Writers, fenced by `cursor_changed_at_offset` +
`in_flight_connection_generation` exactly like today's late-ack
protection:

| Receiver       | writes `confirmed`                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| copy-to-stream | the awaited receiving append resolves (the ack)                                                                                      |
| itx-call       | the awaited call resolves (the ack)                                                                                                  |
| webhook-post   | HTTP 2xx (response body discarded)                                                                                                   |
| processor-wake | the wake response's reported checkpoint; live batch acks settle the in-flight watchdog only, so a stale row costs one redundant wake |

The barrier verb `waitUntilConfirmed(name, {offset})` reads this column
for every kind. Processor-wake caveat: during a live hosted connection
the stored confirmation deliberately goes stale until the next wake
report — callers that need the processor's own fold position use the
processor facade's `waitUntilProcessed`.

Lag is well-defined for every kind — `head − confirmed` — which directly
feeds
[surface-durable-consumer-lag-in-stream-ui](../tasks/surface-durable-consumer-lag-in-stream-ui.md).

**Future work — the delivered/confirmed split.** The original design
carried a second `delivered_offset` column ("the source completed
transfer through here") so a receiver could own its confirmation
separately from transfer — the enabler for offset-acking webhooks (a
remote returns `{ confirmedOffset }` in its 2xx body and owns its durable
position, with eviction redelivering the delivered-but-unconfirmed
window) and for pull-style registered readers. It was built, then cut
before merge: no consumer existed, and the split leaked complexity into
every ack path. If a remote-tracked webhook consumer materializes,
reintroduce `delivered_offset` alongside the webhook 2xx-body parse in
`stream-durable-object.ts` and the boot-time
rewind-delivered-to-confirmed rule.

## Subscription statuses: active, halted

`active` and `halted` are the shipped statuses (halt = the terminal
outcome of the retry ladder; `subscription-delivery-resumed` un-halts,
via `streams.get(path).resumeSubscription`).

**Future work — `parked`.** The design added a third durable status: the
receiver is legitimately absent (a live capability whose providing
session closed, a disconnected remote app), and that is not a failure —
cursor stays put, no retry alarm, nothing charged against the failure
ladder. It was built end-to-end (event type, reducer arm,
`StreamReceiverAbsentError`, UI badges, an internal resume door), then
cut before merge because nothing ever wired the RESUME side: the
capability host threw the absent error on invoke, but no presence signal
(provide/revoke, remote-app connect) ever poked the stream to resume, so
a parked subscription stayed parked forever — strictly worse than the
halt ladder it replaced. Reintroducing it requires the resume wiring
first: the receiver host must append `subscription-delivery-resumed`
(or call a resume door) when the receiver announces presence again.
Until then a legitimately-absent receiver burns the ordinary retry
ladder and halts loudly.

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
  live provided capabilities (absence fails and retries like any other
  delivery failure until `parked` ships — see "Future work" above). This arm —
  through a `remoteCapability` mount ([remote apps](./remote-apps.md)) —
  is also the first answer for "call RPC stub methods on a remote capnweb
  server": the remote dials in, mounts, and receives batches; if it
  implements the wake protocol it gets resumable checkpointed feeds,
  exactly as userspace SDK processors already do.
- **`webhook-post`** — unchanged: one POST per event, the 2xx alone
  acknowledges, the response body is discarded. (The offset-acking
  variant is future work — see "Future work" above.)

**Future work — per-subscription delivery controls.** No subscription
has any size/shape control — webhook page size is pinned to 1 event,
batch limits are global constants — while sessions have
`maxDeliveryEvents` / `maxDeliveryBytes` / `state: false` per connection
(PR #2384; those per-CONNECTION controls shipped and stay). The design
made the same three knobs ordinary optional config in the subscription's
birth event, honored by every push arm — a webhook-hosted remote
processor asks for real batches, a constrained device consumer caps
bytes. Built, then cut before merge: no consumer existed. Reintroduce as
three optional fields on `SubscriptionConfiguredPayload` plus the batch
narrowing in the send loop when one does.

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
  .subscriptions.list()                    // catalog ⋈ cursor rows: name, kind,
                                           //   status, lag (head − confirmed), lastError
  .subscriptions.get(name)
     .describe()                           // config + confirmed cursor + retry state
     .waitUntilConfirmed({offset})         // uniform barrier, every kind
     .processor                            // present iff processor-wake:
        .snapshot() .getRuntimeState()     //   dialed by placement (facet | expression)
  .setSubscriptionCursor({name, afterOffset}) // repair verbs stay stream-level
  .resumeSubscription({name})
  .getEvents({after}) / .getEventPage(...) // reader surface (existing)
  .waitForEvent(...)                       // log-predicate barrier (existing)
  .openConnection(...)                     // sessions (existing, + #2384 controls)

agent.processor                            // stays, as sugar for
                                           // streams.get(agentPath).subscriptions.get("agent").processor
```

(Catalog-node sugar for `.setCursor` / `.resume` / `.liveState` was
built and cut — zero callers; the stream-level verbs and the facet
liveState relays cover every real consumer.)

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
(via the per-domain facades, e.g. `agent.liveState`), and
cross-instance composition happens at the stream's own `liveState`,
which already carries the per-subscription runtime rows (status, lag,
last error) that the consumer-lag UI task needs.

## Coverage: every census kind, mapped

| Kind (census)                                                                  | Lands as                                                                                                                                             |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| processor on own DO (agent, project, repo, …)                                  | subscription, `processor-wake` + expression; confirmed = reported checkpoint                                                                         |
| processor as stream facet (planned)                                            | subscription, `processor-wake` + `facet` placement; name = facet name; in-process dial                                                               |
| userspace worker processor (`createProcessorHost`, sdk)                        | subscription, `processor-wake` + expression — unchanged protocol                                                                                     |
| two instances, one contract                                                    | future work: name==slug is enforced today; two names sharing one slug needs name-keyed registration re-added                                         |
| copy-to-stream (repo links, agent-collection, catalogs)                        | subscription, `copy-to-stream` — unchanged                                                                                                           |
| project-worker feed, PostHog feed                                              | subscriptions, `itx-call` — already the target naming style (`project-worker`, `iterate-platform-posthog`)                                           |
| live provided capability on the itx tree                                       | subscription, `itx-call`; absence retries/halts until `parked` ships (future work)                                                                   |
| remote capnweb server                                                          | remote dials in + `remoteCapability` mount + `itx-call`; wake protocol for resumable feeds; outward `capnweb-call` deferred                          |
| webhook, stream-tracked                                                        | subscription, `webhook-post` (plain)                                                                                                                 |
| webhook, remote-tracked                                                        | future work: `webhook-post` + `confirmedOffset` ack (needs the delivered/confirmed split) — or registered-reader pull                                |
| browser mirror (+ mirror-hosted browser processors)                            | reader (registered), deliberately not a subscription; checkpoints stay client-side                                                                   |
| session connections (tabs, TUI, mobile, state-only, ad-hoc React)              | caller-opened connections; outside the durable model; #2384 controls here                                                                            |
| remote-app vessel relay                                                        | the vessel app was retired and removed (its stale `apps/tasks` build artifacts too); remote apps ride [remote apps](./remote-apps.md)                |
| `waitForEvent` / `waitUntilProcessed`                                          | verbs: `waitForEvent` unchanged; `waitUntilConfirmed` replaces the processor-only barrier                                                            |
| runner self-catch-up, fold rebuilds, agent prompt re-reads, ad-hoc `getEvents` | readers (unregistered), unchanged                                                                                                                    |
| LiveState subscribers                                                          | not an event consumer (no cursor/replay) — but `liveState` is a **required surface on every processor instance** and on the stream; see "Live state" |
| project DO `StreamDatabase` view                                               | downstream of the project-worker `itx-call` delivery; out of scope                                                                                   |
| cross-tab volatile relay, browser export                                       | client-side, out of scope                                                                                                                            |
| keepalive revival turns                                                        | ordinary delivery to the subscription after `processor-revived` — unchanged                                                                          |

## What dies, what stays

**Dies:** the `${durableObjectName}#${slug}` name convention;
the polymorphic `acknowledged_offset`;
`recordReportedCheckpoint` as a special case; `waitUntilProcessed` as a
processor-only verb; the `subscriptionKeyWasGenerated` flag (generated
names are first-class); the vessel's cast (with the vessel itself).

**Stays untouched:** the log and offsets; the inline core processor
(pre-commit, assigns offsets — the runner-redesign non-goal stands); the
receiver union's arms and per-arm policies; the two-cursor
`ProcessorProgress` record and its atomic commit; `blockProcessorWhile` /
`runInBackground` and the obligation pattern; copy fences and cycle
suppression; every epoch fence; session semantics and close reasons; the
keepalive/revival machinery; the LiveState engine and protocol (snapshot

- patches + revisions — only where engines live moves, per placement).

## Migration (clean break — as shipped)

No data migration at all: the redesign ships inside `CORE_STATE_VERSION`
30 with a deploy-time production erase. Cursor rows, progress records,
and event payloads are all born under the new vocabulary
(`subscriptionKey` → `name`, one `confirmed_offset`, `status`); the
retired vessel app's stale build artifacts (`apps/tasks/dist-package`)
were deleted with it.

## Scope boundaries

Explicit, so nothing is excluded silently. Three categories:

**Deferred slices of this design (built, cut before merge — see the
"Future work" notes inline):**

- **`parked` / receiver-absent handling** — blocked on resume wiring
  (the presence signal that un-parks).
- **The delivered/confirmed split + offset-acking webhooks** — blocked
  on a real remote-tracked consumer.
- **Multi-instance (name ≠ slug)** — name==slug is enforced; two
  instances of one contract need name-keyed registration re-added.
- **Per-subscription delivery controls** — per-connection controls
  (#2384) shipped; the subscription-level knobs wait for a consumer.
- **Catalog-node sugar** (`subscriptions.get(name).setCursor` /
  `.resume()` / `.liveState`) — zero callers; stream-level verbs cover
  every real consumer.

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

1. **Park/resume poke protocol** (blocks the deferred `parked` status) —
   who may wake a parked subscription, and is the poke an appended event
   (fits creation-is-an-event doctrine) or an RPC to the source DO?
2. **Reader registration and retention** — must the browser mirror (and
   any pull remote) register before ephemeral-event eviction ships, or
   does eviction simply ignore unregistered readers?
3. **Bound on subscriptions per source stream** —
   `MAX_SUBSCRIPTIONS_PER_RECEIVING_STREAM = 64` bounds inbound copies;
   nothing bounds total outbound rows. Add a cap.
4. **`capnweb-call` timing** — wait for a consumer that composition
   (inward dial + mount) genuinely cannot serve.
