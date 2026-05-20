We want to systematically build and benchmark a `Stream` durable object with a small external API:

```ts
type StreamOffset = number;
type StreamTimestamp = string; // ISO timestamp

type StreamEventInput = {
  type: string;
  payload: unknown;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  offset?: StreamOffset; // optional precondition: must equal the next offset
};

type StreamEvent = StreamEventInput & {
  streamPath: string;
  offset: StreamOffset;
  createdAt: StreamTimestamp;
};

type StreamCursor = "start" | "end" | StreamOffset;

type StreamDurableObjectApi = {
  append(event: StreamEventInput): Promise<StreamEvent>;
  appendBatch(events: StreamEventInput[]): Promise<StreamEvent[]>;

  read(args?: { after?: StreamCursor; before?: StreamCursor }): Promise<StreamEvent[]>;

  stream(args?: { after?: StreamCursor; before?: StreamCursor }): ReadableStream<Uint8Array>; // newline-delimited JSON events
};
```

Events are append-only. Each committed event receives a monotonically increasing `offset` and an ISO `createdAt` timestamp. Consumers can `read` a bounded historical range by cursor, or `stream` events from a cursor onward.

# Desired process

- Want to store measurements in Workers Analytics Engine with historic results retained
- Want to run benchmark scripts from a consistent location to avoid local wifi or whatever coming under test
- Want to be able to run benchmark scripts from my own computer
- Want to be able to run benchmark either against miniflare or against deployed workers

# WebSocket stream protocol

The minimal Cloudflare-idiomatic version routes each URL path to one named `Stream` Durable Object:

```ts
env.STREAM.getByName(url.pathname).fetch(request);
```

Clients connect with a WebSocket upgrade to the stream path. Use query parameters to choose the starting cursor:

- `?after=start` (default): replay the stream from the beginning.
- `?after=end`: only receive future appends.
- `?after=42`: replay events with `offset > 42`.

Client append frames are JSON:

```json
{ "op": "append", "event": { "type": "example", "payload": { "hello": "world" } } }
```

Server event frames are JSON:

```json
{
  "type": "event",
  "event": {
    "streamPath": "/bench",
    "offset": 1,
    "createdAt": "...",
    "type": "example",
    "payload": { "hello": "world" }
  }
}
```

The Durable Object uses Cloudflare's WebSocket Hibernation API (`ctx.acceptWebSocket`, socket attachments, and `webSocketMessage`) so idle WebSockets can stay connected without pinning the object in memory.

# High-throughput protocol constraints

Some streams may carry many thousands of events per second. The protocol cannot
require a broad client or processor to do one request/response round trip per
event, especially not a round trip that might cross a continent. That would
create a backlog faster than it can be cleared.

The default event delivery path should therefore be server-push:

```text
Durable Object commits events
Durable Object pushes events to connected subscribers as quickly as possible
Subscriber drains, filters, and processes locally
```

It is acceptable, and probably central to the design, that most processors only
react to a small subset of events. A processor should be able to cheaply ignore
the majority of stream traffic while preserving enough offset knowledge to catch
up, detect gaps, and make append decisions.

This creates a split between two different jobs:

- **Event delivery:** high-volume, ordered, mostly one-way server push.
- **Append/control operations:** low-volume, correlated operations where the
  caller needs an immediate answer such as the committed offset.

The append/control path might share the WebSocket with event delivery if the
protocol has independent request ids and ack frames. But it may also need a
separate path, such as an HTTP API, WorkerEntrypoint/RPC call, or separate
control WebSocket, if one busy event socket can head-of-line block offset acks
behind a large outbound event backlog.

For appends made by processors, the important guarantee is:

```text
append(event) resolves from an append ack / RPC response,
not from waiting for subscribe() to later yield that event.
```

Future optimization requirement: if a client appends an event and the returned
offset is exactly one greater than the largest contiguous offset the client has
already processed, the client should eventually be able to process that
committed event locally immediately instead of waiting for the server to echo it
back through the subscription. That optimization is not required for the first
version, but the protocol should not make it impossible.

# Experiments

- What is the maximum append throughput of an append durable object
- What is the impact of deploying the durable object
- Do named WorkerEntrypoint / capabilities reduce perceived performance

# Structure

- Don't overwrite the stream durable object - make many versions of it that try different things
- Have many worker.ts entrypoints that use different durable object and entrypoint configurations etc with different wrangler.json
- Structure into "deployments" and "tests". Each "deployment" should have one or more wrangler.json files and a worker entrypoint etc

# Difficulties

## Frozen clocks for CPU measurements

In production, Workers do not expose a real wall clock during synchronous CPU execution. As a [Spectre mitigation](https://developers.cloudflare.com/workers/reference/security-model/#step-1-disallow-timers-and-multi-threading), [`Date.now()`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/now) and [`performance.now()`](https://developer.mozilla.org/en-US/docs/Web/API/Performance/now) return the time of the last I/O and do not advance inside a tight loop ([Performance and timers](https://developers.cloudflare.com/workers/runtime-apis/performance/)).

What this means for benchmarks:

- **OK:** measuring elapsed time around awaited I/O, e.g. `fetch`, storage, SQL, RPC to another Durable Object, or a timer sleep.
- **Not OK:** measuring synchronous CPU work in memory. For example, we cannot accurately measure the time it takes to reduce a large number of events already loaded into memory.
- **Not OK:** spin-waiting with `Date.now()`; the clock will not advance without I/O.

[`setTimeout`](https://developers.cloudflare.com/workers/runtime-apis/nodejs/timers/) and [`scheduler.wait`](https://developers.cloudflare.com/workers/runtime-apis/scheduler/) do delay execution, but they are not a way to measure CPU-bound work. Local dev differs: `wrangler dev` advances timers normally, so CPU measurements that look plausible locally can be wrong in production.

## Durable Object clock drift

Workers on plain HTTP requests track wall time more reliably. **Durable Objects can fall behind real time** under load: the more CPU work a DO does per invocation, the more its `Date.now()` drifts from the client clock across successive requests. Demonstration: [CF Worker and DO Clock Tests](https://cf-worker-clocks-test.replicache.workers.dev/) (Replicache).

Implications for this Stream DO:

- **`createdAt` via SQLite `strftime(..., 'now')`** (see `stream.ts`) likely shares the DO clock. Events appended in the same synchronous turn (e.g. `appendBatch`) may get **identical timestamps**; timestamps are not a reliable ordering key beyond `offset`.
- **Use [DO Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) for wake-ups when no request is in flight** (TTL, scheduled jobs). `setTimeout`/`scheduler.wait()` work for in-request delays (backoff, pacing), but the DO goes idle once the handler returns.
- **Benchmark harness** must not measure CPU-bound phases with `Date.now()`/`performance.now()` in production; measure at the client, or time I/O-bound operations only.

#
