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
structurally impossible — a copy is never ingested by a stream already on its
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
addresses the destination stream's `ingest` sink; the appended
`subscription-configured` event is the real interface. Delivery is durable and
at-least-once (cursor + retries + parking), and `ingest` derives idempotency
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
delegates to the project worker — `["streams", ["get", path], "ingest"]`);
webhook is the same cursor machinery pointed at plain HTTP:

|                         | ephemeral                              | durable `wake`                                                      | durable `push`                                                  | durable `webhook`                                |
| ----------------------- | -------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------ |
| who                     | browsers, tests, `waitForEvent`        | DO-hosted processors (stateful folds)                               | stateless effects: the project worker feed, cross-post `ingest` | external HTTP receivers                          |
| subscription            | `subscribe()` (session)                | config event, `delivery: {mode:"wake", expression, processorSlug?}` | config event, `delivery: {mode:"push", expression}`             | config event, `delivery: {mode:"webhook", url}`  |
| offset owner            | client, in-memory                      | **subscriber** — `{offset, state}` snapshot, atomic with the fold   | **stream** — spine cursor row, atomic with the log              | **stream** — same cursor row, advanced per EVENT |
| stream-side row         | none                                   | observational watermark (poke coalescing, lag)                      | authoritative cursor                                            | authoritative cursor                             |
| sink arrives as         | `subscribe()` parameter                | returned from the expression-named poke                             | named by a persisted itx expression                             | the configured URL                               |
| warm transport          | retained one-way callback              | retained one-way sink                                               | fresh awaited call per batch                                    | one `fetch` POST per event                       |
| return frames per batch | **zero** (result disposed unpulled)    | one, non-gating (pulled as the liveness signal)                     | one, awaited (**the ack** that advances the cursor)             | the 2xx response (**the ack**), per event        |
| retry / failure         | client's problem                       | spine: backoff rows + alarm → parked fact                           | same spine, same machine (+ `onPoison: park \| skip`)           | same spine, same machine, per-event granularity  |
| replay                  | `replayAfterOffset` arg                | subscriber's checkpoint decides                                     | `deliver: "all" \| "new" \| {afterOffset}` + `cursor-set`       | same as push                                     |
| filter                  | `selector` / `eventTypes` on subscribe | processor `contract.consumes` (announced on the poke)               | `selector: {eventTypes?, condition?}` in config                 | same selector shape                              |

The pump never awaits a delivery on the ephemeral and wake lanes — that is
what keeps warm append→processed latency in single-digit milliseconds (voice
rides this). Ephemeral batch results are disposed **unpulled**, so those
subscriptions generate zero subscriber-originated return frames (a
`ReadableStream` could never do this: its per-chunk acks ARE its flow
control — see the `FlowController` in
[capnweb](https://github.com/cloudflare/capnweb)); durable batch results are
pulled — never awaited — purely as the prompt dead-connection signal
([stub lifecycle rules](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/)).

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
  receivers: `ingest` documents its own `params.transform`. When an effect
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
`itx.email.processor`, `itx.integrations.slack["<conn>"].processor`, …), and
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

## The worker feed: born, not wired

Every project-scoped stream appends its own worker feed in its birth
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

## File map

| File                         | Role                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `stream-durable-object.ts`   | The stream: append commit point, core processor, birth certificate, the dial (pokes, push expressions, webhooks), `ingest` |
| `core-processor-contract.ts` | Core contract: reduced-state schema (v11) + the `events.iterate.com/stream/*` event catalog                                |
| `stream-storage.ts`          | Chunked SQLite event log (2 MB cell limit → JS chunking) + the spine's `subscriptions` cursor rows                         |
| `stream-subscribers.ts`      | Every subscriber, one module: sink table, connection pump, the durable spine (ports-only; no RPC, no clock)                |
| `subscriber-sinks.ts`        | The RPC quarantine: stub retention (dup/dispose/onRpcBroken, pulled-vs-disposed results)                                   |
| `subscriber-math.ts`         | Pure spine math: backoff, initial cursors, bisect, delivery ids (table-tested)                                             |
| `event-selector.ts`          | `EventSelector` — THE filter shape on every lane; shared JSONata compile cache                                             |
| `processor-contracts.ts`     | `defineProcessorContract` + event-type → payload-schema resolution machinery                                               |
| `stream-processor.ts`        | The `StreamProcessor` base class (batch ingest, checkpointing, hooks)                                                      |
| `stream-processor-host.ts`   | Hosts processors in a DO; answers pokes with `{checkpoint, sink, …}`                                                       |
| `schemas.ts`                 | `StreamEvent` / `StreamEventInput` zod schemas (incl. `crossPostedFrom` provenance)                                        |
| `utils.ts`                   | Stream path resolution + wake-subscription event builder                                                                   |
| `client-libraries/`          | Browser mirror host and browser-side processors                                                                            |

Public capability surface (`Stream`, `StreamEventBatch`, `ProcessEventBatch`,
…) is defined in `src/domains/streams/rpc-types.ts` (and projected into the
generated contract `src/itx-api.generated.ts`); the Cap'n Web / Workers RPC
facades live in `src/rpc-targets.ts`. Design doctrine:
`docs/domain-objects-and-stream-processors.md`. Debugging runbook:
`apps/os/docs/debugging-streams.md`.
