# Streams

A stream is an offset-ordered event log. One `StreamDurableObject` owns each
`(projectId, path)`. Processors and integrations communicate by appending and
reducing explicit events.

Read:

- [ways to receive and send stream events](../../../docs/stream-event-connections-and-subscriptions.md);
- [subscription events and state](../../../docs/stream-subscription-events-and-state.md);
- [domain objects and stream processors](../../../../../docs/domain-objects-and-stream-processors.md);
- [writing stream processors](../../../../../docs/writing-stream-processors.md).

## A processor reads its own stream

A processor on stream A reacts only to events appended to A. To make matching
events from B appear on A, configure A as the receiving stream:

```ts
const agentStream = project.streams.get("/agents/reviewer");

await agentStream.subscribeToEventsFrom({
  sourceStreamPath: "/integrations/github/main",
  name: "github-for-reviewer",
  filter: {
    eventTypes: ["events.iterate.com/github/webhook-received"],
    jsonataCondition: 'payload.body.repository.full_name = "acme/widgets"',
  },
});
```

Subscription names are opaque, caller-chosen, per-stream-unique strings —
the same string is the catalog key at the stream, the itx address segment,
the facet name under facet placement, and the progress-key component under
own-DO placement. Omitting the name generates the reserved
`subscription:<offset>` form from the committed configure event.

The source stores the subscription and product-event cursor. The receiver
stores nothing at configure time: it keeps one passive record per
`(source path, subscription name)`, reduced from the stamps on its own
committed copies, and uses it to fence batches from a stale source lifetime
or a superseded config generation.
Every copied event is a normal append with its immediate source
path, stream lifetime ID, creation time, offset, type, timestamp, and
subscription name in `source.copiedFrom`.
That record proves the event travelled through that configured stream
delivery; it is not proof of who originally appended the source event.

An idempotency key based on the source stream's random lifetime ID, path,
subscription name, source offset, and the configure-or-cursor-change event makes
network retries within one send run a no-op on the receiver. Recreating the
source, replacing the subscription, or explicitly moving its read position starts a new
run, so replaying an old source offset deliberately appends it again.

## `append()` is the commit point

`append(...)` performs one synchronous turn:

1. validate each event against the core processor contract;
2. assign offsets;
3. reduce the in-memory core state;
4. check retained-state growth and persist the event rows (plus a debounced
   state checkpoint when due);
5. reconcile pending sends and other mutable delivery rows from the newly
   committed core state.

Once persistence succeeds, the append has succeeded. A later receiver call or
product-event delivery cannot retroactively fail it.

Do not add an `await` to the offset/reduce/persist path. SQLite writes commit
under the Durable Object output gate.

## Core processor

The stream core validates and reduces inline. It deliberately has no
event-by-event side-effect hook: after a commit, and again on every alarm, the
Durable Object compares mutable delivery rows with the complete reduced state
and repairs anything that is missing or stale.

| Part                           | Purpose                                |
| ------------------------------ | -------------------------------------- |
| `core-processor-contract.ts`   | Event schemas and reduced-state schema |
| `StreamCoreProcessor.validate` | Pre-append data and authority checks   |
| `StreamCoreProcessor.reduce`   | Pure state update                      |

The persisted reduced state is a rebuildable cache. When it is missing,
invalid, or from another reducer version, the stream recreates it by replaying
its SQLite event log behind `blockConcurrencyWhile`. Long replays durably sync
a separate progress checkpoint every eight 500-row pages. A saved stage is
resumed only after the offset-1 `stream/created` event proves the same project,
path, random stream ID, and creation time; promotion of the final state and
removal of the stage happen together.

Subscription state has the same hierarchy on every stream:

```ts
subscriptions: {
  inbound: {
    bySourcePath: {
      [sourcePath]: {
        [name]: {
          streamId,
          streamCreatedAt,
          cursorChangedAtSourceOffset,
          numEventsReceived,
          lastEventReceivedAt?,
        },
      },
    },
  },
  outbound: {
    byName: {
      [name]: {
        configuration,
        configuredAtOffset,
        configuredAt,
        cursorSet?: { afterOffset, setAtSourceOffset },
        deliveryHalted?,
        deliveryParked?,
      },
    },
  },
}
```

Delivered/confirmed offsets, retry times, live callbacks, and measurements
live in runtime state. They do not repeat durable configuration.

## Session callback connections

`openConnection()` keeps a callback open for one RPC session. It can replay durable events after an
offset, receive new events as they are appended, apply the common filter, or send state updates with
`events: false`.

```ts
using connection = await stream.openConnection({
  connectionKey: "browser",
  replayAfterOffset,
  filter: {
    eventTypes: ["events.example/message"],
    jsonataCondition: "payload.visible = true",
  },
  processEventBatch,
});
```

The callback exists only for that RPC session. Calling `connection.close()`,
disposing it, or disconnecting closes it. No subscription is appended.

## Subscription actions

Every durable subscription begins with
`subscription-configured` on its source.

Copy, ITX-call, and webhook receivers accept an optional `jsonataTransform`: a
JSONata constructor evaluated per event that shapes the delivered
`{ type?, payload?, metadata? }` (omitted fields copy verbatim) while
coordinates, provenance, and deduplication stay keyed to the source event. An
unparseable transform is rejected at configure time; an evaluation failure is
an ordinary delivery failure that respects `onFailingEvent`. `processor-wake`
never gets one: a hosted processor's reduced state must equal folding its
stream's committed events, and wake delivery feeds the processor its own log,
so transforming it would break replay/rebuild determinism.

### Hosted processor

```ts
receiver: {
  action: "processor-wake",
  expression: [
    "agents",
    ["get", "/agents/reviewer"],
    "processor",
    "wakeStreamProcessor",
  ],
}
```

The subscription NAME selects which registered contract runs (name ==
registered slug — one identity; two instances of one contract is deliberately
future work). Nothing enforces that at configure time: a name matching no
registered processor fails loudly at wake with the registry's unknown-name
error. Instead of an expression, `placement: "facet"` hosts
the processor as a facet of the stream's own Durable Object: the subscription
name is the facet name, delivery is an in-process parent→facet dial through
the same wake protocol, and the facet's alarms are proxied to the parent's
real platform alarm (`proxySetAlarm`/`proxyDeleteAlarm`/`proxyGetAlarm` on
the Stream DO).

The source calls the named wake method with the source stream's random lifetime
ID. The host durably binds its checkpoint to that ID and returns the ID,
checkpoint, and `processEventBatch` callback. Every ordered callback batch
carries the same ID. If the source stream is recreated while the host survives,
the host resets compatible stored progress for the new ID and fences any stale
callback; it never reuses the old checkpoint. The processor stores its
checkpoint with its reduced state.

### Receiving stream

```ts
receiver: {
  action: "copy-to-stream",
  receivingStreamPath: "/agents/reviewer",
  delivery: {
    start: "now",
    onFailingEvent: "halt",
  },
}
```

The source stores the cursor and awaits each receiving-stream append. A copy
cannot skip a repeatedly failing event.

### ITX method

```ts
receiver: {
  action: "itx-call",
  expression: ["worker", "processEventBatch"],
  delivery: {
    start: "beginning",
    onFailingEvent: "skip",
  },
}
```

The source evaluates the expression with authority derived from its own scope,
awaits the final method call, and advances its cursor only after success.

### Webhook

```ts
receiver: {
  action: "webhook-post",
  url: "https://example.com/hook",
  delivery: {
    start: "now",
    onFailingEvent: "halt",
  },
}
```

The source POSTs one event at a time through the project's attributed egress.
The 2xx response alone is the acknowledgement (`confirmed_offset`); the
response body is discarded. Webhook delivery is at-least-once, so a remote
processor must deduplicate by `(streamId, offset)`. A `jsonataTransform`
reshapes the POSTed event body while the envelope keeps the real source
coordinates.

## Events marked ephemeral

`append({ ..., ephemeral: true })` assigns a real offset but never writes the
event body to Durable Object SQLite. The current Durable Object incarnation
keeps up to 10 MiB of serialized ephemeral events in memory and evicts the
oldest first. A restart forgets the complete buffer. Never derive durable
product truth from an ephemeral event.

- Range reads exclude it unless `includeEphemeral: true`; those reads merge
  currently buffered ephemeral events with durable rows in offset order.
- Point reads by offset may return it while it remains buffered. Ephemeral
  events cannot have idempotency keys.
- A session callback replays currently buffered ephemeral events after its
  cursor and then receives new ones live. Browser catch-up requests this
  ephemeral-inclusive view for its in-memory UI projection.
- Durable subscriptions never deliver it.
- Stream control events cannot be ephemeral.
- One ephemeral event larger than the complete memory budget rejects its
  append before an offset is consumed.

Emit a separate durable result after transient progress:

```ts
await stream.append({
  type: "events.example/response-chunk",
  ephemeral: true,
  payload: { chunk },
});

await stream.append({
  type: "events.example/response-completed",
  payload: { text },
});
```

Forgotten ephemeral events leave valid offset gaps. A small SQLite metadata
row durably records the highest assigned offset so those offsets are never
reused; it contains no ephemeral event type, payload, metadata, or body.
Rebuilding core state counts durable events instead of assuming
`eventCount === maxOffset`.

## Product-event retries and cursors

`stream-event-sender.ts` reads after each durable cursor, applies the filter,
sends a bounded batch, and records progress in ONE column whose meaning never
varies by receiver kind: `confirmed_offset` (the far side durably claims
through here). Push kinds write it with the awaited acknowledgement; a hosted
processor's reported checkpoints write it, while its live batch acks only
settle the in-flight watchdog. The one scheduling rule, for every kind:
delivery RESUMES after `confirmed_offset` — anything sent but never confirmed
redelivers (at-least-once; receivers dedupe by `(streamId, offset)`).

Guarantees:

- Cursor advances are SQLite rows, not an event per batch.
- Halt, resume, seek, and removal are appended events.
- Non-matching events still advance the subscription cursor stored on the
  source stream.
- ITX calls, stream appends, and webhook responses are awaited.
- A send remembers the offset of the configuration or cursor-set event that
  chose its cursor, so its late acknowledgement cannot overwrite an operator's
  newer cursor change.
- Retries are bounded and visible; the final failure halts the subscription.
  After any batch failure the next read uses batch size 1, so a poison event
  cannot strand its healthy prefix.
- A Durable Object alarm starts due retries even when the source is quiet.
- `waitUntilProcessed(name, { offset, timeoutMs? })` on the Stream DO is the
  uniform barrier for every kind. Processor-wake rows delegate to the hosted
  runner's own barrier (precise even mid-connection); every other kind
  resolves off `confirmed_offset` — the awaited push acknowledgement.

Operator commands are literal:

```ts
await source.setSubscriptionCursor({ name, afterOffset });
await source.resumeSubscription({ name });
await source.setSubscriptionCursorAndResume({ name, afterOffset });
```

## The receiver's passive fence

Every delivered batch — and every committed copy's last `source.copiedFrom`
hop — carries the source lifetime (`streamId`, `streamCreatedAt`) and the
config generation (`cursorChangedAtSourceOffset`) of the delivery run that
produced it. The receiver keeps one record per `(source path, key)`, reduced
from those stamps, and rejects a batch whose stamp is strictly older: a
destructively-recreated stale source, or an in-flight batch from a superseded
configuration. Equal stamps are ordinary at-least-once redeliveries and
collapse on the per-event idempotency key.

There is no configure-time handshake, no receiver-side registry, and no
receiver confirmation: matching events start flowing as soon as the source
commits `subscription-configured`, and a broken receiver surfaces later as a
durable delivery halt.

If a copy would complete a cycle (the receiving stream already appears in
`source.copiedFrom`) or the chain has reached its hop bound, the receiver
acknowledges the event as dropped, the cursor advances past it, and the
receiver appends one idempotent `stream/error-occurred` line describing the
drop. That audit line is withheld from onward copy delivery so a reciprocal
wildcard pair cannot manufacture audit events forever. Incarnation and
connection lifecycle facts (`stream/woken`, `stream/connection-opened`,
`stream/connection-closed`) are withheld from copy delivery for the same
reason: every boot appends a fresh unkeyed `woken`, a copy delivery can
itself boot the hibernated peer, and the circuit breaker deliberately ignores
control events — so a reciprocal pair would otherwise manufacture wake events
forever. A foreign incarnation's lifecycle is not product data; local readers
of the source stream see those events unchanged.

Public `append()` cannot author `source.copiedFrom`. Only trusted Stream
Durable Object calls can.

## Received control events are data, not commands

If one stream sends an `events.iterate.com/stream/*` event as matching product
event, the receiver stores it but does not execute its control behavior. Only a
first-hand control event may configure, pause, resume, halt, or change a
cursor.

## Processor hosting

Durable Object domains host processors with `createStreamProcessorHost`:

```ts
export class RepoDurableObject extends DurableObject<Env> {
  readonly #host = createStreamProcessorHost(this.ctx, {
    stream: new StreamRpcTarget({ auth, projectId, path }),
    version: workerVersion(this.env),
  });

  readonly #repo = this.#host.add((deps) => new RepoProcessor({ ...deps, github }));

  wakeStreamProcessor(args: StreamProcessorWakeRequest) {
    return this.#host.wakeStreamProcessor(args);
  }
}
```

The wake result transfers live callback capabilities to the stream. Workers RPC
ownership rules determine when those capabilities are duplicated or disposed;
they are never persisted.

## Project-default receivers

Every non-root project stream starts with ordinary ITX subscriptions:

- `project-worker`, from the beginning, skips one repeatedly failing event;
- `iterate-platform-posthog` when configured, from the beginning, halts on a
  repeatedly failing event.

They use the same configuration event, cursor storage, filter, batching, and retry
code as authored ITX receivers.

The root `/` stream is the deliberate exception. The project creation saga
waits for the trusted config-repo template worker to build, then atomically
appends the `project-worker` receiver with `start: "now"`, terminal
`project/created`, and the first `project/worker-updated`. Delaying that
subscription prevents the stream from classifying the worker as unavailable
during its initial build. Creation does not wait for userspace to consume a
platform creation event. Later config commits and all other root facts use the
ordinary feed; if a later worker build is in progress, delivery retries without
advancing its cursor.

## Testing

Add public connection and subscription behavior to the single readable suite:

`apps/os/e2e/vitest/stream-connections-and-subscriptions.e2e.test.ts`

Use focused unit tests only for pure reducers, storage indexes and retry rows,
alarm/watchdog behavior, or receiver batch construction.

## File map

| File                                                         | What it does                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `stream-durable-object.ts`                                   | Appends events, exposes stream methods, calls receivers, and starts post-commit reconciliation   |
| `core-processor-contract.ts`                                 | Declares stream control events and reduced state                                                 |
| `core-processor.ts`                                          | Validates and reduces core events without making calls                                           |
| `stream-storage.ts`                                          | Stores the event log and delivery cursors                                                        |
| `stream-event-sender.ts`                                     | Opens live callbacks, sends events for durable subscriptions, and owns their cursors and retries |
| `retained-event-callbacks.ts`                                | Retains and releases session and hosted-processor callback capabilities                          |
| `copy-appends.ts`                                            | Builds copied events, enforces the inbound stamp fence, and suppresses cycles                    |
| `event-filter.ts`                                            | Compiles and evaluates event-type and JSONata filters                                            |
| `packages/iterate/src/processors/stream-processor.ts`        | Defines the processor class and its event-handling helpers                                       |
| `packages/iterate/src/processors/stream-processor-runner.ts` | Folds hosted processor events and stores checkpoints                                             |

The public stream surface is written in `src/rpc-targets.ts` and generated into
`src/itx-api.generated.ts` and `packages/iterate/src/itx-api.generated.ts`.
