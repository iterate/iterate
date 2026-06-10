# @iterate-com/streams

The production stream runtime. `apps/os` binds this package's `Stream` class
(`src/workers/durable-objects/stream.ts`) as its `STREAM` Durable Object, and
OS domain Durable Objects host this package's `StreamProcessor` classes via
`createStreamProcessorHost`.

The pieces:

- a stream processor abstraction with typed event contracts and reducer state
  (`src/stream-processor.ts`, `src/shared/stream-processors.ts`)
- the stream Durable Object and the stream processor runner Durable Object
  (`src/workers/durable-objects/`)
- CapnWeb-over-WebSocket RPC between streams and subscribers
- browser, Node.js, and Workers client entry points
- a tiny TanStack Start React app in `example-app/`, served by the same Worker
- end-to-end fixtures for append, replay, outbound processors, and one-way batch delivery

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

Outbound processor subscriptions are Workers RPC only for now. External websocket/http
delivery was removed until there is a concrete product need for it again.

## Invariants

The API stays small and clear by holding to:

- appends are expressed as event batches
- subscribers consume event batches through a `processEventBatch({ events, streamMaxOffset })` RPC method
- stream delivery does not await each subscriber's `processEventBatch` result
- stream state is the reduced state of the inline core processor
- outbound subscribers are reconciled from `subscription-configured` events

## Stream Processor Abstraction

Processors are classes extending `StreamProcessor` (`src/stream-processor.ts`)
with a `defineProcessorContract` contract. The host feeds ordered event batches
into `ingest({ events, streamMaxOffset })`; the base class reduces each
consumed event into state, hands the batch to the `process*` hooks for side
effects, and checkpoints `{ state, offset }` once all blocking work completed.
Batches are serialized: a later batch never starts until the previous one
completed or failed. `ingest` is host plumbing and must not be overridden.

Subclasses override up to three hooks (plus an optional one-time `prepare` for
setup that must land before the checkpoint is first read, e.g. schema
migrations):

- `reduce({ event, state })` — pure projection of one consumed event into the
  next state: no network, no appends, no database writes, no wall-clock
  decisions. This is what lets a processor catch up from old stream events
  without accidentally re-performing old work.
- `processEvent(args)` — synchronous per-event side effects; what most
  processors implement. Called by the default `processEventBatch` once per
  reduced event.
- `processEventBatch(args)` — batch-level side effects with a natural batch
  boundary (e.g. one SQLite transaction for the whole delivered batch).

Side-effect helpers passed to both hooks:

- `blockProcessorWhile(work)` holds the checkpoint (and the next batch) until
  the work completes. If the work fails, the batch is not checkpointed and can
  run again after restart — intentionally at-least-once, so durable side
  effects should be idempotent.
- `runInBackground(work)` is fire-and-forget; failures are caught and logged,
  and the checkpoint is not delayed.

The checkpoint offset advances across unconsumed events too: a processor that
only consumes `invoice.paid` still checkpoints past unrelated `page.view`
events, so replays do not rescan them.

Host-provided constructor deps (`StreamProcessorBaseDeps`):

- `readState`/`writeState` — where checkpoints live (in-memory by default;
  Durable Object storage or browser SQLite in real hosts).
- `keepAliveWhile(work)` — keeps the host runtime alive while detached async
  work is in flight (e.g. a Durable Object's `ctx.waitUntil`).
- `sideEffectsAfterOffset` — the side-effect anchor. Events at or below it are
  reduced into state but skipped by the default `processEvent` fan-out, so
  attaching to an existing stream rebuilds state from history without
  re-running historical side effects. Hosts set it to the offset where the
  processor was attached.

Hosting:

- Workers: `createStreamProcessorHost(this.ctx)` in
  `src/workers/stream-processor-host.ts` hosts named processors inside a
  Durable Object. The host announces each processor's contract on the stream
  with an idempotent `events.iterate.com/stream/processor-registered` append —
  there is no per-processor `standardProcessorBehavior` self-registration
  anymore.
- Browser: `acquireStreamRuntime` in `src/browser/stream-browser-store.ts`
  hosts a processor over a capnweb connection with a Web Locks writer election
  (see `CONTEXT.md`).

Keep durable event type strings inline in the `events` object, `consumes`,
`emits`, and reducer. Repeating the string inside one processor definition is
preferred over local `eventTypes` objects or aliases that hide the wire
contract.

See `src/processors/examples/echo/` for a full example processor.
