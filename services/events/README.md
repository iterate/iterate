# Events Service

Durable event streams with pull and push subscriptions.

## Stream model

- A stream is identified by `path`.
- Events are appended to one stream in write order.
- Stored event shape:
  - `path`
  - `offset`
  - `type`
  - `payload`
  - `version`
  - `createdAt`
  - `trace` (`traceId`, `spanId`, `parentSpanId`)

### Offsets

- Offsets are stream-local.
- First event offset is `0000000000000000`.
- Offsets increase by exactly `+1` per append.
- Offsets are zero-padded strings, so lexical order equals numeric order.
- `(path, offset)` is the primary key in storage.

Example for one stream:

```text
0000000000000000
0000000000000001
0000000000000002
```

## Contract operations

- `append`: append one or more events to a stream.
- `stream`: read history (`live: false`) or history+live (`live: true`) from optional offset.
- `registerSubscription`: append a push-subscription registration event.
- `ackOffset`: mark a push subscription offset as delivered.
- `listStreams`: list stream summaries (count, recency, metadata).

## Pull subscriptions (consumer owns offset checkpoint)

Pull flows do not persist consumer offsets in the events service. The consumer stores the last seen offset and sends it back on the next request.

```ts
import { createEventBusClient } from "@iterate-com/events-service";
import { serviceManifest } from "@iterate-com/services-contracts/events";

const client = createEventBusClient({
  env: { ITERATE_PROJECT_BASE_URL: "http://127.0.0.1:17301" },
  manifest: serviceManifest,
});

await client.append({
  path: "/orders/123",
  events: [{ type: "https://events.iterate.com/orders/created", payload: { orderId: 123 } }],
});

const iterator = await client.stream({ path: "/orders/123", live: false });
let lastSeenOffset = "0000000000000000";
for await (const event of iterator) {
  lastSeenOffset = event.offset;
}

const liveIterator = await client.stream({
  path: "/orders/123",
  offset: lastSeenOffset,
  live: true,
});
```

## Push subscriptions

Register by calling `registerSubscription` with a `subscription` payload.

```ts
await client.registerSubscription({
  path: "/orders/123",
  subscription: {
    type: "webhook",
    URL: "https://consumer.example.com/events",
    subscriptionSlug: "orders-main",
  },
});
```

### Offset ownership by push type

- `webhook`: events service advances offset after successful POST.
- `webhook-with-ack`: same offset ownership as `webhook`, but deliveries are single-flight and ordered per subscription.
- `websocket`: events service advances offset after successful send.
- `websocket-with-ack`: consumer advances offset by calling `ackOffset`; service waits for ack before sending next event for that subscription.

### WebSocket-with-ack example (consumer owns offset progression)

```ts
await client.registerSubscription({
  path: "/orders/123",
  subscription: {
    type: "websocket-with-ack",
    URL: "wss://consumer.example.com/callback",
    subscriptionSlug: "orders-ws-ack",
  },
});

// Consumer receives pushed event with offset=0000000000000042...
await client.ackOffset({
  path: "/orders/123",
  subscriptionSlug: "orders-ws-ack",
  offset: "0000000000000042",
});
```

### Replay on subscribe

`sendHistoricEventsFromOffset` lets a new subscription request replay from a specific offset:

```ts
await client.registerSubscription({
  path: "/orders/123",
  subscription: {
    type: "webhook",
    URL: "https://consumer.example.com/events",
    subscriptionSlug: "orders-replay",
    sendHistoricEventsFromOffset: "0000000000000010",
  },
});
```

## Local dev

- Start service: `pnpm -C services/events dev`
- OpenAPI docs: `http://127.0.0.1:17301/docs`
- Health: `http://127.0.0.1:17301/health`
