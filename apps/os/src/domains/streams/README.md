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
  subscriptionKey: "github-for-reviewer",
  filter: {
    eventTypes: ["events.iterate.com/github/webhook-received"],
    condition: 'payload.body.repository.full_name = "acme/widgets"',
  },
});
```

The source stores the subscription and product-event cursor. The receiver stores
the complete copy list copied from that source.
Every copied event is a normal append with its immediate source
path, stream lifetime ID, creation time, offset, type, timestamp, and subscription
key in `source.copiedFrom`.
That record proves the event travelled through that configured stream
delivery; it is not proof of who originally appended the source event.

An optional JSONata transform constructs the copied event before the
platform adds that source information:

```ts
await agentStream.subscribeToEventsFrom({
  sourceStreamPath: "/integrations/github/main",
  idempotencyKey: "reviewer/github-transform/v1",
  filter: { eventTypes: ["events.iterate.com/github/webhook-received"] },
  transform:
    '{ "type": "events.example/pull-request-opened", "payload": { "repo": payload.body.repository.full_name } }',
});
```

An idempotency key based on the source stream's random lifetime ID, path,
subscription key, source offset, and the configure-or-cursor-change event makes
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
        source: { projectId, path, streamId, streamCreatedAt },
        sourceOffset,
        byKey: {
          [subscriptionKey]: {
            configuration,
            configuredAtSourceOffset,
            numEventsReceived,
            numEventsDropped,
            lastEventReceivedAt?,
          },
        },
      },
    },
  },
  outbound: {
    byKey: {
      [subscriptionKey]: {
        configuration,
        configuredAtOffset,
        configuredAt,
        cursorSet?: { afterOffset, setAtSourceOffset },
        deliveryHalted?,
      },
    },
  },
},
copyListDeliveriesByReceivingStream: {
  [receivingStreamPath]:
    | { sourceOffset, status: "pending", subscriptionKeysRecordedByReceiver }
    | { sourceOffset, status: "confirmed", subscriptionKeysRecordedByReceiver }
    | {
        sourceOffset,
        status: "blocked",
        attempts,
        error,
        blockedAt,
        subscriptionKeysRecordedByReceiver,
      },
}
```

Acknowledged offsets, retry times, live callbacks, and measurements live in runtime
state. They do not repeat durable configuration. Complete copy-list work
is separate because sending an empty list is how the source removes its final
subscription from a receiving stream.

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
    condition: "payload.visible = true",
  },
  processEventBatch,
});
```

The callback exists only for that RPC session. Calling `connection.close()`,
disposing it, or disconnecting closes it. No subscription is appended.

## Subscription actions

Every durable subscription begins with
`subscription-configured` on its source.

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
  processorSlug: "agent",
}
```

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
  transform?,
  delivery: {
    start: "now",
    onFailingEvent: "halt",
    includeEphemeral: false,
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
    includeEphemeral: false,
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
    includeEphemeral: false,
  },
}
```

The source POSTs one event at a time. A successful response accepts that event.

## Events marked ephemeral

`append({ ..., ephemeral: true })` writes an offset-ordered row that may later
be deleted. Never derive durable product truth from it.

- Range reads exclude it unless `includeEphemeral: true`.
- Point reads may return it while the row still exists.
- A session callback sees it only when it is appended after that callback
  opens; it is never replayed during session catch-up.
- Hosted processors always exclude it.
- A copy, ITX-call, or webhook subscription includes it only when its
  delivery policy opts in.
- Stream control events cannot be ephemeral.

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

Deleting ephemeral rows can leave valid offset gaps. The allocator floor must
survive deletion, and rebuilding state counts surviving events instead of
assuming `eventCount === maxOffset`.

## Product-event retries and cursors

`stream-event-sender.ts` reads after each durable cursor, applies the filter,
sends a bounded batch, and advances the cursor only after the receiver call returns.

Guarantees:

- Cursor advances are SQLite rows, not an event per batch.
- Halt, resume, seek, completion, and removal are appended events.
- Non-matching events still advance the subscription cursor stored on the
  source stream.
- ITX calls, stream appends, and webhook responses are awaited.
- A send remembers the offset of the configuration or cursor-set event that
  chose its cursor, so its late acknowledgement cannot overwrite an operator's
  newer cursor change.
- Retries are bounded and visible; the final failure halts the subscription.
- A Durable Object alarm starts due retries even when the source is quiet.

Operator commands are literal:

```ts
await source.setSubscriptionCursor({ subscriptionKey, afterOffset });
await source.resumeSubscription({ subscriptionKey });
await source.setSubscriptionCursorAndResume({ subscriptionKey, afterOffset });
```

## Recording the current copy list on a receiving stream

`subscribeToEventsFrom()` causes this append sequence:

```text
source stream                               receiving stream

subscription-configured
       |
       +---- complete current list ------> copy-list-recorded
       |
copy-list-confirmed
```

The receiver event contains every current subscription from that source to that
receiver. Removal sends a new list without the key; an empty list
deletes that source from receiver reduced state.

The list carries the source event offset that produced it. A receiver ignores
an older offset, so delayed calls cannot restore removed keys or erase newer
ones. If a key moves from receiver A to B, the command waits until A records a
list without it and B records a list with it.

Product events do not start until
`copyListDeliveriesByReceivingStream[receivingStreamPath].status` is
`"confirmed"`. The source's reduced state records whether each complete list is pending, confirmed, or
blocked. The SQLite retry row only schedules attempts and does not move the
product-event cursor. After a key moves from A to B, delivery to B also waits
until no other receiver's last acknowledged key list still contains it. The
complete-list copies themselves remain independent, so unrelated removals do
not block one another.

That old-stream gate also covers a replacement webhook, ITX expression, or
hosted processor: no call reaches the new receiver while an old stream still
records the key. Reconfiguring or removing a key refreshes every old stream
whose last acknowledged list still contains it, even if that path was blocked
during an earlier move. A blocked old path deliberately stops the cutover until
an explicit resend succeeds.

```ts
await source.resendCopyList({ receivingStreamPath });
```

After bounded failures, the source appends `copy-list-delivery-blocked` for that
receiving-stream path. The subscription itself is not halted: product delivery simply
cannot start until the receiver records the list. This command appends
`copy-list-resend-requested`, creates a new pending generation, and retries
the newest complete list.

Public `append()` cannot author either copy-list record, dropped-event
records, or `source.copiedFrom`. Only trusted Stream Durable Object calls can.

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

Each project stream starts with ordinary ITX subscriptions:

- `project-worker`, from the beginning, skips one repeatedly failing event;
- `iterate-platform-posthog` when configured, from the beginning, halts on a
  repeatedly failing event.

They use the same configuration event, cursor storage, filter, batching, and retry
code as authored ITX receivers.

## Testing

Add public connection and subscription behavior to the single readable suite:

`apps/os/e2e/vitest/stream-connections-and-subscriptions.e2e.test.ts`

Use focused unit tests only for pure reducers, storage indexes and retry rows,
alarm/watchdog behavior, or receiver batch construction.

## File map

| File                                                         | What it does                                                                       |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `stream-durable-object.ts`                                   | Appends events, exposes stream methods, and starts post-commit reconciliation      |
| `core-processor-contract.ts`                                 | Declares stream control events and reduced state                                   |
| `core-processor.ts`                                          | Validates and reduces core events without making calls                             |
| `stream-storage.ts`                                          | Stores the event log, delivery cursors, and list-send retries                      |
| `stream-connections.ts`                                      | Opens live callbacks, replays history, and sends newly appended events             |
| `copy-list-sender.ts`                                        | Sends complete copy lists to streams and owns bounded list-send retries            |
| `copy-list-retry-store.ts`                                   | Reads and updates one list-send retry row per receiver path                        |
| `stream-event-sender.ts`                                     | Sends events for durable subscriptions and owns their cursors, retries, and expiry |
| `subscription-receiver-calls.ts`                             | Calls hosted processors, ITX methods, receiving streams, and webhooks              |
| `retained-event-callbacks.ts`                                | Retains and releases session and hosted-processor callback capabilities            |
| `copy-appends.ts`                                            | Builds copied events, source information, idempotency keys, and cycle suppressions |
| `event-filter.ts`                                            | Compiles and evaluates event-type and JSONata filters                              |
| `packages/iterate/src/processors/stream-processor.ts`        | Defines the processor class and its event-handling helpers                         |
| `packages/iterate/src/processors/stream-processor-runner.ts` | Folds hosted processor events and stores checkpoints                               |

The public stream surface is written in `src/rpc-targets.ts` and generated into
`src/itx-api.generated.ts` and `packages/iterate/src/itx-api.generated.ts`.
