# Ways to receive stream events

Status: implemented.

This page starts with use cases. For the exact events, append order, reduced
state, retries, and repair behavior, see
[Subscription events and state](./stream-subscription-events-and-state.md).
The real-deployment coverage lives in
[`stream-connections-and-subscriptions.e2e.test.ts`](../e2e/vitest/stream-connections-and-subscriptions.e2e.test.ts).

## The two mechanisms

A stream can send events in two fundamentally different ways:

1. `openConnection()` keeps a callback open for one RPC session. The callback
   disappears when the session closes. The caller remembers where to reconnect.
2. `subscription-configured` stores a durable instruction on the source stream.
   It survives disconnects and Durable Object restarts. Either the source or a
   hosted processor remembers the completed source offset.

Both mechanisms filter events and call a receiver, but they have different
ownership and recovery behavior. A live callback is not a short-lived durable
subscription, and a durable subscription is not represented by an open callback.

The independent choices are:

- which source events match (`filter`);
- whether rows appended with `ephemeral: true` are eligible;
- where reading begins;
- what receives the events;
- who stores the completed source offset;
- what happens when the receiver repeatedly fails;
- and whether the subscription removes itself after a condition is met.

## Supported uses

| Use                            | Stored on source | Completed offset stored by | Start position            | Receives ephemeral events |
| ------------------------------ | ---------------- | -------------------------- | ------------------------- | ------------------------- |
| New browser events             | no               | browser/client             | when callback opens       | yes, while open           |
| Replay then new browser events | no               | browser/client             | explicit offset           | new ephemeral events only |
| State-only live view           | no               | browser/client             | when callback opens       | not applicable            |
| `waitForEvent()`               | no               | caller                     | now or explicit offset    | new ephemeral events only |
| Hosted processor               | yes              | hosted processor           | its checkpoint            | no                        |
| Cross-post to another stream   | yes              | source stream              | beginning, now, or offset | opt-in                    |
| Call an ITX method             | yes              | source stream              | beginning, now, or offset | opt-in                    |
| POST a webhook                 | yes              | source stream              | beginning, now, or offset | opt-in                    |

Only `cross-post` copies subscription information to another stream. An ITX
method, webhook, and hosted processor have no receiving stream on which to
record an inbound subscription.

## Live callbacks

### Receive new events until this session closes

```ts
using connection = await stream.openConnection({
  connectionKey: "browser",
  processEventBatch(batch) {
    render(batch.events);
  },
});
```

The callback receives events appended after it opens. Disposing the handle,
calling `close()`, replacing the same connection key, losing the RPC session,
or restarting the Stream Durable Object closes it.

The open callback exists in runtime state. The stream appends
`connection-opened` and usually `connection-closed` audit events, but it does
not append `subscription-configured`.

### Replay durable rows, then stay connected

```ts
using connection = await stream.openConnection({
  connectionKey: "browser",
  replayAfterOffset: lastSeenOffset,
  filter: {
    eventTypes: ["events.example/message-created"],
    condition: "payload.channel = 'support'",
  },
  processEventBatch,
});
```

`replayAfterOffset` is exclusive. The stream first sends matching durable rows
after that offset and then sends new appends without a gap. Historical
ephemeral rows are never replayed; a matching ephemeral event appended after
this exact callback opens can still be sent.

The caller may also fence a reconnect to one physical stream and cap its replay:

```ts
using connection = await stream.openConnection({
  connectionKey: "browser",
  replayAfterOffset: lastSeenOffset,
  expectedStreamId,
  maxReplayOffsetGap: 1_000,
  processEventBatch,
});
```

A stream-ID mismatch, invalid cursor, or excessive replay gap rejects before an
existing callback with the same key is replaced.

### Watch reduced state without receiving events

```ts
using connection = await stream.openConnection({
  events: false,
  processEventBatch(batch) {
    renderState(batch.state);
  },
});
```

Every callback batch has `events: []`. Rapid appends may be coalesced into one
newest state update.

### Wait for one matching event

```ts
const event = await stream.waitForEvent({
  afterOffset,
  eventTypes: ["events.example/build-finished"],
  predicate: (candidate) => candidate.payload?.buildId === buildId,
  timeoutMs: 30_000,
});
```

This is a temporary live callback. It is useful when the caller can try again
after disconnecting. A durable “wake me later” workflow should store a
subscription (and use the scheduler for a durable timeout), not hide durable
work inside `waitForEvent()`.

## Durable subscriptions

Every durable subscription begins with one event on the stream whose events
will be read:

```ts
await source.append({
  type: "events.iterate.com/stream/subscription-configured",
  payload: {
    subscriptionKey: "orders-for-warehouse",
    filter: {
      eventTypes: ["events.example/order-created"],
      condition: "payload.region = 'eu'",
    },
    receiver: {
      // exactly one action
    },
  },
});
```

The four actions are deliberately concrete:

- `cross-post`: append copies to another stream;
- `itx-call`: call an ITX method with event batches;
- `webhook-post`: make an HTTP POST;
- `processor-wake`: ask a hosted processor for its checkpoint and callback.

There is no `subscribeTo()` API with an implicit direction. Cross-post setup is
called on the receiving stream and explicitly names the source. The other
actions are source-side event configuration because they do not have a
receiving stream capability.

## Cross-post matching events to another stream

Call `receiveCrossPostsFrom()` on the stream that should receive the appended
copies:

```ts
const receiver = project.streams.get("/agents/reviewer");

const configured = await receiver.receiveCrossPostsFrom({
  sourceStreamPath: "/integrations/github/main",
  subscriptionKey: "github-for-reviewer",
  description: "Copy pull-request webhooks to the reviewer agent.",
  filter: {
    eventTypes: ["events.iterate.com/github/webhook-received"],
    condition:
      'payload.delivery.name = "pull_request" and payload.body.repository.full_name = "acme/widgets"',
  },
  start: "now",
  includeEphemeral: false,
});
```

The roles are visible in the call:

- `receiver` is the stream on which the method is invoked;
- `sourceStreamPath` is the stream whose events are read.

The source and receiver must be in the same project. An agent can call this
itself through its project stream catalog and may name any two streams that its
project authority can access.

The result exposes the three committed facts for the named receiver:

```ts
configured.subscriptionKey;
configured.subscriptionConfiguredEvent; // source stream
configured.crossPostListRecordedEvent; // receiving stream
configured.crossPostListConfirmedEvent; // source stream
```

The method does not report success after only changing the source. It waits
until the receiving stream has stored the source's complete current cross-post
list and the source has committed the confirmation. Replacing a key that
previously sent to another stream also records and confirms that old stream's
replacement list before returning; those additional audit events remain in the
two event logs rather than being duplicated in this result.

### Default behavior

The smallest generated-key call supplies the source and a retry identity:

```ts
const configured = await receiver.receiveCrossPostsFrom({
  sourceStreamPath: "/all-events",
  idempotencyKey: "reviewer/all-events/v1",
});
```

The defaults are:

- all event types;
- `start: "now"`;
- `includeEphemeral: false`;
- no transform;
- no automatic removal;
- halt after bounded failures, because a cross-post may not silently leave a
  hole in the receiving stream.

With no caller-supplied key, the source derives the effective key from the
committed configuration event:

```text
subscription:<subscription-configured event offset>
```

For example, a configuration committed at source offset 42 is
`subscription:42`.

### Key and retry behavior

`subscriptionKey` is local to the source stream.

- Supplying a key means “ensure or replace this source subscription.”
- Omitting it means “create another subscription.”
- Fresh subscriptions cannot claim the `subscription:` prefix.
- A generated key is never guessed from a pre-read stream head. It is derived
  only after the configuration event has committed.
- A generated key may not collide with a live callback key.
- A generated-key setup requires `idempotencyKey`, because the source commit
  may succeed before the receiver handshake or its RPC response fails.
- The returned generated key can be passed back as `subscriptionKey` to
  replace or move that same subscription. It cannot name a different or
  already-removed subscription.

When a caller omits `subscriptionKey`, it supplies an event `idempotencyKey`:

```ts
await receiver.receiveCrossPostsFrom({
  sourceStreamPath: "/all-events",
  idempotencyKey: "reviewer/all-events/v1",
});
```

Retrying that call returns the same configuration event and therefore the same
generated subscription key, including when the first call failed after the
source commit. Omitting both is rejected before anything is appended. Two
different idempotency keys create two different generated subscriptions.

### Transform the copied event

```ts
await receiver.receiveCrossPostsFrom({
  sourceStreamPath: "/raw-readings",
  idempotencyKey: "normalized-readings/v1",
  filter: { eventTypes: ["events.example/raw-reading"] },
  transform: `{
    "type": "events.example/reading",
    "payload": { "value": payload.celsius }
  }`,
});
```

The JSONata expression constructs `{ type?, payload?, metadata? }`. The
platform adds `source.crossPostedFrom` afterwards.

### Stop receiving

```ts
const result = await receiver.stopReceivingCrossPostsFrom({
  sourceStreamPath: "/integrations/github/main",
  subscriptionKey: "github-for-reviewer",
});
```

The source appends `subscription-removed`, sends a complete replacement list,
the receiver appends `cross-post-list-recorded`, and the source appends
`cross-post-list-confirmed`. A repeated call returns
`{ status: "already-absent" }` only when no further receiver update is owed.

## Call an ITX method

Append the subscription on the source:

```ts
await source.append({
  type: "events.iterate.com/stream/subscription-configured",
  payload: {
    subscriptionKey: "tasks-for-worker",
    filter: { eventTypes: ["events.example/task-created"] },
    receiver: {
      action: "itx-call",
      expression: ["workers", ["get", workerRef], "processEventBatch"],
      delivery: {
        start: "beginning",
        includeEphemeral: false,
        onFailingEvent: "halt",
      },
    },
  },
});
```

The source stores the completed offset. It evaluates the expression with the
source's authority, awaits the final method call, and advances only after that
call accepts the batch.

`onFailingEvent: "skip"` is available for feeds where one permanently bad event
must not stop later events. It isolates the failing event, records the failure,
and advances past it. Use `"halt"` when skipping would lose required work.

## POST a webhook

```ts
await source.append({
  type: "events.iterate.com/stream/subscription-configured",
  payload: {
    subscriptionKey: "ops-webhook",
    receiver: {
      action: "webhook-post",
      url: "https://hooks.example.com/iterate",
      delivery: {
        start: "now",
        includeEphemeral: false,
        onFailingEvent: "halt",
      },
    },
  },
});
```

The source POSTs one matching event at a time and advances only after a
successful response. Webhook subscriptions require a project-scoped source
stream.

## Wake a hosted processor

```ts
await source.append({
  type: "events.iterate.com/stream/subscription-configured",
  payload: {
    subscriptionKey: "agent-processor",
    receiver: {
      action: "processor-wake",
      expression: ["agents", ["get", "/agents/reviewer"], "processor", "wakeStreamProcessor"],
      processorSlug: "agent",
    },
  },
});
```

This is a wrapper around the same callback-batch mechanism used by a live
connection:

1. the source calls the wake expression;
2. the hosted object returns its committed checkpoint and a callback;
3. the source retains that callback and sends ordered batches;
4. the hosted processor commits its checkpoint together with its own reduced
   state.

Because the hosted processor stores the checkpoint, its subscription has no
`delivery.start` on the source stream and never includes ephemeral rows. The source
stream's random `streamId` fences the checkpoint against a deleted and
recreated stream at the same path.

## Filters, start positions, ephemeral rows, and automatic removal

These are independent properties of a durable subscription.

### Filter

```ts
filter: {
  eventTypes: ["events.example/order-created"],
  condition: "payload.total > 100",
}
```

Omitting `filter` selects every type. `eventTypes` narrows by type. `condition`
is JSONata over the complete event and must evaluate to exactly `true`.

### Start position

Cross-post, ITX-call, and webhook actions use one of:

```ts
start: "beginning"; // after offset 0
start: "now"; // after the configuration event
start: {
  afterOffset: 42;
} // exclusive
```

Changing a cursor stored on the source stream later is explicit:

```ts
await source.setSubscriptionCursor({ subscriptionKey, afterOffset: 42 });
await source.resumeSubscription({ subscriptionKey });
await source.setSubscriptionCursorAndResume({ subscriptionKey, afterOffset: 42 });
```

### Ephemeral rows

`includeEphemeral` controls whether a cross-post, ITX-call, or webhook action
may read currently retained ephemeral rows. It does not make those rows durable. A hosted
processor always excludes them. A live callback can see only ephemeral events
appended while that exact callback is open.

### Automatic removal

```ts
endWhen: {
  any: [
    { kind: "acknowledged-events", count: 100 },
    { kind: "source-offset-acknowledged", offset: 50_000 },
    { kind: "time", at: "2026-07-22T09:00:00.000Z" },
  ],
}
```

The first satisfied condition appends `subscription-removed`. Event-count and
source-offset conditions are valid only when the source owns the cursor.
Hosted processors may use only a time condition.

## Cross-post provenance and loop prevention

Every copied event records its immediate source in `source.crossPostedFrom`:

```ts
{
  projectId,
  path,
  streamId,
  streamCreatedAt,
  offset,
  type,
  createdAt,
  subscriptionKey,
  cursorChangedAtSourceOffset,
}
```

This proves which source event the platform copied through which subscription.
It does not authenticate who originally authored the source event.

If a reciprocal cross-post would send an event back through a stream already in
that array, the receiver acknowledges it as dropped with reason `cycle`.
Cross-post chains are also bounded; the next copy is acknowledged as dropped
with reason `hop-limit`. Both outcomes append
`cross-posted-events-dropped` instead of retrying forever.

## Failure boundaries

- Invalid filters, transforms, URLs, expressions, cursor positions, and
  unsupported receiver combinations reject before configuration commits.
- Receiver calls and retries happen after the configuration event commits.
- Selected-event retries are bounded. Exhaustion appends
  `subscription-delivery-halted`.
- Cross-post-list retries are separate from matching-event retries. Exhaustion
  appends `cross-post-list-delivery-blocked`.
- After fixing a blocked receiving stream, call
  `source.resendCrossPostList({ receivingStreamPath })`.
- No error is swallowed, retried forever, or represented only by a volatile
  scheduler row.
