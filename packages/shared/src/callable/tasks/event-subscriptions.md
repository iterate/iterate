---
state: planned
priority: medium
size: large
dependsOn: []
---

# Event subscriptions

Event subscriptions are another motivating use case for Callables, not a new
Callable kind.

The stream appends an event that says "subscribe this thing". The subscription
target inside that event is a Callable:

```ts
type StreamSubscriptionAdded = {
  type: "stream.subscription.added";
  streamId: string;
  subscriptionId: string;
  subscriber: Callable;
};
```

The point is that stream code can store and replay a subscriber without knowing
whether it is a public HTTP server, service binding, Durable Object, Dynamic
Worker, or loopback binding.

Subscription records own delivery semantics: ack, retry, ordering, fanout,
timeouts, WebSocket framing, and backpressure. Do not add subscription delivery
variants to `Callable` itself.

Prefer capability-first subscriptions for internal Workers: pass callback stubs
and return disposable subscription objects where possible. Custom WebSocket
frames remain useful at public edges, but should not be the only model.

Planned scope:

- event envelope
- delivery guarantees
- ack/retry/dead-letter semantics
- bounded fanout
- WebSocket frame and ack protocol
- reconnect and backpressure policy
- Cap'n Web / Workers RPC subscription handles
