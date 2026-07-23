# Streams

Durable, offset-ordered event streams — the platform's public coordination
primitive. One `StreamDurableObject` per (projectId, path) coordinate owns an
append-only journal in DO SQLite; everything else in the system observes or
extends a stream by appending events and processing them.

## The locality rule (read this first)

**A stream processor on stream A can only ever react to events ON stream A.**
There is no cross-stream subscription, no federated read, no "also watch that
stream over there". The ONLY way for A to react to what happens on stream B is
for B's events to be **cross-posted onto A** — real copies, appended to A's
own log, each carrying the full provenance chain in
`source.crossPostedFrom` (source stream, offset, type, the subscription that
carried the hop; multi-hop chains are legal up to a cap of 5, and loops are
structurally impossible — a copy is never accepted by a stream already on its
chain). Copying with provenance IS the mechanism; design around it, not
against it.

Saying it is one call:

```ts
// "when a github webhook about acme/widgets lands HERE, post it onto the repo stream"
await itx.streams.get("/integrations/github/mine").crossPostTo({
  path: "/repos/widgets",
  eventTypes: ["events.iterate.com/github/webhook-received"],
  condition: 'payload.body.repository.full_name = "acme/widgets"', // JSONata, filter-only
});

// optionally reshaping the copy (JSONata CONSTRUCTS the new body):
await itx.streams.get("/integrations/github/mine").crossPostTo({
  path: "/repos/widgets",
  eventTypes: ["events.iterate.com/github/webhook-received"],
  transform:
    '{ "type": "repo/pr-opened", "payload": { "repo": payload.body.repository.full_name } }',
});
```

`crossPostTo` is sugar for a **push subscription** (below) whose expression
addresses the destination stream's `acceptCrossPost` sink; the appended
`subscription-configured` event is the real interface. Delivery is durable and
at-least-once (cursor + retries + parking), and `acceptCrossPost` derives idempotency
keys from the source coordinate, so at-least-once delivery collapses to
exactly-once appends.

## The model

**Append is the commit point.** `append(...)` runs in one synchronous,
await-free turn: validate → assign offsets → reduce → persist. After the
persist line the append has succeeded; all delivery is post-commit fan-out
that cannot fail it. This synchronicity is the whole reason stream storage
methods are not `async` — see the warnings on `append` in
`stream-durable-object.ts`. Storage writes commit under the Durable Object
output gate ([SQLite in Durable Objects](https://blog.cloudflare.com/sqlite-in-durable-objects/),
[SQL storage API](https://developers.cloudflare.com/durable-objects/api/sql-storage/)).

**State is a fold.** Every stream folds its own events into a reduced "core"
state (`maxOffset`, coordinates, pause door, durable subscriptions, the
live-subscriber presence roster). The `{state, version}` checkpoint in DO KV
is a disposable cache: version-skewed or missing state is rebuilt by replaying
the SQL event log.

**Processors subscribe; the core runs inline.** Domain logic lives in
`StreamProcessor` subclasses (agents, repos, secrets, Slack, …) fed batches
through subscriptions. The stream's own core processor has the same
three-part shape —

|                    | hosted processor (`stream-processor.ts`)           | core processor (`stream-durable-object.ts`) |
| ------------------ | -------------------------------------------------- | ------------------------------------------- |
| contract / schemas | `*-processor-contract.ts`                          | `core-processor-contract.ts`                |
| pure fold          | `reduce`                                           | `#reduce`                                   |
| side effects       | `processEvent` / `processEventBatch`               | `#processEvent`                             |
| pre-commit gate    | — (impossible: subscriptions see committed events) | `#validateAppend`                           |

— but it runs inline in the append turn, which grants it the two powers no
hosted processor can have: it is synchronous with the commit, and
`#validateAppend` can **reject an event before it becomes a durable fact**
(pause door, delivery expression/URL validation).

## Subscribers: one axis, one sink

A stream has **subscribers**. Every subscriber gives the stream exactly one
thing — a **sink**, `(batch: StreamEventBatch) => unknown`, the same envelope
for browsers, hosted processors, and the project worker ("stream processor"
is one shape). Subscribers differ on ONE axis: does the subscription survive
the session?

- **Ephemeral subscribers** call `subscribe()` and are forgotten on
  disconnect: browser tails, `waitForEvent`, tests, operators. Nobody owes
  them completeness.
- **Durable subscribers** are DATA: an
  `events.iterate.com/stream/subscription-configured` event (latest per
  `subscriptionKey` wins; `subscription-removed` revokes). The stream owes
  them every matching event, forever, across disconnects, deploys, and
  hibernation.

Durable delivery comes in three modes, chosen by one criterion — **the offset
lives with whoever owns the state it must be transactionally consistent
with**. Wake and push share ONE addressing grammar: a persisted itx
expression naming the method to invoke on the ordinary domain surface
(`["agents", ["get", path], "processor", "wakeStreamSubscriber"]`,
`["processEventBatch"]` — the project root's own dispatch point, which
delegates to the project worker — `["streams", ["get", path], "acceptCrossPost"]`);
webhook is the same cursor machinery pointed at plain HTTP:

|                         | ephemeral                                                                   | durable `wake`                                                      | durable `push`                                                         | durable `webhook`                                |
| ----------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------ |
| who                     | browsers, tests, `waitForEvent`                                             | DO-hosted processors (stateful folds)                               | stateless effects: the project worker feed, `acceptCrossPost`, PostHog | external HTTP receivers                          |
| subscription            | `subscribe()` (session)                                                     | config event, `delivery: {mode:"wake", expression, processorSlug?}` | config event, `delivery: {mode:"push", expression}`                    | config event, `delivery: {mode:"webhook", url}`  |
| offset owner            | client, in-memory                                                           | **subscriber** — `{offset, state}` snapshot, atomic with the fold   | **stream** — spine cursor row, atomic with the log                     | **stream** — same cursor row, advanced per EVENT |
| stream-side row         | none                                                                        | observational watermark (poke coalescing, lag)                      | authoritative cursor                                                   | authoritative cursor                             |
| sink arrives as         | `subscribe()` parameter                                                     | returned from the expression-named poke                             | named by a persisted itx expression                                    | the configured URL                               |
| warm transport          | retained one-way callback                                                   | retained one-way sink                                               | fresh awaited call per batch                                           | one `fetch` POST per event                       |
| result frames per batch | **zero** (result disposed unpulled)                                         | **zero**; one explicit, non-gating settlement message               | one, awaited (**the ack** that advances the cursor)                    | the 2xx response (**the ack**), per event        |
| retry / failure         | client's problem                                                            | spine: backoff rows + alarm → parked fact                           | same spine, same machine (+ `onPoison: park \| skip`)                  | same spine, same machine, per-event granularity  |
| replay                  | durable rows after `replayAfterOffset`; ephemeral rows only live after open | subscriber's checkpoint decides                                     | `deliver: "all" \| "new" \| {afterOffset}` + `cursor-set`              | same as push                                     |
| filter                  | `selector` / `eventTypes` on subscribe                                      | processor `contract.consumes` (announced on the poke)               | `selector: {eventTypes?, condition?}` in config                        | same selector shape                              |

### Ephemeral events

`append({ ..., ephemeral: true })` commits a SECOND-CLASS event: an ordinary
offset-ordered row (same commit turn, same idempotency dedup, same circuit
breaker, same pause door), with two deliberate demotions:

- **Excluded from reads by default.** Range reads (`getEvents`, `readEvents`,
  processor catch-up) skip ephemeral rows unless the caller passes
  `includeEphemeral: true`. Point reads by offset or idempotencyKey — an
  explicit request — always return them.
- **Excluded from durable subscribers by default.** The wake/push/webhook lanes
  drop ephemeral events from delivery exactly the way selectors already skip
  non-matching events (skip-not-defer: cursors advance over their offsets),
  so subscription-fed product processors never fold or side-effect on one.
  A push/webhook may explicitly set `includeEphemeral: true`; the ordinary
  first-party PostHog subscription does so to mirror every committed row. Wake
  processors cannot opt in. Ephemeral
  `subscribe()` connections receive an ephemeral row only when it is appended
  after that exact connection opens. Reconnect/catch-up replays durable rows
  only; historical ephemeral rows are never delivered.

The whole pattern in one shape — the rule is "never derive durable state
from an ephemeral event"; the durable truth is always its own append:

```ts
// per streamed token: live product subscribers paint it; product state never folds it
await stream.append({ type: ".../llm-response-chunk", ephemeral: true, payload: { chunk } });
// once, when the turn settles: THE fact processors fold
await stream.append({
  type: ".../agents/context-added",
  payload: { role: "assistant", content: text, llmRequestOffset },
});

await stream.getEvents(); //                          durable events only
await stream.getEvents({ includeEphemeral: true }); // + surviving ephemeral rows
```

The e2e ("ephemeral events are second-class rows…", `streams.e2e.test.ts`)
proves every clause of this contract end to end, and the `ephemeral-events`
entry in the itx example catalogue is its userspace-runnable twin.

The demotions are a license the stream keeps: because product state cannot
depend on an ephemeral row, a future sweep may EVICT them (memory pressure,
DO-startup cleanup), leaving permanent offset gaps that every read path —
including the browser mirror — already tolerates. Constraints pre-paid for
that future sweep: the offset allocator survives head-row eviction
(`highestAssignedOffset()` reads AUTOINCREMENT's `sqlite_sequence`, which row
deletion does not reset — reissuing a seen offset would wedge every
offset-keyed consumer); eviction forgets idempotency keys (a swept key
dedupes nothing on re-append — so never sweep rows younger than the LLM
obligation horizon, or a crashed turn's retry re-appends chunks whose old
copies live on in browser mirrors); and a post-sweep state rebuild counts
only surviving rows (`eventCount` may decrease — never compare it to
`maxOffset`). Use ephemeral events for transient signals whose durable truth
lands separately: the canonical case is LLM streaming chunks
(`agent/llm-response-chunk`), superseded by the durable assistant
`agents/context-added` item.
`stream/*` control facts cannot be ephemeral — config, presence, and park
state may never be forgotten. One consequence worth naming: a durable
subscription (cross-post, webhook) whose selector matches only ephemeral
types delivers nothing, silently — there is nothing durable to deliver.

The pump never awaits a delivery on the ephemeral and wake lanes — that is
what keeps warm append→processed latency in single-digit milliseconds (voice
rides this). Both batch-call results are disposed **unpulled**, so neither
lane emits a result frame (a `ReadableStream` could never do this: its
per-chunk acks ARE its flow control — see the `FlowController` in
[capnweb](https://github.com/cloudflare/capnweb)). Wake batches instead carry
a one-shot settlement capability. The subscriber sends one explicit,
non-gating success/failure message after its durable processor attempt and
disposes that call's result unpulled too. Keeping the settlement out of the
batch call's result is load-bearing: processors routinely append back to the
delivering stream, and a pulled result would make that nested append part of a
cyclic actor-drain tree. `onRpcBroken` remains the prompt best-effort transport
hint ([stub lifecycle rules](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/)).

## The spine: durable delivery bookkeeping

All durable-subscription bookkeeping lives in one place
(`stream-subscribers.ts` + the `subscriptions` SQLite table beside the event
log):

```
            delivery/poke ok                     attempt ≥ 15 (~3.5h of outage)
  active ──────────────────▶ active     retrying ──────────────────────────▶ parked
    │  failure                              ▲ │ backoff min(30m, 1s·2^n) ±20% jitter,
    └───────────▶ retrying ─────────────────┘ │ one DO alarm = MIN(next_attempt_at)
                                              ▼
                              parked ── subscription-resumed ──▶ active
                              (a redrive appends cursor-set first — resume is a pure un-park)
```

Doctrine, worth memorizing:

- **Acked offsets are storage, not facts; park and resume are facts, not
  storage.** Per-batch cursor advances are SQLite row updates (commit chatter
  stays out of the journal); `subscription-parked` / `-resumed` /
  `-cursor-set` are appended events (auditable, loud, foldable).
- **The spine triggers on watermark lag, never on event types.** Events are
  data, not control flow: presence facts, park facts, and error records wake
  the pump like any append does, and reconcile to a no-op when there is
  nothing to do.
- **Selectors filter; receivers transform; platform config never embeds
  code.** A selector (`{eventTypes?, condition?}` — one shape on every lane,
  [JSONata](https://jsonata.org/) conditions must evaluate to exactly `true`)
  may reject events, never construct output. Transforms live in named
  receivers: `acceptCrossPost` documents its own `params.transform`. When an effect
  needs real code, it goes in the project worker — typed, reviewed, in the
  repo.
- **Persist the name, re-derive the authority.** A delivery expression
  (`src/itx/expression.ts`) — wake AND push — is a capability NAME evaluated
  per delivery against the stream's own authority root: the project-scoped
  `env.ITX` root (the identical recipe every dynamic worker gets), or the
  trusted deployment root for global (`projectId: null`) streams. Deleting
  the subscription is revocation. A PROJECT root can't name another project,
  so cross-project delivery is unexpressible rather than checked. (The
  deployment root is wider — it is session-shaped and admin-write-only, so a
  global stream's expressions are already operator territory.)
- **Control facts must be first-hand.** A cross-posted copy of a
  `stream/*` control event is stored and visible but INERT — it configures
  nothing (closes the config-propagation-by-copy hole no matter what
  selectors people write).

## The wake handshake: one poke, one return value

For wake-mode subscribers (stateful DO-hosted processors) the whole handshake
is a single call. The subscription persists the poke's NAME — the processor
node on the ordinary domain surface, plus the wake door the dial appends:

```ts
delivery: {
  mode: "wake",
  expression: ["agents", ["get", "/agents/bla"], "processor", "wakeStreamSubscriber"],
  processorSlug: "agent",  // multi-processor hosts resolve on it
}
```

Every host's processor is a real itx node (`itx.agents.get(path).processor`,
`itx.repos.get(path).processor`, the project root's own `itx.processor`,
`itx.email.processor`, `itx.integrations.slack.get("<conn>").processor`, …), and
`wakeStreamSubscriber` on it is the host's wake door — trusted-internal only,
because the handshake's sink drives the host's durable checkpoint. The stream
pokes; the host answers with everything:

```ts
wakeStreamSubscriber({ stream, subscriptionKey, processorSlug? })
  → { checkpointOffset, sink, subscriber, getRuntimeState }
```

The stream retains the returned sink (returned-stub ownership transfers to
the caller), streams one-way batches into it from `checkpointOffset + 1`, and
appends the `subscriber-connected` presence fact carrying the processor's
contract announcement. There is no subscribe-back call, so there is no
handshake race — and no generation fencing, no supersede machinery, no
host-side idle timer. Failure handling is structural: a rejected batch result
closes the connection, the spine's watermark shows lag, and the next
poke-with-backoff replays from the host's checkpoint (`ingest` is internally
serialized and offset-deduped, so a dying sink overlapping its replacement is
harmless).

Both sides still hibernate: the stream severs idle durable connections with
an in-memory timer (never an alarm — the retained stubs it tears down die
with the incarnation anyway), suppressing reconcile for the teardown turn and
advancing watermarks past its own disconnect facts so teardown doesn't
immediately re-poke. The spine's RETRY alarm is the opposite case on purpose:
its state is durable rows, so waking a hibernated DO is exactly the point.

## The worker feed

Every non-root project stream appends its own worker feed in its birth
certificate — `created (1)`, `subscription-configured (2)`, `woken (3)`:

```ts
{ subscriptionKey: "project-worker",
  delivery: { mode: "push", expression: ["processEventBatch"] },
  deliver: "all",      // the worker sees full history once it first builds
  onPoison: "skip" }   // one bad event must not silence the feed
```

Born-configured means zero wiring window (the feed is armed before the first
user event can land) with no derivation special case: it is ordinary config,
overridable by re-appending the same key (narrow the selector, park it,
whatever). The worker returns → ack; throws → redelivery with backoff.
`${event.path}@${event.offset}` is the idempotency idiom that makes
at-least-once redelivery a no-op.

The root `/` stream is the deliberate exception. The project creation saga
waits for the config repo's worker to build, then appends the same literal
subscription starting immediately before `project/create-requested`, with
`onPoison: "park"`. It waits for that exact cursor to acknowledge the creation
request before appending terminal `project/created`. This both avoids treating
the worker as broken while it is being built and makes the userspace creation
hook part of the project's creation boundary.

## Hosting processors in a Durable Object

```ts
export class RepoDurableObject extends DurableObject<Env> {
  readonly #host = createStreamProcessorHost(this.ctx, {
    stream: new StreamRpcTarget({ auth, projectId, path }),
    version: workerVersion(this.env),
  });
  readonly #repoProcessor = this.#host.add((deps) => new RepoProcessor({ ...deps, github }));

  wakeStreamSubscriber(args: StreamSubscriberWakeRequest) {
    return this.#host.wakeStreamSubscriber(args);
  }
}
```

`add` registers the processor under its `contract.slug`, stores checkpoints in
DO KV, and gives the processor the host's own public `Stream` capability —
processors never hold raw DO stubs. The browser stream mirror
(`client-libraries/browser/`) is a second host of the same engine: it runs
real `StreamProcessor` subclasses against wa-sqlite with the same
announcements and checkpoints.

## The browser mirror: one download, many processors

The browser mirrors a stream into a per-`(projectId, path)` OPFS SQLite file so
React views query projections (`events`, `feed_items`, …) reactively instead of
holding history in memory. There is exactly **one** way to do it:

```ts
const { store, snapshot } = useStreamMirror({
  projectId,
  streamPath,
  createStreamClient,
});
// store.streamDatabase carries EVERY canonical table; views query what they need
```

**One runtime per stream, one download.** `acquireStreamRuntime` is keyed by
`(projectId, path)` — every view of a stream, on every page, joins the same
runtime and its single capnweb subscription. That runtime downloads the stream
once (client-paced `getEvents` catch-up while far behind the head, then the live
tail — the server pump is one-directional and would otherwise outrun wa-sqlite;
see the flow-control note in `stream-browser-store.ts`) and fans every batch out
to a **fixed canonical set of processors** — the raw-events cache
(`events` + `event_type_counts`) and the feed projection (`feed_items`). Views
do not choose processors; the set lives in `canonical-mirror-processors.ts`, and
adding a browser projection is an edit there, not a per-view decision.

**Fan-out is a composite, so the runtime stays single-drive.**
`CompositeMirrorDrive` (`composite-mirror-drive.ts`) holds one
`StreamProcessorRunner` per member and answers the runtime's wake handshake as
one unit, so the runtime's race-critical machinery (connection epochs,
half-open transport eviction, liveness probe, ingest self-heal) never learns
about processor lists. Its sink fans each frame to the members **sequentially**
(they share one SQLite connection — parallel commit transactions would
interleave) and it reports the **minimum** member checkpoint as the replay
cursor, so catch-up covers the least-caught-up member. Over-delivery is free:
every member's runner offset-dedupes delivered events against its own durable
acknowledged cursor (`stream-processor-runner.ts`), so a member that is already
ahead cheaply no-ops. Each member's projection writes and its two-cursor
progress record commit in **one SQLite transaction** per frame
(`processor-state-storage.ts`), so a member's mirror rows and resume cursor can
never disagree.

**Members stay independent where it matters.** Reconcile and mirror discard are
per-member: each member keeps its own tables, schema version, and durable
progress row **keyed by its real slug** — so a member's schema bump rebuilds
only its tables, and unifying the download never invalidated an existing local
cache. Only the _server subscription key_ and the _writer-lock name_ (versioned
by a compatibility vector over all members) are mirror-level.

## File map

| File                         | Role                                                                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `stream-durable-object.ts`   | The stream: append commit point, core processor, birth certificate, the dial (pokes, push expressions, webhooks), `acceptCrossPost` |
| `core-processor-contract.ts` | Core contract: reduced-state schema (v11) + the `events.iterate.com/stream/*` event catalog                                         |
| `stream-storage.ts`          | Chunked SQLite event log (2 MB cell limit → JS chunking) + the spine's `subscriptions` cursor rows                                  |
| `stream-subscribers.ts`      | Every subscriber, one module: sink table, connection pump, the durable spine (ports-only; no RPC, no clock)                         |
| `subscriber-sinks.ts`        | The RPC quarantine: stub retention (dup/dispose/onRpcBroken, one-way result ownership)                                              |
| `subscriber-math.ts`         | Pure spine math: backoff, initial cursors, bisect, delivery ids (table-tested)                                                      |
| `event-selector.ts`          | `EventSelector` — THE filter shape on every lane; shared JSONata compile cache                                                      |
| `processor-contracts.ts`     | `defineProcessorContract` + event-type → payload-schema resolution machinery                                                        |
| `stream-processor.ts`        | The `StreamProcessor` base class (batch ingest, checkpointing, hooks)                                                               |
| `stream-processor-host.ts`   | Hosts processors in a DO; answers pokes with `{checkpoint, sink, …}`                                                                |
| `schemas.ts`                 | `StreamEvent` / `StreamEventInput` zod schemas (incl. `crossPostedFrom` provenance)                                                 |
| `utils.ts`                   | Stream path resolution + wake-subscription event builder                                                                            |
| `client-libraries/`          | Browser mirror host and browser-side processors                                                                                     |

Public capability surface (`Stream`, `StreamEventBatch`, `ProcessEventBatch`,
…) is defined in `src/domains/streams/rpc-types.ts` (and projected into the
generated contract `src/itx-api.generated.ts`); the Cap'n Web / Workers RPC
facades live in `src/rpc-targets.ts`. Design doctrine:
`docs/domain-objects-and-stream-processors.md`. Debugging runbook:
`apps/os/docs/debugging-streams.md`.
