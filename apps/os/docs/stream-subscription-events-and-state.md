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
- **stamp**: the source lifetime (`streamId`, `streamCreatedAt`) and config
  generation (`cursorChangedAtSourceOffset`) carried on every delivery and on
  every committed copy's `source.copiedFrom` hop;
- **connection**: one currently retained event-batch callback;
- **delivery**: one awaited receiver call for matching events;
- **wake**: a call that asks a hosted processor for its checkpoint and callback.

The subscription lives entirely on the source. `subscription-configured` is
the source-side fact that enables sending; there is no receiver-side
registration, handshake, or confirmation. A receiving stream learns about a
subscription when its first copy arrives.

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
    receiver:
      | {
          action: "processor-wake";
          expression: ItxExpression;
          processorSlug?: string;
        }
      | {
          action: "copy-to-stream";
          receivingStreamPath: string;
          delivery: {
            start: "beginning" | "now";
            onFailingEvent: "halt";
          };
        }
      | {
          action: "itx-call";
          expression: ItxExpression;
          delivery: {
            start: "beginning" | "now";
            onFailingEvent: "halt" | "skip";
          };
        };
  };
};
```

This is the sole event that enables delivery. The `action` union prevents
invalid combinations: a hosted processor cannot carry a start position stored
by the source stream, and an ordered copy cannot skip a permanently
failing event. Durable subscriptions never deliver ephemeral rows.

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
  subscription key, so a retried call cannot create a duplicate;
- a fresh caller may not claim the reserved `subscription:` prefix;
- the returned generated key may replace or move that existing subscription,
  and reduced state remembers that the key was generated;
- neither explicit nor generated subscription keys may collide with a live
  session connection key.

The original keyless event remains keyless. Reduced outbound state stores the
effective key inside its normalized configuration.

## Stamps and the passive inbound fence

`subscribeToEventsFrom()` is called on the receiving stream, but the only
control event it appends is the source's `subscription-configured`. It
returns:

```ts
{
  subscriptionKey,
  subscriptionConfiguredEvent,
}
```

Matching event copies then flow directly:

```text
source stream                              receiving stream

subscription-configured
      |
      +---- matching event copies -------> ordinary appended events
```

Every delivered batch — and every committed copy's last `source.copiedFrom`
hop — carries the stamp of the delivery run that produced it: the source
lifetime (`streamId`, random per storage creation, plus `streamCreatedAt`,
which orders destructive recreations) and the config generation
(`cursorChangedAtSourceOffset`, the offset of the configure or cursor-set
event that started the run).

The receiver keeps one passive record per `(source path, subscription key)`,
reduced from those stamps on its own committed copies. Before committing a
batch it compares the batch stamp to the record and rejects a stamp that is
strictly older:

- an older source lifetime (a batch from a destructively-recreated stale
  source Durable Object);
- an older config generation of the same lifetime (an in-flight batch from a
  superseded configuration landing after the replacement started delivering).

Equal stamps are accepted — that is the ordinary at-least-once redelivery,
which the per-event idempotency key then collapses. Newer stamps are accepted
and the reducer updates the record from the committed events, so a rebuild or
replay reconstructs the fence identically.

Because configure is no longer confirmed end-to-end, a broken receiver
surfaces later as a durable delivery halt (which has a UI lane) instead of a
configure-time error, and an in-flight batch can land on a receiver shortly
after the source removed or moved the subscription (bounded by the delivery
timeout).

## Removal

Removing one subscription appends on the source:

```ts
type SubscriptionRemoved = {
  type: "events.iterate.com/stream/subscription-removed";
  payload: {
    subscriptionKey: string;
    reason: "requested";
  };
};
```

There is no receiver-side removal: the receiver's passive record simply stops
being updated. Reusing the same key for a different receiving stream is a new
delivery run with a newer config generation; the old receiver's record stays
behind as inert history.

## Core reduced state

The durable, replayable state has one subscription hierarchy:

```ts
subscriptions: {
  inbound: {
    bySourcePath: {
      [sourcePath: string]: {
        [subscriptionKey: string]: {
          streamId: string;
          streamCreatedAt: string;
          cursorChangedAtSourceOffset: number;
          numEventsReceived: number;
          lastEventReceivedAt?: string;
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

On a receiving stream, `inbound.bySourcePath` holds the passive fence records:
the last accepted stamp per `(source path, key)` plus two counters that exist
only for the debug card (`numEventsReceived`, `lastEventReceivedAt`). They are
derived entirely from committed copied events; the receiver stores no
configuration for a source subscription.

On a source stream, `outbound.byKey` contains every durable subscription,
regardless of action.

## Runtime state

Mutable send progress is intentionally separate from replayed product state:

```ts
runtime: {
  subscriptions: {
    [subscriptionKey: string]: {
      acknowledgedOffset: number;
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
not represented only by a log line or volatile retry row. After any batch
failure the next read uses batch size 1 (isolate-or-progress): healthy
prefixes commit one event at a time until the failing event retries alone,
resetting to the full batch limit on success.

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

The receiver's validation is: copy authority (only trusted stream delivery
may append `source.copiedFrom`), the stamp fence described above, the
cycle/hop guard, and per-event idempotency identity.

Network retries in one send run use the same receiving-stream append identity.
Recreating the source, replacing the same key, or explicitly setting its cursor
starts a new run and may intentionally append an old source offset again.

If the hop array already contains the receiving stream, or the chain has
reached the hop bound, the receiver drops the event instead of appending it:
the drop is a terminal acknowledgement (retrying immutable provenance can
never make the event deliverable), the source cursor advances past it, and
the receiver appends one idempotent `stream/error-occurred` line describing
the drop (source path, key, count, offsets). That audit line is excluded from
onward copy delivery so a reciprocal wildcard pair cannot manufacture audit
events forever.

## Authority boundaries

Public callers may append `subscription-configured`, `subscription-removed`,
cursor, and resume requests subject to contract validation.

Only trusted stream internals may append:

- `subscription-delivery-halted`;
- an event carrying `source.copiedFrom`.

A copied `events.iterate.com/stream/*` event is data on the receiving stream. It
does not execute source-stream control behavior there.

## Bounds

The reducer rejects configuration that would exceed:

- 64 subscriptions from one source to one receiving stream;
- the retained core-state byte limit;
- the maximum `source.copiedFrom` hop count.

These checks run before committing the event that would exceed the bound.

## No compatibility layer

This is a clean event and state model. Old subscription event payloads, old
receiver discriminants, old reduced-state field names, and old subscription
tables are not read through aliases or migrated in place. Deploying this change
requires erasing and recreating every Stream Durable Object in the target
environment through normal APIs before the new worker serves traffic. That
includes project streams and deployment-wide streams whose `projectId` is
`null`.
