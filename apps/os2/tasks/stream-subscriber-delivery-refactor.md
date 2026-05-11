---
state: draft
priority: high
size: large
dependsOn: []
---

# Stream Subscriber Delivery Refactor

Refactor the shared Stream Runtime subscription path so Durable Object calls
deal in events and callbacks, not internal `ReadableStream<Uint8Array>` bodies
and newline encoding.

## Motivation

This is motivated by three related problems:

- The Stream Durable Object exposes `.stream()` as a `ReadableStream` of encoded
  NDJSON. OS2 oRPC then wraps that in an async generator and decodes it again,
  even though oRPC already owns the external async-iterator/SSE transport.
- In-memory stream readers, callable subscribers, webhook subscribers, and
  websocket subscribers currently use different rails.
- Delivery ordering is implicit. We want the Stream Runtime to guarantee that,
  for one stream and one subscriber, it invokes that subscriber's delivery
  function in stream offset order.

## Current Shape

- `packages/shared/src/streams/stream-durable-object.ts` keeps a set of
  `ReadableStreamDefaultController<Uint8Array>` subscribers and pushes encoded
  lines from `publish(event)`.
- `packages/shared/src/streams/external-subscriber.ts` fans out configured
  external subscribers through `Promise.all(...)`.
- `apps/os2/src/entrypoints/stream-capability.ts` exposes
  `StreamCapability.stream()` as a `Response` with `application/x-ndjson`.
- `apps/os2/src/orpc/routers/codemode.ts` receives that response body, decodes
  NDJSON, and yields events from the oRPC async generator.
- `apps/os2/src/durable-objects/codemode-session.ts` already has a callable
  `afterAppend({ event })` path for processor subscription delivery.

This makes the transport leak inward: the shared Stream Runtime has to care
about byte streams even when the caller is another Worker or Durable Object.

## Language

Use **Stream Subscriber** for the general target that receives appended stream
events. A Stream Subscriber can be an RPC callback, an oRPC bridge queue, a
webhook/callable target, a websocket target, or a future durable delivery
mechanism.

Keep **Processor Subscription** for the narrower existing concept in
`CONTEXT.md`: a durable callable registration that asks the Stream Runtime to
invoke a processor runner after matching stream events append.

## Target Model

The Stream Durable Object should have one homogeneous delivery concept:

```ts
type StreamSubscriberDelivery = (args: { event: Event }) => void | Promise<void>;
```

Every Stream Subscriber is a per-stream/per-subscriber lane. Each lane has one
promise tail. When event offset `N` is enqueued for that subscriber, the Stream
Runtime waits for any prior delivery in that lane to settle before invoking the
delivery function for offset `N`.

Important semantics:

- `append()` means commit the event and enqueue subscriber delivery work.
- `append()` must not wait for every subscriber delivery to finish.
- For one stream and one subscriber, delivery functions are invoked in offset
  order from our end.
- Different subscribers run independently.
- In v1, a failed delivery is logged and the lane continues to later offsets.
- Durable retry, dead-letter, and server-owned offset tracking are follow-up
  mechanisms that should build on the same lane abstraction.

## oRPC Boundary

The Durable Object should not return a `ReadableStream` for internal Worker/DO
calls.

For user-facing live event APIs, the OS2 oRPC handler should own the async
iterator/SSE edge:

- create a local async queue;
- subscribe to the Stream Durable Object with an `afterAppend` callback that
  pushes `Event` objects into that queue;
- yield events from the oRPC async generator;
- on oRPC disconnect/abort/iterator return, unsubscribe from the Stream Durable
  Object in `finally`.

Cleanup should be dual:

- primary cleanup comes from the oRPC generator's lifecycle signal/finally path;
- the Stream Durable Object should also unregister a live subscriber if calling
  its callback fails because the RPC capability is gone.

This avoids stale subscribers when the client disconnects, while still handling
broken callback capabilities as a backstop.

## API Direction

Add a callback sibling to the current stream-reading API:

```ts
subscribe(args: {
  after?: StreamCursor;
  before?: StreamCursor;
  afterAppend: (args: { event: Event }) => void | Promise<void>;
}): Promise<unknown>;
```

Do not prematurely design a rich public subscription resource. The first API
should be the smallest shape that lets the oRPC layer and internal Durable
Objects subscribe with callbacks and clean up explicitly.

Open design detail: decide the exact cleanup affordance before implementation.
Likely options are:

- `subscribe(...)` returns a tiny unsubscribe capability;
- `subscribe(...)` accepts an abort signal or cancellation callback;
- the oRPC bridge owns an explicit subscriber key and calls an
  `unsubscribe(...)` method in `finally`.

Pick the simplest shape that works reliably with Cloudflare Workers RPC
callback lifecycle rules.

## Cloudflare RPC Constraints

Cloudflare Workers RPC can pass function/callback stubs across Worker and
Durable Object boundaries. Treat those callbacks as object-capability
references, not serializable data.

Implementation must account for RPC lifecycle rules:

- retained callback stubs may need `dup()` if stored after the RPC method
  returns;
- duplicated callback stubs must be disposed when the subscriber is removed;
- compatibility dates in this repo are generally new enough for duplicate-stub
  behavior, but deployment targets should be checked before relying on it.

References:

- Kenton Varda, "JavaScript-native RPC for Cloudflare Workers"
- Cloudflare Workers RPC docs
- Cloudflare Workers RPC lifecycle docs
- Cap'n Web

## Implementation Sketch

- Replace `StreamDurableObject.subscribers` with a small subscriber registry.
- The registry stores live subscriber lanes by key:
  - current tail promise;
  - delivery function;
  - cleanup/dispose function when needed;
  - subscriber kind for logging.
- Backlog delivery and live delivery must use the same lane path.
- Refactor `.stream()` callers away from `ReadableStream` internally:
  - OS2 `StreamCapability.stream()` should become an async-event capability or
    be removed in favor of direct subscribe/read methods.
  - `codemode.streamEvents` should bridge callback subscription to oRPC async
    generator output.
- Extract external subscriber delivery from
  `packages/shared/src/streams/external-subscriber.ts` into promise-returning
  delivery functions so configured webhook/callable/websocket subscribers use
  the same ordering rail.
- Keep circuit breaker and ancestor propagation outside Stream Subscriber lanes;
  those are stream-core post-commit behavior, not subscriber delivery.

## Acceptance Criteria

- No internal OS2 or shared Stream Runtime caller has to decode NDJSON from a
  Stream Durable Object RPC method.
- `codemode.streamEvents` still exposes an oRPC async iterator to clients.
- A live oRPC stream disconnect promptly unregisters its Stream Subscriber.
- If callback invocation fails after the oRPC side disappears, the Stream
  Durable Object unregisters that subscriber as a backstop.
- Two quick appends to the same subscriber cannot invoke that subscriber's
  delivery function out of offset order.
- A slow subscriber does not prevent another subscriber from receiving the same
  event.
- A failed subscriber delivery logs and does not permanently block that
  subscriber in v1.
- Existing configured callable subscriber behavior still delivers
  `afterAppend({ event })` to `CodemodeSession`.

## Tests To Add Or Update

- Stream Runtime unit test for per-subscriber lane ordering.
- Stream Runtime unit test for fanout isolation across subscribers.
- Stream Runtime unit test for rejection logging and continuation.
- Workerd/RPC test for passing an `afterAppend` callback to the Stream Durable
  Object and receiving live events.
- Workerd/RPC or OS2 test for oRPC disconnect cleanup.
- Regression test that oRPC `codemode.streamEvents` yields `Event` objects
  without manually decoding a Durable Object `ReadableStream`.
- External subscriber tests proving webhook/callable/websocket delivery adapters
  still preserve existing filter/transform/framing behavior.

## Documentation Updates

When implementation starts, update root `CONTEXT.md`:

- add **Stream Subscriber** as the general event delivery target;
- keep **Processor Subscription** as the durable callable registration for
  processor runners;
- add the relationship that a **Processor Subscription** creates or represents
  a **Stream Subscriber**.

Consider an ADR for the callback cleanup shape if the final design retains RPC
callbacks beyond the subscribe call. That decision is non-obvious because the
alternative is a hold-open RPC call, and future maintainers will need to know
why one lifecycle model was chosen.

## Open Questions

- What exact v1 cleanup API should `.subscribe({ afterAppend })` expose?
- Should `before` be included in `.subscribe()` immediately for finite replay,
  or should finite reads stay on `history()`/`read()` only?
- Do external webhook/callable subscribers need durable cursor storage in the
  same refactor, or should v1 intentionally remain best-effort/log-and-continue?
- Which public compatibility path, if any, should remain for
  `StreamDurableObject.stream()` while OS2 call sites migrate?
