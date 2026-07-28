# Subscription events and state

Status: implemented.

This page describes the exact durable facts and reduced state behind
subscriptions. For examples organized by use case, see
[Ways to receive stream events](./stream-event-connections-and-subscriptions.md).

## Concrete terms

- **source stream**: the stream whose event log is read;
- **receiving stream**: a stream that appends matching copies from a source;
- **subscription**: one durable instruction stored on the source;
- **subscription key**: that instruction's source-local identity;
- **filter**: event types and/or a JSONata condition;
- **cursor**: the exclusive completed source offset stored by the source;
- **checkpoint**: the completed source offset stored with a hosted processor's
  reduced state;
- **copy list**: the complete current set of one source's subscriptions
  that target one receiving stream;
- **connection**: one currently retained event-batch callback;
- **delivery**: one awaited receiver call for matching events;
- **wake**: a call that asks a hosted processor for its checkpoint and callback.

There is no separate “outbound subscription event” and “inbound subscription
event” for one key. `subscription-configured` is the source-side fact that
enables sending. A receiving stream gets the source's complete copy list,
not a second independently managed subscription.

## The configuration event

Every durable subscription is enabled by this source-stream append:

```ts
type SubscriptionConfigured = {
  type: "events.iterate.com/stream/subscription-configured";
  idempotencyKey?: string;
  payload: {
    subscriptionKey?: string;
    description?: string;
    filter?: {
      eventTypes?: string[];
      condition?: string;
    };
    endWhen?: {
      any: Array<
        | { kind: "acknowledged-events"; count: number }
        | { kind: "source-offset-acknowledged"; offset: number }
        | { kind: "time"; at: string }
      >;
    };
    receiver:
      | {
          action: "processor-wake";
          expression: ItxExpression;
          processorSlug?: string;
        }
      | {
          action: "copy-to-stream";
          receivingStreamPath: string;
          transform?: string;
          delivery: {
            start: "beginning" | "now" | { afterOffset: number };
            includeEphemeral: boolean;
            onFailingEvent: "halt";
          };
        }
      | {
          action: "itx-call";
          expression: ItxExpression;
          delivery: {
            start: "beginning" | "now" | { afterOffset: number };
            includeEphemeral: boolean;
            onFailingEvent: "halt" | "skip";
          };
        }
      | {
          action: "webhook-post";
          url: string;
          delivery: {
            start: "beginning" | "now" | { afterOffset: number };
            includeEphemeral: boolean;
            onFailingEvent: "halt" | "skip";
          };
        };
  };
};
```

This is the sole event that enables delivery. The `action` union prevents
invalid combinations: a hosted processor cannot carry a start position stored
by the source stream, and an ordered copy cannot skip a permanently
failing event.

## How subscription keys behave

The effective identity is `(source stream, subscriptionKey)`.

If the payload supplies a key, configuring the same key means ensure or replace:

```text
effective key = payload.subscriptionKey
```

If the payload omits it, the reducer derives the key from the committed event:

```text
effective key = "subscription:" + event.offset
```

Consequences:

- key generation never races a pre-read stream head;
- two raw keyless configuration appends create two subscriptions;
- a keyless append with an `idempotencyKey` can be retried and returns the same
  committed event and generated key;
- `subscribeToEventsFrom()` requires that idempotency key when it generates the
  subscription key, because its source commit can precede a failed receiver
  handshake;
- a fresh caller may not claim the reserved `subscription:` prefix;
- the returned generated key may replace or move that existing subscription,
  and reduced state remembers that the key was generated;
- neither explicit nor generated subscription keys may collide with a live
  session connection key.

The original keyless event remains keyless. Reduced outbound state stores the
effective key inside its normalized configuration.

## Copy append order

`subscribeToEventsFrom()` is called on the receiving stream, but the first event
is appended to the source:

```text
source stream                              receiving stream

subscription-configured
      |
      +---- complete copy list ----> copy-list-recorded
      |
copy-list-confirmed
      |
      +---- matching event copies -------> ordinary appended events
```

For a new subscription or a same-receiver replacement, the method resolves
after these three control events have committed. It returns:

```ts
{
  subscriptionKey,
  subscriptionConfiguredEvent,
  copyListRecordedEvent,
  copyListConfirmedEvent,
}
```

Matching event delivery starts only after the source has reduced the matching
`copy-list-confirmed`.

Moving an existing key from receiver A to receiver B also appends and confirms
A's replacement list without the key. The method waits for that pair before
B's pair, while the returned `copyListRecordedEvent` and
`copyListConfirmedEvent` are B's events.

### `copy-list-recorded`

This platform-authored event is appended to the receiving stream:

```ts
type CopyListRecorded = {
  type: "events.iterate.com/stream/copy-list-recorded";
  payload: {
    source: {
      projectId: string | null;
      path: string;
      streamId: string;
      streamCreatedAt: string;
    };
    sourceOffset: number;
    subscriptionsByKey: {
      [subscriptionKey: string]: {
        configuredAtSourceOffset: number;
        configuration: {
          description?: string;
          filter?: {
            eventTypes?: string[];
            condition?: string;
          };
          endWhen?: SubscriptionEndCondition;
          transform?: string;
          delivery: {
            start: "beginning" | "now" | { afterOffset: number };
            includeEphemeral: boolean;
            onFailingEvent: "halt";
          };
        };
      };
    };
  };
};

type CommittedCopyListRecorded = CopyListRecorded & {
  idempotencyKey: string;
  offset: number;
  createdAt: string;
  path: string;
};
```

The payload is a complete replacement for this source, not a patch. Omitting a
key removes it. Sending `{ subscriptionsByKey: {} }` removes the final
subscription from that source.

The receiving copy contains only fields needed to explain and validate
copies. It does not repeat the source-only receiver address or mutable
cursor state.

`sourceOffset` orders list replacements. A delayed older call cannot restore a
removed key. `streamCreatedAt` and `streamId` order and distinguish deleted and
recreated source streams whose offsets restart.

### `copy-list-confirmed`

After the receiver returns its committed event, the source appends:

```ts
type CopyListConfirmed = {
  type: "events.iterate.com/stream/copy-list-confirmed";
  payload: {
    receivingStreamPath: string;
    sourceOffset: number;
    receivingStreamEvent: CommittedCopyListRecorded;
  };
};
```

Embedding the exact committed `copy-list-recorded` event gives the source
an immutable audit record of the other stream's append.

## Removal and moves

Removing one subscription appends on the source:

```ts
type SubscriptionRemoved = {
  type: "events.iterate.com/stream/subscription-removed";
  payload: {
    subscriptionKey: string;
    reason: "requested" | "completed" | "expired";
  };
};
```

For `copy-to-stream`, the source then sends a complete list without that key. There
is no separate per-key receiver removal event.

A public command may append only `reason: "requested"`. The source stream's
delivery code appends `completed` after a count/offset end condition is met and
`expired` after a time end condition is met. Validation rejects callers that
try to claim either automatic outcome.

Moving key `K` from receiving stream A to B changes two complete lists:

1. source appends the replacement `subscription-configured`;
2. A records a list without `K`;
3. B records a list with `K`;
4. source confirms both records.

The public configure call waits for A first and B second. Even if B happens to
record its list early, matching events do not go to B while another receiving
stream's last confirmed list still contains `K`. This makes a move observable
and prevents the same subscription from sending to both streams.

## Core reduced state

The durable, replayable state has one subscription hierarchy:

```ts
subscriptions: {
  inbound: {
    bySourcePath: {
      [sourcePath: string]: {
        source: {
          projectId: string | null;
          path: string;
          streamId: string;
          streamCreatedAt: string;
        };
        sourceOffset: number;
        byKey: {
          [subscriptionKey: string]: {
            configuration: RecordedSubscriptionConfiguration;
            configuredAtSourceOffset: number;
            numEventsReceived: number;
            numEventsDropped: number;
            lastEventReceivedAt?: string;
          };
        };
      };
    };
  };
  outbound: {
    byKey: {
      [subscriptionKey: string]: {
        configuration: EffectiveSubscriptionConfiguration;
        configuredAtOffset: number;
        configuredAt: string;
        subscriptionKeyWasGenerated?: true;
        cursorSet?: {
          afterOffset: number;
          setAtSourceOffset: number;
        };
        deliveryHalted?: {
          reason: "delivery-failed";
          afterOffset: number;
          attempts: number;
          error?: string;
        };
      };
    };
  };
};
```

On a receiving stream, `inbound.bySourcePath` answers “which source streams
copy here?” and `byKey` gives every subscription from each source.

On a source stream, `outbound.byKey` contains every durable subscription,
regardless of action. The subscription key is the common identifier on both
sides; inbound state first groups by source path because keys are only unique
within a source.

Received counters are properties of the inbound subscription:

- `numEventsReceived` counts copied events appended here;
- `numEventsDropped` counts source events acknowledged without appending
  because of a cycle or hop limit;
- `lastEventReceivedAt` records the most recent copied event's commit time.

## Copy-list work is separate

Sending a complete list is work even when that list is empty, so it is not
hidden inside `subscriptions.outbound.byKey`:

```ts
copyListDeliveriesByReceivingStream: {
  [receivingStreamPath: string]:
    | {
        sourceOffset: number;
        status: "pending";
        subscriptionKeysRecordedByReceiver: string[];
      }
    | {
        sourceOffset: number;
        status: "confirmed";
        subscriptionKeysRecordedByReceiver: string[];
      }
    | {
        sourceOffset: number;
        status: "blocked";
        attempts: number;
        error: string;
        blockedAt: string;
        subscriptionKeysRecordedByReceiver: string[];
      };
};
```

`subscriptionKeysRecordedByReceiver` is the key set from the last confirmed
list. It remains available while a newer list is pending or blocked, which is
what lets the source prevent delivery during a move.

This map is not a redundant outbound-subscription index:

- `subscriptions.outbound.byKey` answers what should receive matching events;
- `copyListDeliveriesByReceivingStream` answers which complete receiver
  updates are still owed.

## Runtime state

Mutable send progress is intentionally separate from replayed product state:

```ts
runtime: {
  subscriptions: {
    [subscriptionKey: string]: {
      acknowledgedOffset: number;
      acknowledgedEvents: number;
      lag: number;
      attempt: number;
      nextAttemptAt: number | null;
      inFlightDeadlineAt: number | null;
      lastError: string | null;
      bytesSent?: number;
      completionLatencyMs?: LatencyStats;
      deliveryDurationMs?: LatencyStats;
    };
  };
  connections: {
    [connectionKey: string]: ConnectionRuntimeState;
  };
  copyListRetries: {
    [receivingStreamPath: string]: {
      receivingStreamPath: string;
      sourceOffset: number;
      attempt: number;
      nextAttemptAt: number | null;
      lastError: string | null;
    };
  };
};
```

The core state records durable intent and final failure facts. SQLite rows
record the currently applied cursor, due retry time, and measurements. After
every commit and alarm, the Stream Durable Object repairs those rows from core
state. An interruption after committing a cursor event therefore cannot
silently lose the requested position.

## Matching-event delivery events

Actions whose cursor is stored by the source stream append these durable facts:

```ts
type SubscriptionCursorSet = {
  type: "events.iterate.com/stream/subscription-cursor-set";
  payload: {
    subscriptionKey: string;
    afterOffset: number;
  };
};

type SubscriptionDeliveryHalted = {
  type: "events.iterate.com/stream/subscription-delivery-halted";
  payload: {
    subscriptionKey: string;
    reason: "delivery-failed";
    afterOffset: number;
    attempts: number;
    error?: string;
  };
};

type SubscriptionDeliveryResumed = {
  type: "events.iterate.com/stream/subscription-delivery-resumed";
  payload: {
    subscriptionKey: string;
  };
};
```

`subscription-cursor-set` is exclusive and rejects an offset beyond the source
head. A receiver call that already started may finish, but its stale result
cannot advance the newer cursor.

Retries are bounded. Exhaustion appends `subscription-delivery-halted`; it is
not represented only by a log line or volatile retry row.

## Copy-list failure and repair events

List delivery has its own retry budget and events because it changes what the
receiving stream believes is configured:

```ts
type CopyListDeliveryBlocked = {
  type: "events.iterate.com/stream/copy-list-delivery-blocked";
  payload: {
    receivingStreamPath: string;
    sourceOffset: number;
    attempts: number;
    error: string;
  };
};

type CopyListResendRequested = {
  type: "events.iterate.com/stream/copy-list-resend-requested";
  payload: {
    receivingStreamPath: string;
  };
};
```

When retries exhaust, the source reduces the first event into a durable
`blocked` entry. Repeating the original configure call does not erase that
failure. After fixing the receiver, an operator calls:

```ts
await source.resendCopyList({ receivingStreamPath });
```

The resend event creates a new pending generation without changing any
matching-event cursor.

Only a bounded number of list sends run concurrently. Each call has a timeout,
retry delay, and watchdog alarm. Final failure remains visible until an
explicit resend succeeds.

## Copied event validation

Every delivered copy is an ordinary append on the receiving stream with an
additional immediate-source hop:

```ts
source: {
  copiedFrom: [{
    projectId,
    path,
    streamId,
    streamCreatedAt,
    offset,
    type,
    createdAt,
    subscriptionKey,
    cursorChangedAtSourceOffset,
  }],
}
```

The receiver accepts a batch only if its current inbound entry contains the
same source `streamId`, subscription key, and configuration offset. A stale
sender cannot continue after replacement or removal.

Network retries in one send run use the same receiving-stream append identity.
Recreating the source, replacing the same key, or explicitly setting its cursor
starts a new run and may intentionally append an old source offset again.

If the hop array already contains the receiving stream, the receiving stream
appends:

```ts
type CopiedEventsDropped = {
  type: "events.iterate.com/stream/copied-events-dropped";
  idempotencyKey: string;
  payload: {
    source: {
      projectId: string | null;
      path: string;
      streamId: string;
      streamCreatedAt: string;
    };
    subscriptionKey: string;
    reason: "cycle" | "hop-limit";
    count: number;
    firstOffset: number;
    lastOffset: number;
  };
};
```

The current implementation writes one event per dropped source event, so
`count` is `1` and `firstOffset` equals `lastOffset`. A cycle uses reason
`cycle`; reaching the hop bound uses `hop-limit`. In both cases the source
cursor advances exactly once instead of retrying an event that must never be
appended.

## Authority boundaries

Public callers may append `subscription-configured`, requested
`subscription-removed`, cursor, resume, and resend requests subject to contract
validation.

Only trusted stream internals may append:

- `copy-list-recorded`;
- `copy-list-confirmed`;
- `copy-list-delivery-blocked`;
- `subscription-delivery-halted`;
- completed or expired `subscription-removed`;
- `copied-events-dropped`;
- an event carrying `source.copiedFrom`.

A copied `events.iterate.com/stream/*` event is data on the receiving stream. It
does not execute source-stream control behavior there.

## Bounds

The reducer rejects configuration that would exceed:

- 1,000 distinct source streams recorded by one receiving stream;
- 64 subscriptions from one source to one receiving stream;
- the retained core-state byte limit;
- the maximum `source.copiedFrom` hop count.

These checks run before committing the event or receiver list that would exceed
the bound.

## No compatibility layer

This is a clean event and state model. Old subscription event payloads, old
receiver discriminants, old reduced-state field names, and old subscription
tables are not read through aliases or migrated in place. Deploying this change
requires erasing and recreating every Stream Durable Object in the target
environment through normal APIs before the new worker serves traffic. That
includes project streams and deployment-wide streams whose `projectId` is
`null`. Startup detects an old `events` table and fails with an explicit
recreation instruction; replaying core state cannot add the required SQLite
columns.
