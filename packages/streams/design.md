# Stream and StreamProcessorRunner design

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
what kind of subscriber should exist and how to connect to it. The transport is a property of this
object. For now we only support capnweb-WebSocket (`capnweb-websocket`), but later subscriber
specs can describe dynamic workers, external URLs, webhooks, etc.

Subscription: the configured edge from a stream node to a subscriber node. `subscriptionKey` identifies
this edge within one stream. The same subscriber implementation can appear behind many subscriptions.

Subscription configuration: the latest `events.iterate.com/stream/subscription-configured` event for a
given `subscriptionKey`. The built-in core processor stores this exact event in stream reduced state.

Subscription connection: a live runtime connection used to deliver events for a subscription. It has
a direction, a transport, an optional `subscriptionKey`, and a subscription sink. It is not persisted;
it can be recreated from stream reduced state and runtime handshakes.

Inbound subscription connection: a subscriber connects into the stream and passes the stream a
subscription sink by calling `subscribe()`. Direction is always from the `Stream` durable object's
perspective. Browser tabs and vitest-hosted stream processors use this in tests.

Outbound subscription connection: the stream connects out to a subscriber described by a persisted
subscription configuration. Direction is always from the `Stream` durable object's perspective. Built-in
stream processors normally use this.

Subscription sink: the RPC capability provided by the subscriber side for one live subscription
connection. The stream stores this target in memory and calls `processEventBatch({ events })` on it
to deliver batches.

capnweb session: a live capnweb connection to the stream. A session can become a subscription
connection if the subscription handshake yields a subscription sink, but debug/control sessions
can exist without being subscriptions.

Stream runtime state: The current serializable state of the stream that is useful to a subscriber at
subscription start or to a UI/test for introspection. This is the union of persisted reduced state and
interesting runtime state such as connected subscription sinks. It does not include event rows; use
`getEvent()` / `getEvents()` for events.

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

Stream processor runner: A program that connects a stream processor to a subscription connection. For example, we might have a nodejs stream processor runner that creates an inbound subscription connection on a stream and then runs the stream processor against it. In production the main stream processor runner we use is a durable object called StreamProcessorRunner, which streams connect to via an outbound subscription connection.

# Requirements

## Core data model

Each stream is uniquely identified by a "path" that must start with a slash and contain only lowercase letters, numbers, and hyphens (aka sluggable path components)

Each stream contains an append-only log of events with

- `offset` (unique autoincrementing integer >= 0)
- `type` (string)
- `idempotencyKey?` (optional unique string) - if provided must be unique within the stream
- `payload?` (optional object) - shape determined by the `type`
- `metadata?` (optional object) - arbitrary metadata associated with the event
- `createdAt` (string) - ISO 8601 timestamp

## Core stream events

### `events.iterate.com/stream/created`

The first event in every stream. It has offset `0`, records the stream namespace/path, and lets the
built-in core processor reduce `createdAt` from the event timestamp.

```ts
{
  offset: 0,
  type: "events.iterate.com/stream/created",
  payload: {
    namespace: "stream",
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
  offset: 1,
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
  offset: 2,
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
  offset: 3,
  type: "events.iterate.com/stream/subscription-configured",
  idempotencyKey: "subscription:transcribe-audio",
  payload: {
    subscriptionKey: "transcribe-audio",
    subscriber: {
      type: "external-url",
      transport: "capnweb-websocket",
      url: "https://processor.example.com/transcribe-audio",
    },
  },
  createdAt: "2026-06-01T12:00:00.003Z",
}
```

`subscriptionKey` is the durable identity of this stream's configured subscription and must be unique
within a stream. If a later `subscription-configured` event uses the same `subscriptionKey`, it replaces
the previous configuration for that subscription. The same subscriber implementation can appear in
multiple subscriptions.
`subscriber` describes what kind of subscriber should be connected and how to connect to it. The
initial subscriber types are `built-in`, which uses `processorSlug` to select a built-in stream
processor runner, and `external-url`, which dials a configured public URL using the same capnweb
WebSocket protocol.

```ts
{
  type: "events.iterate.com/stream/subscription-configured",
  payload: {
    subscriptionKey: "external-runner",
    subscriber: {
      type: "external-url",
      transport: "capnweb-websocket",
      url: "https://example.com/stream-processor",
      headers: {
        "x-stream-token": "test-token",
      },
    },
  },
}
```

TODO: Add `dynamic-worker` only once a worker-name/entrypoint dialer exists.
TODO: Add webhooks only if we want non-capnweb delivery semantics.

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
- Implementation consists of single `afterAppend` function
  - `afterAppend` should be synchronous to force processor author to think about what they want to do
  - `afterAppend` should be a pure function of its arguments. It needs to be passed
    - the new event
    - previous state
    - new state (because reducer is run for us)
    - the exact stream RPC append API as `stream`
    - a `blockProcessorUntil` function that tells the processor runer to not process any more events until the promise returned from the callback completes
    - a `keepAlive` function to track detached work without blocking the processor checkpoint
    -

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

- All active subscription connections with direction (inbound vs outbound), transport (`capnweb-websocket`), status (connected or not)
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

- Use the async KV API for storage because it allows us manual control over when writes are persisted to other edge locations (use `allowUnconfirmed: true` for this)

- In general, DO NOT block durable object output gates on writes. Only block egress about the specific event that was just appended

- The stream durable object has its own formal reducer for core stream events. This reducer maintains
  the stream reduced state, including the latest subscription configuration for each `subscriptionKey`.
  Subscription management is stream-owned core behavior, not a separate user processor.

- The stream has a subscription reconciler that uses the stream reduced state to know which outbound
  subscription connections should exist, and uses runtime state to know which capnweb sessions /
  subscription sinks are currently connected.

## capnweb API

The primary way to interact with the stream is via a capnweb API.

The subscription handshake should be symmetrical:

- For inbound subscriptions, the subscriber calls `subscribe()` on the stream and passes its
  subscription sink plus optional `replayAfterOffset`.
- For outbound subscriptions, the stream calls `requestSubscription()` on the subscriber and passes
  its stream RPC target, the `subscription-configured` event, and `runtimeState()`. The subscriber
  returns the same request shape used by inbound subscriptions, so the stream can call `subscribe()`
  and start delivery.
- In both cases, the stream ends up storing a subscription sink in memory and delivering event batches
  to it.

The subscription connection lifecycle is:

1. The stream reduced state says which durable subscriptions should exist, or an inbound caller asks to
   subscribe directly.
2. One side opens a capnweb session.
3. The initiating side calls the appropriate request/subscribe method.
4. The subscriber side provides a subscription sink and optional `replayAfterOffset`.
5. The stream stores a subscription connection in memory and starts replay/live delivery from
   `replayAfterOffset + 1`.
6. When the capnweb session breaks, the stream forgets the runtime connection. The durable
   subscription configuration remains in stream reduced state.

The subscription request shape is:

```ts
{
  sink,
  replayAfterOffset?,
}
```

`replayAfterOffset` is owned by the subscriber and is optional. If omitted, the stream treats it as
`"start"`, meaning "start before the first event". For inbound subscriptions, the subscriber sends it
directly to `subscribe()`. For outbound subscriptions, the subscriber returns it from
`requestSubscription()` after looking at `runtimeState()` and the `subscription-configured` event. The
stream then starts replay/live delivery from `replayAfterOffset + 1`.

Not every capnweb session is a subscription connection. Debug and control clients can open
capnweb sessions and call RPC methods without providing a subscription sink. A capnweb session
becomes a subscription connection only when the handshake gives the stream a subscription sink to
store for event delivery.

`runtimeState()` should return the stream reduced state plus serializable runtime state, including
active capnweb sessions, active subscription connections, subscription keys, directions,
transports, and connection status. Event rows are not included; callers use `getEvent()` or
`getEvents()` for event data.

The subscription sink should expose a batch-shaped delivery method:

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

The subscription sink shape avoids that write/resolve pair when the caller does not observe the
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

A stream processor is **two objects**, never fused:

1. **Contract** — pure and serializable, safe to import anywhere (browser, frontend
   projection, reducer). Declares: the event catalog it owns, `consumes`, `emits`,
   `processorDeps`, `stateSchema`, and the pure `reduce`. This is `defineProcessorContract`.
2. **Implementation** — backend-only side effects (`onStart`, `afterAppend`). Bound to a
   contract via `implementProcessor(contract, implementation)`.

A browser or frontend projection imports only the contract and runs `reduce`; it never
pulls in side-effect code. This is the unifying replacement for both the legacy
`SimpleStreamProcessor` (which fused reducer + side effects) and the previous rich
implementation. We are NOT preserving backwards compatibility with either.

## Resolved decisions (all 2026-06-02)

Working reference implementation: `src/stream-processor.ts (+ stream-processor.test.ts)` (compiles).

- **Processor = contract + implementation**, two separate objects.
- **Implementation = `build(deps) -> { afterAppend }`.** `build` is the only place
  runtime clients are constructed; it closes over them. Runtime state is
  caches/connections _derived from deps_ — NEVER business state. Business state lives in
  the reduced `state` (the snapshot). This split is what makes both unit-testable.
- **No `onStart`.** Setup is done in `build`, lazily on first use, or via a
  `processorStarted` _event_ the processor consumes.
- **`afterAppend` is per-event and synchronous** (a switch statement, returns void).
  NOT batch-shaped. It receives `event`, `previousState`, `state`, `streamMaxOffset`,
  the exact `stream` append API, `blockProcessorUntil(() => work)`, and
  `keepAlive(promise)` for detached lifetime tracking.
- **Two usage patterns, and "when do we persist the processed offset?" is the axis:**
  - _Default (high-volume / fire-and-forget):_ effects fire in the background; the runner
    advances and persists the offset **optimistically, coalesced once per delivered
    batch**. A lost effect is fixed by reconcile-forward (the processor notices on a later
    `afterAppend` by comparing `state`/reality). Side-effect ordering is best-effort;
    processors must be written reconcile-tolerant.
  - _Durable job queue (low-volume), opt-in via `blockProcessorUntil`:_ its true meaning
    is "this work is part of what 'processed' means — **do not checkpoint past this event
    until it completes**." The runner awaits the blocker, persists `{state, offset}`, then
    continues. Crash before completion => the event is re-delivered and re-processed
    (at-least-once). Rare, so the serial cost is acceptable.
- **Bulk-write batching lives in the db layer, not the hook.** Because `afterAppend` no
  longer blocks by default, the runner rips through a delivered batch synchronously, so a
  fire-and-forget `db.write(event)` that debounces/coalesces internally yields one batched
  SQLite transaction per delivered batch — preserving the batch/row write-mode
  optimization without a batch-shaped hook. (Blocking was what defeated debounce earlier.)
- **Type narrowing of `afterAppend` args is free** because the implementation is an
  object literal passed through a generic function (`implementProcessor`). Proven that
  class inheritance (method override OR field arrow, generic or concrete base) does NOT
  get contextual param typing — so the contract+implementation split is functional, not
  a base class.
- **Exactly one runner and one transport.** Processors connect to a stream only via a
  capnweb subscription: the stream calls `processEventBatch({ events, streamMaxOffset })` on a sink the
  processor supplied. Identical for inbound (browser/node call `subscribe()`) and
  outbound (stream dials the runner DO) connections.
- **The runner consumes a subscription.** No `catchUp()` / `readHistory` / catch-up-vs-live split:
  the stream replays history through the _same_ `processEventBatch` channel, so the
  runner processes one event at a time through `processorRunner.run({ subscription })`.
  Runner responsibilities: dedup by `event.offset <= snapshot.offset`, serialize events,
  persist the `{ state, offset }` snapshot via a storage port, and append side effects
  through the exact stream API.
- **Runtimes differ only in connection setup and storage.** Browser and Node call
  `stream.subscribe({ sink: subscription.sink, replayAfterOffset })`; the outbound
  StreamProcessorRunner DO returns `{ sink: subscription.sink, replayAfterOffset }` to
  the Stream DO. After that, all three call `processorRunner.run({ subscription })`.
- **The browser SQLite projector** is `consumes: ["*"]`, no `reduce`, and an `afterAppend`
  that does a fire-and-forget `db.write(event)` (the db coalesces into batched
  transactions). Its resume cursor is the side-effect target itself —
  `replayAfterOffset = SELECT MAX(offset) FROM events` — so no separate snapshot is needed and a
  lost write is just re-delivered and re-written via `INSERT OR IGNORE`. Proven through
  the same `createProcessorRunner` + `processorRunner.run({ subscription })` as node/DO.
- **Builtin (inline) processors have a `beforeAppend` gate; subscription processors do
  not.** Three hook tiers:
  - Contract (pure, portable): `reduce` only.
  - Subscription implementation (runner, post-commit): `{ afterAppend }`. Cannot gate —
    only sees committed events.
  - Builtin implementation (inline in `Stream`, pre-commit, before offset allocation):
    `{ beforeAppend?, afterAppend? }`. `beforeAppend` rejects by throwing.
    This is required for the circuit breaker / future authorization: the canonical
    rate-limiter needs `reduce` to _succeed_ on the event that trips the breaker (token
    accounting goes negative), `afterAppend` to emit `stream/paused`, and `beforeAppend`
    to reject the _next_ event once `state.paused`. "Reduce throws" cannot express this and
    would smear admission logic into the pure reducer that ships to browser projections.
    Reference: os `packages/shared/src/streams/circuit-breaker.ts`. `beforeAppend` is sync
    today (matches os); async is a future extension if authorization needs I/O.
- **The Stream DO runs only the core processor inline.**
  The `core` processor owns stream bookkeeping, child-stream topology, and the
  paused/resumed door (`beforeAppend`). The `circuit-breaker` processor is an outbound
  subscription processor; it owns token-bucket metering and the
  `events.iterate.com/circuit-breaker/configured` event. When it trips, it appends
  `events.iterate.com/stream/paused`, and the `core` processor shuts the door.
  More complex circuit breakers can sit elsewhere in the network and use the same
  paused/resumed contract.

- **Ordinary processors include standard processor behavior by copying the shared pieces.**
  `standardProcessorBehavior` contributes the registration state field, the
  `events.iterate.com/stream/processor-registered` dependency, and the hook that appends
  that registration event once per processor version. Keep owned event type strings inline
  in the processor contract, consumes/emits arrays, and reducer; repeating one durable
  event string inside a processor definition is clearer than hiding it behind aliases.

- **`afterAppend` gets `streamMaxOffset`, a raw fact with no derived fields.** The stream
  piggybacks it on each delivery via `processEventBatch({ events, streamMaxOffset })`
  (no extra round-trip; the core already tracks `maxOffset`). The processor deduces
  offset lag as `streamMaxOffset - event.offset`.

- **Append→delivery round-trip latency is measured on the RECEIVE side, never by
  awaiting `append()`.** When instrumented, the runner stamps a wall-clock send time into
  a reserved metadata key (`events.iterate.com/instrument/appended-at-ms`) on each append;
  when that event is delivered back in `processEventBatch`, latency = `Date.now() -
appendedAtMs`. No correlation map, no await — `append` stays fire-and-forget. Exact for
  the self-loop (same isolate appends and receives); cross-isolate is subject to clock
  skew. Stamping is opt-in (only when an `onAppendRoundTrip` sink is provided) so normal
  events stay clean. CF note: `Date.now()` is frozen within a turn and advances on IO, so
  the append-turn vs deliver-turn correctly capture elapsed wall-clock across the network.
  Demonstrated + executed in the trial via `exampleAppendRoundTrip` (loopback stream).

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
- Split events across multiple kv sqlite rows to avoid 2mb limit
- Store older events in R2
- Different types of subscriptions - including those where the server keeps track of the offset for each consumer

# Next steps scratchpad

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

`createStreamSubscription()` should wrap the caller's callback/iterator as a subscription sink
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
  sink: {
    processEventBatch(args: { events: StreamEvent[] }): unknown;
  };
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
- `EmittedInput<Contract>` is inferred from `contract.emits`
- `ProcessorStreamApi<Contract>.subscribe()` still transports raw `StreamEvent`s
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

Append typing is useful, but it is a separate concern from subscription narrowing. Processor-facing
stream APIs and e2e helpers can expose `append({ event: EmittedInput<Contract> })` when they are
already bound to a processor contract. The low-level `connection.stream.append()` should keep accepting
raw `StreamEventInput`.

### Level 3: inbound stream processor runner

An inbound stream processor runner is a client-side convenience built on top of `subscribe()`. It is
not part of the stream Durable Object protocol.

What the caller has:

- a stream connection
- a processor contract and implementation
- optional initial processor state / stored snapshot
- optional deps for `afterAppend`

What the caller wants:

- catch up from `replayAfterOffset`
- reduce matching events into state
- run `afterAppend` for live/relevant events
- inspect the current processor snapshot
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
- For inbound subscribers, the client calls `subscribe()` with a `processEventBatch` sink and does
  not need to expose `requestSubscription()` on its own capnweb main object.
- Durable Object stream delivery only cares that the capnweb peer provides a
  subscription sink; it does not care whether that peer is a browser, Node script, Worker, or
  Durable Object.
- In the browser SQLite viewer, CapnWeb connections and subscriptions are deliberately separate:
  every tab gets its own stream connection for commands, but only one elected tab per stream path
  should call `subscribe()` and project event batches into the shared SQLocal database. Other tabs
  render through SQLocal cross-tab reactive queries.

## Later: metrics and ping

Traffic metrics and automatic ping/RTT measurement need a separate design pass.

Requirements to revisit:

- Application event rates and WebSocket frame rates are distinct metrics.
- Stream processor runner Durable Objects should be able to write metric samples to Workers
  Analytics Engine.
- Default candidates discussed but not accepted yet: emit metric samples every second and run an
  automatic client-owned ping test every three seconds.
