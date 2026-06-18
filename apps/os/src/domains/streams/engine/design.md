# Stream and StreamProcessorRunner design

> **Status: historical design notes, partially superseded.** This captures the
> original thinking; several decisions below never shipped under the names used
> here (e.g. split implementation builders and `connectStream`). The
> design-of-record is the code plus `README.md`, `CONTEXT.md`, and the ADRs in
> `docs/adr/`. Where this document and the code disagree, the code wins. Factual
> claims that are known-wrong against the current code are corrected inline; the
> "Stream processor", "Resolved decisions", and "Next steps scratchpad" sections
> are retained as history and flagged where they diverge.

This document describes the design of the two principal abstractions in our stream processing system:

1. Stream
2. StreamProcessorRunner

We'll cover

- The core data model
- The durable object design in cloudflare
- API surfaces for interacting with streams and stream processors
- Client libraries
- How to write stream processors

# Taxonomy / Shared vocabulary

Stream: a durable node that owns an append-only sequence of events.

Event: a single item in a stream.

Subscriber: a node outside the stream that can consume event batches from the stream. A subscriber is
not a websocket, not a live connection, and not necessarily unique to one stream.

Subscriber spec: the `subscriber` object inside a `subscription-configured` event. It tells the stream
what kind of subscriber should exist and how to connect to it. The only shipped shape is
`{ type: "callable", callable }`, where `callable` (from `@iterate-com/shared/callable/types.ts`) names
the host entrypoint/Durable Object and RPC method the stream dispatches with the handshake; the host
then calls back `subscribeOutbound`. The earlier `built-in` / `workers-rpc` / `processorSlug` and
external-URL/webhook shapes were never built.

Subscription: the configured edge from a stream node to a subscriber node. `subscriptionKey` identifies
this edge within one stream. The same subscriber implementation can appear behind many subscriptions.

Subscription configuration: the latest `events.iterate.com/stream/subscription-configured` event for a
given `subscriptionKey`. The built-in core processor stores this exact event in stream reduced state.

Subscription connection: a live runtime connection used to deliver events for a subscription. It has
a direction, a transport, an optional `subscriptionKey`, and a batch callback. It is not persisted; it
can be recreated from stream reduced state and runtime handshakes.

Inbound subscription connection: a subscriber connects into the stream and passes the stream a
batch callback by calling `subscribe()`. Direction is always from the `Stream` durable object's
perspective. Browser tabs and vitest-hosted stream processors use this in tests.

Outbound subscription connection: the stream connects out to a subscriber described by a persisted
subscription configuration. Direction is always from the `Stream` durable object's perspective. Built-in
stream processors normally use this.

Subscription callback: the RPC function provided by the subscriber side for one live subscription
connection. The stream stores this function in memory and calls `processEventBatch({ events })` to
deliver batches.

capnweb session: a live capnweb connection to the stream. A session can become a subscription
connection if the subscription handshake yields a batch callback, but debug/control sessions
can exist without being subscriptions.

Stream runtime state: The current serializable state of the stream that is useful to a subscriber at
subscription start or to a UI/test for introspection. This is the union of persisted reduced state and
interesting runtime state such as connected subscription callbacks. It does not include event rows; use
`getEvent()` / `getEvents()` for events.

Processor snapshot: A processor replay checkpoint: `{ offset, state }`, where `state` is that
processor's reduced state at the offset. Snapshots are the narrow resume primitive.

Processor runtime state: The live inspection value a connected processor can expose to the stream.
It contains the processor snapshot plus optional runtime/health/metrics data. It is observational
and may disappear with the subscription connection.

Stream reduced state: The stream durable object's persisted projection over its own event log. The
stream uses this state for core bookkeeping such as created time, max offset / event count, event
schemas, and the latest `subscription-configured` event for each `subscriptionKey`.

Core stream processor: The built-in reducer that belongs to the stream itself. It runs synchronously
inside the stream durable object after offset allocation. Its reduced state is the stream reduced
state. Its processor slug is `core`; it still owns `events.iterate.com/stream/*` event types.

Subscription reconciler: the stream-owned process that compares stream reduced state with runtime
subscription connections and opens any outbound connections that should exist. For now it only needs to
add missing outbound connections; unsubscribe / disconnect policy can come later.

Stream processor: A consumer that uses our library to define a well defined manifest that declares

- the schemas of events it owns, consumes and emits.
- the processor manifests it depends on
- its state schema
- its reducer function (pure function of the current state and new event - safe to import anywhere)
- a separate implementation function for side effects (e.g. appending more events)

Stream processor runner: A program that connects a stream processor to a subscription connection. For example, a nodejs stream processor runner might create an inbound subscription connection on a stream and run the stream processor against it. In `apps/os`, production domain processors are hosted by their domain Durable Objects through `StreamProcessorHost`; the standalone `StreamProcessorRunner` Durable Object lives under `workers/test-support` for stream-engine worker tests and the streams example app.

# Requirements

## Core data model

Each stream is uniquely identified by a "path" that must start with a slash and contain only lowercase letters, numbers, and hyphens (aka sluggable path components)

Each stream contains an append-only log of events with

- `offset` (unique autoincrementing integer >= 1; the first event is offset 1)
- `type` (string)
- `idempotencyKey?` (optional unique string) - if provided must be unique within the stream
- `payload?` (optional object) - shape determined by the `type`
- `metadata?` (optional object) - arbitrary metadata associated with the event
- `createdAt` (string) - ISO 8601 timestamp

## Core stream events

### `events.iterate.com/stream/created`

The first event in every stream. It has offset `1`, records the stream projectId/path, and lets the
built-in core processor reduce `createdAt` from the event timestamp.

```ts
{
  offset: 1,
  type: "events.iterate.com/stream/created",
  payload: {
    projectId: "stream",
    path: "/audio/uploads/123",
  },
  createdAt: "2026-06-01T12:00:00.000Z",
}
```

### `events.iterate.com/stream/woken`

Appended whenever the stream Durable Object constructor runs. It records the current incarnation so
debug output can distinguish persisted stream state from the currently running object instance.

```ts
{
  offset: 2,
  type: "events.iterate.com/stream/woken",
  payload: {
    incarnationId: "81e7f2f0-8f2d-47e6-a9d9-1df5a4ad33f0",
  },
  createdAt: "2026-06-01T12:00:00.001Z",
}
```

### `events.iterate.com/stream/configured`

Updates stream-level configuration that belongs in reduced state.

```ts
{
  offset: 3,
  type: "events.iterate.com/stream/configured",
  payload: {
    config: {
      simulatedStorageSyncDelayMs: 25,
    },
  },
  createdAt: "2026-06-01T12:00:00.002Z",
}
```

### `events.iterate.com/stream/subscription-configured`

Configures an outbound subscriber for the stream. The event is part of the stream history, and the
exact event is passed to the subscriber during outbound subscription init so the subscriber can
configure itself from committed stream state.

```ts
{
  offset: 4,
  type: "events.iterate.com/stream/subscription-configured",
  idempotencyKey: "subscription:transcribe-audio",
  payload: {
    subscriptionKey: "transcribe-audio",
    subscriber: {
      type: "callable",
      callable: {
        /* names the host entrypoint/DO + RPC method to dispatch */
      },
    },
  },
  createdAt: "2026-06-01T12:00:00.003Z",
}
```

`subscriptionKey` is the durable identity of this stream's configured subscription and must be unique
within a stream. If a later `subscription-configured` event uses the same `subscriptionKey`, it replaces
the previous configuration for that subscription. The same subscriber implementation can appear in
multiple subscriptions.
`subscriber` describes what kind of subscriber should be connected and how to connect to it. The only
shipped shape is `{ type: "callable", callable }`: the `callable` names the host entrypoint/Durable
Object and RPC method the stream dispatches with the handshake, and the host calls back
`subscribeOutbound`. External websocket/http subscribers can come back when there is a concrete product
need.

## Subscriptions

- The capnweb API should not care which side initiated a subscription connection.
- Subscription direction is always named from the stream's perspective: inbound means the subscriber connected into the stream, and outbound means the stream connected out to the subscriber.
- Event delivery should be framed as batches from day one, even when the batch contains a single event.
- We should be able to write e2e tests where we run stream processors in our vitest processes via inbound subscription connections.
- Outbound subscription connections need to survive the calling request context expiring. For example, if the inbound HTTP request that caused a `subscription-configured` append gets closed, the outbound connection to the subscriber should continue to work.
- Inbound subscription connections need to resume after hibernation.

## Stream processor

- The core API should be runtime-agnostic
- Need to separate out reducer and schemas / metadata from implementation
- `consumes` can include `"*"` for processors that need to reduce every event in a stream. The core
  stream processor uses this to maintain event count, max offset, and subscription configuration.
- Implementation is a class-based `StreamProcessor` with hooks:
  - `reduce` for pure state projection
  - `processEvent` for per-event side effects
  - `processEventBatch` for batch side effects and transactional writes
- Runtime capabilities are ordinary constructor deps. The stream capability is `deps.stream`;
  processor-specific services belong in the same deps object, not in a parallel processor context.
- Side-effect helpers are hook args: `blockProcessorWhile` for work that must complete before
  checkpointing, and `runInBackground` for detached work.

## Instrumentation

This needs a separate design pass. We probably need to be able to track all this information
eventually, but client-side metrics and ping are not part of the next client-library cut.

The active low-level client requirement is narrower: expose raw WebSocket frames through
`onWebSocketFrame()` so tests can assert the actual capnweb wire shape without forcing the
connection to retain frames.

Future instrumentation should cover:

- in workers analytics engine
- on-demand from a live durable object via RPC
- from client libraries

For any stream

- All active subscription connections with direction (inbound vs outbound), transport (`workers-rpc` for outbound), status (connected or not)
- age
- number of events
- storage size
- append volume (events per second)
- data in/out rate (bytes per second)

For any stream processor

- Delay betweeen `append-requested` and `append-confirmed` for each append
- last processed event offset
- size of "buffer"
- events processed
- events per second throughput
- data in/out rate (bytes per second)

For any stream processor subscription connection, we need to track

- ping time to stream
- direction
- connection status

# Design philosophy

### Make `Stream` itself very small

It should be a short piece of well instrumented high performance code. I

It should only care about:

- storage/retrieval of events
- subscription connection transports (inbound and outbound)
- any stream processing that can STOP events from being appended (e.g. circuit breaker, rate limiting, access control, etc)

Everything else should be implemented in separate builtin processors.

The primary optimisation goals for the stream are:

- performance (throughput and latency to subscribers)
- scalability in size of events, number of events, throughput, number of subscribers, etc
- simplicity
- observability

### Minimise blast radius

The failure of any one processor should not affect other processors. This means, for example, that whenever there is a need for in-memory event buffers, we prefer to buffer on the processor side than inside the `Stream` durable object.

# Durable object design in cloudflare

## Stream

- Store events in the Durable Object SQLite store via `ctx.storage.sql`. Events live in an
  offset-keyed `events` index table plus an `event_chunks` table that splits each event's JSON into
  512KB chunks, so a single event can exceed the per-row size limit. (The original async-KV plan was
  not used.)

- In general, DO NOT block durable object output gates on writes. Only block egress about the specific event that was just appended

- The stream durable object has its own formal reducer for core stream events. This reducer maintains
  the stream reduced state, including the latest subscription configuration for each `subscriptionKey`.
  Subscription management is stream-owned core behavior, not a separate user processor.

- The stream has a subscription reconciler that uses the stream reduced state to know which outbound
  subscription connections should exist, and uses runtime state to know which batch callbacks are
  currently connected.

## capnweb API

The primary browser/external way to interact with the stream is via a capnweb API. Same-account
Worker and Durable Object code uses Workers RPC directly.

The delivery model is shared even though connection setup differs:

- For inbound subscriptions, the subscriber calls `subscribe()` on the stream and passes its
  `processEventBatch` callback plus optional `replayAfterOffset`.
- For outbound built-in subscriptions, the stream calls `requestSubscription()` on the runner DO over
  Workers RPC. The runner then calls the stream's internal `subscribeOutbound()` with its
  `processEventBatch` callback.
- In both cases, the stream stores a callback in memory and delivers ordered event batches to it.

The subscription connection lifecycle is:

1. The stream reduced state says which durable subscriptions should exist, or an inbound caller asks to
   subscribe directly.
2. One side opens the appropriate RPC path: Cap'n Web for inbound clients, Workers RPC for built-in
   outbound runners.
3. The initiating side calls the appropriate request/subscribe method.
4. The subscriber side provides a batch callback and optional `replayAfterOffset`.
5. The stream stores a subscription connection in memory and starts replay/live delivery from
   `replayAfterOffset + 1`.
6. When the RPC peer breaks or unsubscribes, the stream forgets the runtime connection. The durable
   subscription configuration remains in stream reduced state.

The subscription request shape is:

```ts
{
  processEventBatch,
  replayAfterOffset?,
}
```

`replayAfterOffset` is owned by the subscriber and is optional (`replayAfterOffset?: number` — there
is no `"start"` literal). It is exclusive: delivery starts from `replayAfterOffset + 1`. If omitted, it
defaults to the stream's current `maxOffset`, i.e. live-tail from now with no historical replay; pass
`0` to replay from the first event. For inbound subscriptions, the subscriber sends it directly to
`subscribe()`.

Not every capnweb session is a subscription connection. Debug and control clients can open
capnweb sessions and call RPC methods without providing a batch callback. A capnweb session
becomes a subscription connection only when the handshake gives the stream a batch callback to
store for event delivery.

`runtimeState()` should return the stream reduced state plus serializable runtime state, including
active capnweb sessions, active subscription connections, subscription keys, directions,
transports, and connection status. Event rows are not included; callers use `getEvent()` or
`getEvents()` for event data.

Processors mirror this with `getRuntimeState()`: a connected processor hands the stream an optional
live capability under `subscriber.processor.getRuntimeState`. The stream stores that capability in
the in-memory connection, persists only `subscriber.processor.announcement` into presence facts, and
serves on-demand reads through `getProcessorRuntimeState({ subscriptionKey })`.

The subscription callback should expose a batch-shaped delivery method:

```ts
processEventBatch({ events });
```

`processEventBatch()` has no meaningful return value. The stream must not use it for acknowledgement,
backpressure, offset tracking, or error reporting.

The subscription protocol should be batch-first. Even if many early tests deliver one event at a
time, high-throughput streams will eventually need batching to reduce RPC overhead and increase fan
out performance. Client libraries can expose per-event iterators and `waitForEvent()` conveniences
on top of the batch callback, but the underlying RPC should remain batch-shaped.

The most important performance constraint is to avoid back-and-forth network round trips for each
consumed batch. When the stream durable object delivers a batch, it must call
`subscriptionRpcTarget.processEventBatch({ events })`, not await the returned capnweb thenable, and then
immediately dispose the ignored result.

The experiment showed why this matters. capnweb returned `ReadableStream` values are encoded as
remote writable stream writes, and each chunk produces return traffic:

```txt
in  ["stream",["pipeline",1,["write"],[eventBatch]]]
out ["resolve",2,["undefined"]]
```

The subscription callback shape avoids that write/resolve pair when the caller does not observe the
result. The expected post-init wire shape is one-way event delivery from stream to subscriber:

```txt
in ["push",["pipeline",subscriberId,["processEventBatch"],[{ "events": [event] }]]]
in ["release",resultId,refcount]
```

This is the main reason to keep trying the capnweb API before falling back to a custom WebSocket
protocol.

### capnweb RPC

This is used heavily in e2e tests to call privileged debug APIs like `.kill()`.

### Workers RPC

We use the workers RPC API from other cloudflare workers. For example from the ingress worker which calls `.fetch()` on the durable object stub. We might also use this from a wrapping orpc API.

Not a big deal, though, as this is an almost complete implementation of capnweb.

# Stream processor

The shipped model is a single `StreamProcessor` abstract class
(`src/stream-processor.ts`) extended by subclasses with a `defineProcessorContract`
contract.

- **Contract**: event catalog, `consumes`, `emits`, `processorDeps`, `stateSchema`,
  optional `initialState`, and optional pure `reduce`.
- **Implementation**: subclass hooks `prepare`, `reduce`, `processEvent`, and
  `processEventBatch`.
- **Dependencies**: one constructor deps object. The host injects `deps.stream`,
  checkpoint storage, and keep-alive support; processor-specific dependencies are
  additional fields in that same object.
- **Delivery path**: the stream delivers `processEventBatch({ events, streamMaxOffset })`;
  the base class filters already-checkpointed events, narrows consumed events through
  the contract, reduces state, runs hooks, waits for `blockProcessorWhile` work, and
  persists `{ state, offset }`.
- **Detached work**: hooks receive `runInBackground` for non-checkpoint-blocking work.
- **Contract announcements**: the processor host passes each processor's contract in
  the subscribe call; the stream records it on `subscriber-connected` presence.

## Open questions

- Where the inbound/outbound subscription handshake + connection wiring lives, and how
  the disposable test fixtures layer (connectStream -> subscription -> runner). This is
  where the original "run a processor in 3 subscription runtimes" goal lives.

## Deferred (explicitly not now)

- First-attach side-effect suppression as a runner _policy_: no longer needed as a
  framework feature — a processor self-services it with `if (event.offset < streamMaxOffset) return;`.
- Gap repair / out-of-order live delivery (the old `consumeLiveProcessorEvent`).

# Future work

- YOLO mode with configurable storage.sync() timing - we should be able to say globally or on a per-event basis that "we're okay with losing 100 events or maybe 30s worth of events", with individually overridable policies in .append()
- Permissions / access control
- Loop detection - like permissions / access control this MUST be in the stream durable object, as it _blocks_ appends
- Store older events in R2
- Different types of subscriptions - including those where the server keeps track of the offset for each consumer

# Next steps scratchpad

> **Superseded.** This scratchpad sketches a `connectStream` / `createStreamSubscription`
> / `processorRunner.run` client library that never shipped under those names. The real
> surfaces are `acquireStreamRuntime` with an injected stream client (browser) and
> `createStreamProcessorHost` (workers); connections are synchronously `Disposable`, not
> `AsyncDisposable`. Retained as history.

## Client libraries

The client library should be a runtime-portable stream client, not an e2e fixture system. It should
run from browsers, Node.js tests/scripts, and Cloudflare Workers/Durable Objects. The only
runtime-specific boundary should be connection setup.

The API should preserve the interaction shape used by the current OS streams APIs:

- append application events
- read historical events by offset
- subscribe to live/replayed events as an async iterator
- wait for matching events in tests and runners
- optionally narrow event types with a processor contract

It should not inherit OS project/codemode fixture concepts. Those higher-level e2e helpers can wrap
this library later.

### Level 1: `connectStream`

`connectStream()` opens a capnweb session to one stream and returns the lowest-level connection
primitive: the capnweb RPC stub plus raw WebSocket frame observation.

This is the only layer that should know whether the caller is running in Node, a browser, or a
Cloudflare Worker/Durable Object. In Node and browsers it can open a WebSocket from the URL. In
Workers, tests, or DO-to-DO cases, callers can provide a `fetch` implementation that performs the
WebSocket upgrade.

```ts
await using connection = await connectStream({
  url,
  headers,
  fetch, // optional; useful in Cloudflare Workers and tests
});

const appended = await connection.stream.append({
  event: {
    type: "events.example.com/widget-created",
    payload: { widgetId },
  },
});
```

The connection should not retain frames by default. It should synchronously notify registered frame
listeners, and test helpers can retain frames when they need assertions.

```ts
type StreamConnection = AsyncDisposable & {
  rpc: RpcStub<StreamRpc>;
  onWebSocketFrame(listener: (frame: WebSocketFrame) => void): Disposable;
};

type WebSocketFrame = {
  direction: "in" | "out";
  data: string;
  byteLength: number;
  timestamp: number;
};
```

`onWebSocketFrame()` is part of the level-1 requirement because this experiment must be able to
assert the actual capnweb wire shape. Higher-level tests can wrap it:

```ts
const frames = recordWebSocketFrames(connection);
// ... run test ...
expect(frames.outbound()).toEqual([]);
```

Disposal should be async: dispose the capnweb session, then close the underlying WebSocket.

### Level 2: subscriptions

`createStreamSubscription()` should wrap the caller's callback/iterator as a subscription callback
with `processEventBatch({ events })`, then call `subscribe()` on the stream RPC target. The Durable
Object stores that runtime target and starts delivering replay/live batches from `replayAfterOffset + 1`.

The subscription API should use portable JavaScript primitives:

- `AsyncIterable<StreamEvent>` for event consumption
- `AbortSignal` for cancellation
- `AsyncDisposable` for connection cleanup
- `waitForEvent()` as the test/runner convenience

Do not use Node's `EventEmitter` as the primary API because this library must work in browsers and
Workers without a Node dependency.

The underlying protocol is batch-first:

```ts
subscribe(args: {
  processEventBatch(args: { events: StreamEvent[] }): unknown;
  replayAfterOffset?: number | "start";
}): Promise<{
  unsubscribe(): Promise<void>;
}>;
```

`replayAfterOffset` is exclusive. If omitted, it defaults to `"start"`, meaning replay from the first
available event and then continue live.

The user-facing helper can still provide event-shaped conveniences:

```ts
await using subscription = await createStreamSubscription({
  connection,
  replayAfterOffset: appended.offset - 1,
});

for await (const event of subscription) {
  // portable across Node, browsers, and Workers
}

const completed = await subscription.waitForEvent({
  predicate: (event) => event.type === "events.example.com/widget-completed",
  timeoutMs: 5_000,
});
```

The subscription object should retain received events only as much as is needed for its own iterator
and waiter queues. Higher-level e2e helpers can add recording/retention for assertions.

Subscription disposal should not close a caller-provided `StreamConnection`. The connection is owned
by the caller; subscription disposal should stop the iterator/waiters and release local subscription
runtime state only. One-shot helpers can own the connection explicitly later, for example
`withConnectedStreamSubscription({ url, ... })`.

Because the connection can stay open after a subscription is disposed, `subscribe()` should return
an explicit subscription handle. Disposing the subscription should use that handle to unsubscribe on
the stream Durable Object so the DO stops delivering events to the callback target without requiring
the whole capnweb session to close.

```ts
type StreamSubscription = AsyncDisposable &
  AsyncIterable<StreamEvent> & {
    waitForEvent<T extends StreamEvent>(args: {
      predicate: (event: StreamEvent) => event is T;
      timeoutMs?: number;
    }): Promise<T>;
  };
```

This helper can also expose app-shaped convenience methods later, but the lowest-level connection
should remain just `rpc` plus WebSocket frame observation.

### Contract-aware event narrowing

The base stream client should stay transport-shaped and unopinionated. Contract awareness belongs at
the subscription / processor-runner layer, where raw stream events are consumed.

This matches the current OS stream processor model:

- `ConsumedEvent<Contract>` is inferred from `contract.consumes`
- processor dependencies expose the full raw `StreamRpc`
- stream subscriptions and appends still transport raw `StreamEvent`s / `StreamEventInput`s
- runners narrow each raw event at consumption time by resolving the event definition from the
  contract and its processor dependencies, then parsing with the matching payload schema

That means the client library should not have a whole-stream `stream.withContract(contract)` wrapper
as the primary design. Instead, the subscription helper can optionally accept a processor contract:

```ts
await using subscription = await createStreamSubscription({
  connection,
  replayAfterOffset: "start",
  contract: widgetProcessorContract,
});

const completed = await subscription.waitForEvent({
  type: "events.example.com/widget-completed",
});

completed.payload.widgetId;
```

Under the hood, `waitForEvent({ type })` should only return a typed event after it has found the
matching event type and parsed it through the contract-resolved payload schema. Unknown or
unconsumed event types should not be silently treated as typed processor events.

The same contract-aware narrowing path should be used by the inbound processor runner:

```ts
await using runner = await processorRunner.run({ subscription })({
  connection,
  processor: widgetProcessor,
  replayAfterOffset,
});
```

Append typing is deliberately not part of the processor stream dependency. Processor deps should stay
easy to reason about: `this.deps.stream` is the stream RPC, not a parallel contract-bound stream API.
Tests or helpers that want stricter event factories can build them separately without changing the
runtime dependency shape.

### Level 3: inbound stream processor runner

An inbound stream processor runner is a client-side convenience built on top of `subscribe()`. It is
not part of the stream Durable Object protocol.

What the caller has:

- a stream connection
- a processor contract and implementation
- optional initial processor state / stored snapshot
- processor-specific constructor deps

What the caller wants:

- catch up from `replayAfterOffset`
- reduce matching events into state
- run processor hooks for delivered events
- inspect the current processor runtime state, including its snapshot
- stop the runner with async disposal

```ts
await using runner = await processorRunner.run({ subscription })({
  connection,
  processor: widgetProcessor,
  initialState,
  replayAfterOffset,
});

await runner.waitForSnapshot((snapshot) => snapshot.state.completed > 0);
```

This layer should share the contract-aware event resolution/parsing used by typed subscriptions.

# Design decisions

- Use `connectStream()` for the low-level client constructor.
- `connectStream()` returns a thin connection: `rpc`, `onWebSocketFrame()`, and async disposal.
- Do not retain WebSocket frames in the core connection. Retention belongs in test/debug helpers.
- Disposing a subscription created from a caller-provided connection does not close that connection.
- `subscribe()` should return an explicit handle so subscriptions can be unsubscribed without
  closing the entire capnweb session.
- Use `AsyncDisposable` for stream connections and subscriptions.
- Use `AsyncIterable` plus `waitForEvent()` for subscriptions.
- Do not use Node `EventEmitter` as the primary subscription API.
- Keep OS project/codemode fixtures out of the client library; those helpers can wrap this client.
- For inbound subscribers, the client calls `subscribe()` with a `processEventBatch` callback and does
  not need to expose `requestSubscription()` on its own capnweb main object.
- Durable Object stream delivery only cares that the capnweb peer provides a
  subscription callback; it does not care whether that peer is a browser, Node script, Worker, or
  Durable Object.
- In the browser SQLite viewer, CapnWeb connections and subscriptions are deliberately separate:
  every tab gets its own stream connection for commands, but only one elected tab per stream path
  should call `subscribe()` and project event batches into the shared OPFS SQLite mirror
  (`@journeyapps/wa-sqlite`). Other tabs render through cross-tab reactive queries over that mirror.

## Later: metrics and ping

Traffic metrics and automatic ping/RTT measurement need a separate design pass.

Requirements to revisit:

- Application event rates and WebSocket frame rates are distinct metrics.
- Stream processor runner Durable Objects should be able to write metric samples to Workers
  Analytics Engine.
- Default candidates discussed but not accepted yet: emit metric samples every second and run an
  automatic client-owned ping test every three seconds.
