it should be possible to create and manage subscriptions by appending a very small number of control events to a stream.

this document is now the proposed implementation spec, not just an exploration note.

## scope

subscriptions are for third-party integrations and long-running consumers:

- public webhooks
- worker self-binding paths
- other durable objects
- client-opened websockets into the stream durable object
- later: DO-initiated outgoing websocket targets

## proposed decisions

these are the defaults this task should assume unless we later explicitly change them.

1. a subscription is identified by a `slug`, scoped to a single stream
2. the stream DO owns the subscription cursor for server-managed subscriptions
3. control changes are appended as stream events
4. cursor movement is **not** appended as stream events
5. frequently changing delivery state lives in a mutable SQLite table
6. subscription config events should be full snapshots, not patches
7. the target representation should be an explicit tagged union
8. ack semantics should stay simple: `none`, `transport`, `explicit`
9. retries should be driven by a single DO alarm plus `next_attempt_at`
10. exhausted retries should pause the subscription rather than introduce more state-machine complexity

## why this shape fits the current code

the current stream implementation already has the right basic split:

- append-only `events`
- one mutable `reduced_state` row
- one DO per stream
- monotonic lexicographic offsets

subscriptions should mirror that pattern:

- control state is rare and event-shaped
- operational state is hot and mutable

the big design conclusion is:

- `subscription.set` and `subscription.deleted` belong in the stream log
- cursor movement, retry timing, and last error do **not**

if we appended a control event every time a cursor moved, the stream would become noisy and partly self-referential. that would also create awkward replay behavior and potential loops.

## first-class subscription shapes

these are the shapes the model should support cleanly.

| Shape              | Description                                                                     | Status                                      |
| ------------------ | ------------------------------------------------------------------------------- | ------------------------------------------- |
| inbound websocket  | consumer opens websocket into our DO, DO owns cursor, client sends ack messages | first-class                                 |
| webhook/http push  | DO posts to target URL or internal fetch-style endpoint                         | first-class                                 |
| internal DO target | DO calls another DO via binding + name + path                                   | first-class                                 |
| outgoing websocket | DO opens websocket to external server and pushes events                         | supported by model, but operationally later |

important platform note:

- inbound websocket connections into a DO can use Cloudflare websocket hibernation
- outbound websocket client connections from a DO do **not** currently hibernate the same way

so outbound websocket targets are real, but they should be treated as reconnecting live sessions, not hibernating durable pipes.

## target representation

the target model should stay explicit.

### recommended option: explicit tagged union

```ts
type SubscriptionTarget =
  | {
      kind: "webhook";
      url: string;
      headers?: Record<string, string>;
    }
  | {
      kind: "self-worker";
      path: `/${string}`;
    }
  | {
      kind: "durable-object";
      binding: string;
      name: string;
      path: `/${string}`;
    }
  | {
      kind: "outgoing-websocket";
      url: string;
      protocols?: string[];
    };
```

this is preferred because it is:

- explicit
- easy to validate with zod
- easy to route in code
- easy to extend per target kind

### alternative: uniform `config` bag

```ts
type SubscriptionTarget =
  | { kind: "webhook"; config: { url: string; headers?: Record<string, string> } }
  | { kind: "self-worker"; config: { path: `/${string}` } }
  | { kind: "durable-object"; config: { binding: string; name: string; path: `/${string}` } }
  | { kind: "outgoing-websocket"; config: { url: string; protocols?: string[] } };
```

this is acceptable but a bit sloppier.

### alternative: URI scheme

```ts
type SubscriptionTarget = {
  uri: string;
};

const webhookTarget = { uri: "https://example.com/inbox" };
const selfWorkerTarget = { uri: "worker://self/internal/subscriptions/voice" };
const durableObjectTarget = { uri: "do://VOICE/room-123/events" };
```

this is compact, but harder to validate and less clear for internal targets.

## control events

the control event vocabulary should be as small as possible.

### proposed event 1: `subscription.set`

this creates or fully replaces the desired configuration for a slug.

```ts
type SubscriptionSetEvent = {
  type: "https://events.iterate.com/subscription/set";
  payload: {
    slug: string;
    target: SubscriptionTarget;
    status: "active" | "paused";
    startFrom: "head" | "tail" | { afterOffset: string };
    ackMode: "none" | "transport" | "explicit";
    retryPolicy: {
      baseDelayMs: number;
      maxDelayMs: number;
      maxAttempts: number | null;
    };
  };
};
```

important property:

- this is a full snapshot, not a patch

that means replay is easy:

- the latest `subscription.set` wins
- there is no patch-merging logic

it also means pause/resume is simple:

- append a new `subscription.set` with the same slug and `status: "paused"` or `status: "active"`

### proposed event 2: `subscription.deleted`

```ts
type SubscriptionDeletedEvent = {
  type: "https://events.iterate.com/subscription/deleted";
  payload: {
    slug: string;
  };
};
```

this means:

- the subscription should stop receiving events
- any live inbound websocket for that slug should be closed
- the mutable tracking row should move to `status = 'deleted'`

## control events are not deliverable subscription payloads

this needs to be explicit.

if the stream contains `subscription.set` and `subscription.deleted` events, the delivery loop must **not** forward those as normal subscription payloads.

the delivery algorithm should scan forward through the stream and:

- apply control events to subscription state
- advance the subscription cursor past those control events
- continue searching for the next deliverable non-control event

this avoids loops where "creating a subscription" would itself be delivered back into the subscription target.

## mutable tracking table

the simplest useful table is:

```sql
CREATE TABLE subscription_state (
  slug TEXT PRIMARY KEY,
  target_json TEXT,
  status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'deleted')),
  ack_mode TEXT NOT NULL CHECK(status IS NOT NULL),
  retry_policy_json TEXT,
  cursor_offset TEXT,
  next_attempt_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
```

### semantics

- `target_json`: materialized copy of the latest `subscription.set` target
- `status`: materialized control status
- `ack_mode`: materialized copy of current ack mode
- `retry_policy_json`: materialized copy of current retry policy
- `cursor_offset`: highest stream offset this subscription has already resolved
- `next_attempt_at`: when the DO should next attempt delivery
- `attempt_count`: current failure streak
- `last_error`: latest delivery failure, if any

### important note on `cursor_offset`

`cursor_offset` should mean:

- the highest stream offset this subscription has already processed through

that includes both:

- control events that were skipped for delivery
- normal events that were successfully acknowledged

this definition is slightly less pretty than "last acked user event", but it is much simpler and avoids rescanning the same control events forever.

## reduced-state projection behavior

the stream DO should treat subscriptions exactly like another reduced-state concern.

when new events are appended:

1. insert event rows as normal
2. update the stream `reduced_state`
3. scan the newly appended events for subscription control types
4. update `subscription_state` rows accordingly
5. schedule deliveries if active subscriptions are now due

for `subscription.set`:

- upsert the row
- write materialized config fields
- if the row is new:
  - initialize `cursor_offset` from `startFrom`
  - `head` means before the first deliverable event
  - `tail` means the current last stream offset at the moment the control event is applied
  - `{ afterOffset }` means exactly that offset
- if the row already exists:
  - keep the current `cursor_offset`
  - replace the desired config fields
  - reset retry bookkeeping only if the new config materially changes delivery behavior

for `subscription.deleted`:

- set `status = 'deleted'`
- clear `next_attempt_at`
- leave the row in place for observability/debugging

## ack modes

keep the product language simple:

- `none`
- `transport`
- `explicit`

### `none`

fire-and-forget. sending the event is enough.

### `transport`

the transport-level success condition is enough.

examples:

- webhook: HTTP `2xx`
- self-worker: internal fetch `2xx`
- durable object target: `stub.fetch()` returns `2xx`
- inbound websocket: not a good fit, since the client connection is already open and should probably use `explicit`

### `explicit`

the target must explicitly acknowledge the offset.

examples:

- inbound websocket sends `{ type: "ack", offset }`
- webhook target later calls an ack endpoint
- outgoing websocket target later sends an application-level ack message

## delivery behavior by target kind

### webhook

```ts
const response = await fetch(target.url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...target.headers,
  },
  body: JSON.stringify({
    subscriptionSlug: sub.slug,
    offset: event.offset,
    event,
  }),
});

if (!response.ok) {
  throw new Error(`Webhook failed with ${response.status}`);
}
```

recommended default:

- `ackMode = "transport"`

### self-worker

```ts
const response = await this.env.SELF.fetch(
  new Request(`https://self${target.path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      subscriptionSlug: sub.slug,
      offset: event.offset,
      event,
    }),
  }),
);
```

recommended default:

- `ackMode = "transport"`

### durable object target

```ts
const namespace = this.env[target.binding as keyof Env] as DurableObjectNamespace;
const stub = namespace.get(namespace.idFromName(target.name));

const response = await stub.fetch(`https://do${target.path}`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
  },
  body: JSON.stringify({
    subscriptionSlug: sub.slug,
    offset: event.offset,
    event,
  }),
});
```

recommended default:

- `ackMode = "transport"`

### inbound websocket into our DO

recommended handshake:

```ts
// client -> DO
{ "type": "hello", "slug": "bob" }

// DO -> client
{ "type": "event", "offset": "0000000000000042", "event": { ... } }

// client -> DO
{ "type": "ack", "offset": "0000000000000042" }
```

recommended default:

- `ackMode = "explicit"`

important properties:

- the socket binds to exactly one slug
- the DO owns the cursor for that slug
- the connection may hibernate when idle

### outgoing websocket from our DO

the model should allow this target kind, but implementation should treat it as:

- durable subscription
- ephemeral reconnecting socket session
- explicit app-level ack by default

do **not** assume the outgoing socket hibernates the way inbound DO-server sockets do.

## alarm-driven delivery mechanism

the scheduler should follow the standard DO alarm pattern:

1. maintain `next_attempt_at` per subscription row
2. set the single DO alarm to the minimum due time
3. when `alarm()` fires, process all rows whose `next_attempt_at <= now`
4. reschedule the next alarm from the table

rough sketch:

```ts
async alarm() {
  const now = Date.now();
  const dueSubscriptions = this.getDueSubscriptions({ now });

  for (const sub of dueSubscriptions) {
    const event = this.getNextDeliverableEventAfter(sub.cursor_offset);

    if (event == null) {
      this.clearSchedule(sub.slug);
      continue;
    }

    try {
      await this.deliverToTarget(sub, event);

      if (sub.ackMode === "none" || sub.ackMode === "transport") {
        this.markAcked({
          slug: sub.slug,
          cursorOffset: event.offset,
        });
      }
    } catch (error) {
      this.markFailure({
        slug: sub.slug,
        error,
      });
    }
  }

  this.scheduleNextAlarmFromTable();
}
```

### success path

on successful delivery:

- advance `cursor_offset`
- clear `last_error`
- reset `attempt_count`
- if more backlog remains, schedule immediate retry for that slug

### failure path

on failed delivery:

- increment `attempt_count`
- write `last_error`
- compute next backoff using the subscription retry policy
- if `maxAttempts` is exceeded:
  - set `status = 'paused'`
  - clear `next_attempt_at`

this is simpler than introducing `dead`, leases, claim ownership, or a second queue abstraction.

## internal helper methods

the DO likely wants helpers roughly like:

```ts
applySubscriptionControlEvent(event: StreamEvent): void
getSubscriptionState(slug: string): SubscriptionStateRow | null
getNextDeliverableEventAfter(offset: string | null): StreamEvent | null
deliverToTarget(sub: SubscriptionStateRow, event: StreamEvent): Promise<void>
markAcked(args: { slug: string; cursorOffset: string }): void
markFailure(args: { slug: string; error: unknown }): void
scheduleNextAlarmFromTable(): Promise<void>
```

and for the websocket path:

```ts
handleSubscriptionSocketHello(ws: WebSocket, slug: string): Promise<void>
handleSubscriptionSocketAck(ws: WebSocket, slug: string, offset: string): Promise<void>
```

## prior art to copy

| System                 | Copy                                        | Avoid                          |
| ---------------------- | ------------------------------------------- | ------------------------------ |
| Kafka consumer groups  | one cursor per subscription                 | partition/rebalance complexity |
| Redis Streams          | pending-until-ack intuition                 | full pending-entry machinery   |
| SQS                    | simple retry + backoff mental model         | infinite retry without bounds  |
| Stripe/GitHub webhooks | `2xx` means success, idempotent receivers   | exactly-once assumptions       |
| NATS JetStream         | tiny ack vocabulary                         | broad consumer feature matrix  |
| Durable Object alarms  | single alarm + `next_attempt_at` scheduling | busy-polling                   |

## non-goals for now

- no generic `AckSource` hierarchy
- no `leaseOwner`
- no `leaseExpiresAt`
- no consumer-group balancing
- no exactly-once guarantees
- no generic transport plugin system

## filtering and transform

not v1, but the future direction should be:

- filtering with JSONata
- transforms with JSONata

that likely belongs as optional fields on `subscription.set` later:

```ts
type FutureSubscriptionSetPayload = {
  slug: string;
  target: SubscriptionTarget;
  filter?: string; // JSONata
  transform?: string; // JSONata
};
```

## implementation sequence

1. add contract types for `SubscriptionTarget`, `subscription.set`, and `subscription.deleted`
2. extend the stream DO schema with `subscription_state`
3. apply control events during append/reduction
4. implement inbound websocket subscriptions with explicit ack
5. implement fetch-style targets: `webhook`, `self-worker`, `durable-object`
6. implement alarm scheduling with `next_attempt_at`
7. implement explicit async ack endpoints/messages
8. add outgoing websocket targets

this keeps the abstraction coherent from the start while still rolling out the hardest transport later.
