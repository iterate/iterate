# stream-staging-area

This experiment is a staging area for the production stream implementation.

It keeps only the pieces we want to graduate:

- a stream processor abstraction with typed event contracts and reducer state
- the stream Durable Object
- the stream processor runner Durable Object
- CapnWeb-over-WebSocket RPC between streams and subscribers
- browser, Node.js, and Workers client entry points
- a tiny TanStack Start React app in `example-app/`, served by the same Worker
- end-to-end fixtures for append, replay, outbound processors, and one-way batch delivery

It intentionally does not include the old handwritten WebSocket protocol, benchmark runners,
ORPC/minimal-stream comparisons, or measurement-specific storage delay knobs.

## Run

```sh
pnpm --filter @iterate-com/streams typecheck
pnpm --filter @iterate-com/streams build
pnpm --filter @iterate-com/streams test
pnpm --filter @iterate-com/streams test:e2e
```

Run the local TanStack Start + Cloudflare dev server:

```sh
pnpm --filter @iterate-com/streams dev
```

The root package is shaped like the future stream package; `dev`, `build`,
`deploy`, and browser e2e scripts delegate to `example-app/`.

Then run end-to-end tests against it:

```sh
WORKER_URL=http://localhost:5173 STREAM_STAGING_E2E=true pnpm --dir packages/streams/example-app vitest
```

Run browser Playwright tests against local Miniflare:

```sh
pnpm --dir packages/streams/example-app playwright
```

The browser suite covers append + local mirror updates, same-stream split views,
multi-stream split views, split-pane disposal/handoff, multi-tab leadership handoff, large
stream virtualization and scrolling, raw SQLite download/query, kill/reconnect, and
reset/reconcile behavior.

Run the same browser tests against a deployed worker:

```sh
WORKER_URL=https://stream-staging-area.iterate-dev-preview.workers.dev pnpm --filter @iterate-com/streams test:e2e
```

Use the browser client library with a full stream URL:

```ts
import { connectStream } from "./src/browser/connect.js";

await using connection = await connectStream({
  url: "wss://stream-staging-area.iterate-dev-preview.workers.dev/api/streams/example",
});
const event = await connection.stream.append({ event: { type: "example", payload: {} } });
```

CapnWeb's `newWebSocketRpcSession()` queues sends while the browser WebSocket is connecting; the
browser helper still returns an async-disposable connection so network/RPC cleanup has one shape.

The React app serves one stream viewer:

- `/` redirects to `/streams/`
- `/streams/` shows the root stream with path `/`
- `/streams/anything/else` shows the stream with path `/anything/else`
- `/split-stream?left=/a&right=/b` shows two stream viewers side by side

The top bar has an editable stream path input, a `Go to stream` button when the input differs
from the current route, and the current browser capnweb connection status. The browser viewer
uses Web Locks so only one mounted runtime subscribes for a stream path, mirrors delivered
events into a per-stream OPFS SQLite database, and renders the raw events with TanStack
Virtual. The important reads are ordinary SQL in the route code: a row count and a visible
`local_index` range query. The tools include a raw SQLite database download.

Deploy with Wrangler through the TanStack Start Vite build (requires Cloudflare auth via
`wrangler login` or a `CLOUDFLARE_API_TOKEN`; the worker deploys to the account in
`example-app/wrangler.jsonc`):

```sh
pnpm --filter @iterate-com/streams run deploy
```

Run the same end-to-end tests against the deployed worker:

```sh
WORKER_URL=https://stream-staging-area.iterate-dev-preview.workers.dev STREAM_STAGING_E2E=true pnpm --dir packages/streams/example-app vitest
```

The cloudflared-gated test verifies an `external-url` capnweb subscriber reached through a
quick tunnel. It needs the `cloudflared` binary and a worker that can dial out to the public
tunnel, so run it against the deployed worker:

```sh
WORKER_URL=https://stream-staging-area.iterate-dev-preview.workers.dev \
  STREAM_STAGING_E2E=true STREAM_STAGING_CLOUDFLARED_E2E=true \
  pnpm --dir packages/streams/example-app vitest
```

## Evaluate

This experiment is successful when the staging API stays small and clear enough to port into the
main repo:

- appends are expressed as event batches
- subscribers consume event batches through a `processEventBatch({ events, streamMaxOffset })` RPC method
- stream delivery does not await each subscriber's `processEventBatch` result
- stream state is the reduced state of the inline core processor
- outbound subscribers are reconciled from `subscription-configured` events

## Stream Processor Abstraction

The runner processes batches. There is no singular runner primitive; `afterAppend`
is only a convenience for processor authors whose side effects are naturally
per-event.

```ts
type StreamEventBatch = {
  events: StreamEvent[];
  streamMaxOffset: number;
};
```

Each batch has two phases.

First, the runner reduces the batch with no side effects. `reduce({ state, event })`
is pure replay logic: no network, no appends, no database writes, no wall-clock
decisions. This is what lets a processor catch up from old stream events without
accidentally performing old work.

While reducing, the runner records the consumed events:

```ts
type ReducedEvent<Contract> = {
  event: ConsumedEvent<Contract>;
  previousState: ProcessorState<Contract>;
  state: ProcessorState<Contract>;
};
```

Second, the runner applies side effects:

- `afterAppendBatch` is called once with the reduced events, the batch's
  `previousState`, final `state`, and `checkpointOffset`.
- `afterAppend` is called once per reduced event.
- A processor implementation must choose one of those hooks. The runner rejects
  implementations that define both.
- If neither hook exists, the runner only reduces and checkpoints.

`checkpointOffset` advances across unconsumed events too. A processor that only
consumes `invoice.paid` should still checkpoint past unrelated `page.view` events;
otherwise every replay would scan those same unrelated events again.

The processor snapshot is saved only after the selected hook and all synchronous
`blockProcessorUntil()` blockers succeed. So for a batch writing 100 rows to SQLite
in one transaction: if the transaction fails, the runner does not checkpoint the
batch. On restart, delivery resumes from the previous checkpoint and the batch can
run again. This is intentionally at-least-once; durable side effects should be
idempotent when duplicate attempts matter.

`keepAlive()` is different. It tracks detached work and logs failures, but it does
not delay the checkpoint.

### Choosing `afterAppend` vs `afterAppendBatch`

Use `afterAppend` when each consumed event independently causes a side effect:

```ts
afterAppend({ event, state, stream, keepAlive }) {
  if (event.type !== "events.iterate.com/echo-example/input-received") return;
  keepAlive(stream.append({
    event: { type: "events.iterate.com/echo-example/output-echoed", payload: { seen: state.seen } },
  }));
}
```

Use `afterAppendBatch` when the side effect has a natural batch boundary. The raw
browser mirror uses this shape: one delivered stream batch becomes one local SQLite
transaction, and the local mirror checkpoint advances only after that transaction
succeeds.

```ts
afterAppendBatch({ events, blockProcessorUntil }) {
  blockProcessorUntil(() =>
    sql.batch(
      events.map(({ event }) => ({
        sql: `INSERT INTO events (local_index, raw_jsonb) VALUES (?, jsonb(?))`,
        params: [event.offset - 1, JSON.stringify(event)],
      })),
      { transaction: true },
    ),
  );
}
```

### Historical Catch-Up and Side-Effect Windows

Whether historical events should cause side effects is processor policy, not a
runner-wide batch flag. A single delivered batch can straddle the moment a
subscription was configured: early events may be pure catch-up, later events may
deserve side effects, and the whole batch still has one checkpoint.

When the runner knows the subscription anchor, hook args include:

```ts
shouldApplySideEffects({
  event,
  gracePeriodMs: 10_000,
});
```

For outbound processors configured by the stream, the anchor is the
`events.iterate.com/stream/subscription-configured` event.

- With no anchor, it returns `true`; the runner has no subscription boundary.
- Events at or after the anchor offset return `true`.
- Older events return `true` only if their `createdAt` is within the supplied grace
  period before the anchor's `createdAt`.

This keeps the processor's choice local:

```ts
afterAppendBatch({ events, shouldApplySideEffects, blockProcessorUntil }) {
  const eventsToMirror = events.filter(({ event }) =>
    shouldApplySideEffects({ event, gracePeriodMs: 10_000 }),
  );

  if (eventsToMirror.length === 0) return;

  blockProcessorUntil(() => mirror(eventsToMirror));
}
```

A processor that should start side effects exactly at subscription time calls
`shouldApplySideEffects({ event })`. A processor that wants a 10 second look-back
passes `gracePeriodMs: 10_000`. A processor that must enact every historical side
effect ignores the helper.

### Standard processor behavior

Ordinary processors self-register on the stream exactly once per processor version.
Spread the shared pieces from `standardProcessorBehavior` into the contract, delegate
`reduce` and the registration append from `afterAppend`, and let the core processor
index `events.iterate.com/stream/processor-registered` into `processorsBySlug`:

Keep durable event type strings inline in the `events` object, `consumes`, `emits`,
and reducer. Repeating the string inside one processor definition is preferred over
local `eventTypes` objects or aliases that hide the wire contract.

```ts
import { standardProcessorBehavior } from "./standard-processor-behavior.js";

defineProcessorContract({
  stateSchema: z.object({
    ...standardProcessorBehavior.stateShape,
    seen: z.number().int().min(0).default(0),
  }),
  processorDeps: [...standardProcessorBehavior.processorDeps],
  consumes: [
    ...standardProcessorBehavior.consumes,
    "events.iterate.com/echo-example/input-received",
  ],
  emits: [
    ...standardProcessorBehavior.emits,
    "events.iterate.com/echo-example/output-echoed",
  ],
  reduce({ state, event, contract }) {
    const nextState = standardProcessorBehavior.reduce({ state, event, contract });
    return event.type === "events.iterate.com/echo-example/input-received"
      ? { ...nextState, seen: nextState.seen + 1 }
      : nextState;
  },
});

afterAppend({ event, state, stream, shouldApplySideEffects, keepAlive }) {
  if (!shouldApplySideEffects({ event })) return;
  standardProcessorBehavior.afterAppend({ state, stream, keepAlive, contract });
  // processor-specific side effects...
}
```

See `processors/examples/echo/` for a full example processor.
