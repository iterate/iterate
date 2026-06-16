# Streams Engine

Runtime internals for the OS streams domain. `apps/os` binds the `Stream` class as its `STREAM` Durable Object, and OS domain Durable Objects host `StreamProcessor` classes via `createStreamProcessorHost`.

The pieces:

- a stream processor abstraction with typed event contracts and reducer state
  (`stream-processor.ts`, `shared/stream-processors.ts`)
- the stream Durable Object and the stream processor runner Durable Object
  (`workers/durable-objects/`)
- CapnWeb-over-WebSocket RPC between streams and subscribers
- browser, Node.js, and Workers client entry points
- a tiny TanStack Start React app in `apps/streams-example-app/`, served by the same Worker
- end-to-end fixtures for append, replay, outbound processors, and one-way batch delivery

## Run

```sh
pnpm --dir apps/os typecheck
pnpm --dir apps/streams-example-app build
pnpm --dir apps/os test
pnpm --dir apps/os e2e
```

Run the local TanStack Start + Cloudflare dev server:

```sh
pnpm --dir apps/streams-example-app dev
```

The root package is shaped like the future stream package; `dev`, `build`,
`deploy`, and browser e2e scripts delegate to `apps/streams-example-app/`.

Then run end-to-end tests against it:

```sh
WORKER_URL=http://localhost:5173 STREAM_STAGING_E2E=true pnpm --dir apps/streams-example-app vitest
```

Run browser Playwright tests against local Miniflare:

```sh
pnpm --dir apps/streams-example-app playwright
```

The browser suite covers append + local mirror updates, same-stream split views,
multi-stream split views, split-pane disposal/handoff, multi-tab leadership handoff, large
stream virtualization and scrolling, raw SQLite download/query, kill/reconnect, and
reset/reconcile behavior.

Run the same browser tests against a deployed worker:

```sh
WORKER_URL=https://streams-example-app.iterate-preview-2.com pnpm --dir apps/os e2e
```

Use the browser client library with a full stream URL:

```ts
import { withStreamConnectionFromBrowser } from "apps/streams-example-app/src/lib/stream-rpc.ts";

using connection = await withStreamConnectionFromBrowser({
  url: "wss://streams-example-app.iterate-preview-2.com/api/streams?path=%2Fexample",
});
const event = await connection.stream.append({ event: { type: "example", payload: {} } });
```

CapnWeb's `newWebSocketRpcSession()` queues sends while the browser WebSocket is connecting; the
browser helper returns a (synchronously) `Disposable` connection so network/RPC cleanup has one shape.

The React app serves one stream viewer; the stream path is a `?path=` search param, not a route
segment:

- `/` redirects to `/streams?path=%2F`
- `/streams?path=/` shows the root stream (path `/`)
- `/streams?path=/anything/else` shows the stream with path `/anything/else`
- `/split-stream?left=/a&right=/b` shows two stream viewers side by side

The top bar has an editable stream path input, a `Go to stream` button when the input differs
from the current route, and the current browser capnweb connection status. The browser viewer
uses Web Locks so only one mounted runtime subscribes for a stream path, mirrors delivered
events into a per-stream OPFS SQLite database, and renders the raw events with TanStack
Virtual. The important reads are ordinary SQL in the route code: a row count and a visible
`local_index` range query. The tools include a raw SQLite database download.

Deploy with Wrangler through the TanStack Start Vite build (requires Cloudflare auth via
`wrangler login` or a `CLOUDFLARE_API_TOKEN`; the worker deploys to the account in
`apps/streams-example-app/alchemy.run.ts`):

```sh
doppler run --project streams-example-app --config prd -- pnpm --dir apps/streams-example-app alchemy:up
```

Run the same end-to-end tests against the deployed worker:

```sh
WORKER_URL=https://streams-example-app.iterate-preview-2.com STREAM_STAGING_E2E=true pnpm --dir apps/streams-example-app vitest
```

Outbound processor subscriptions are Workers RPC only for now. External websocket/http
delivery was removed until there is a concrete product need for it again.

## Invariants

The API stays small and clear by holding to:

- appends are expressed as event batches
- subscribers consume event batches through a `processEventBatch({ events, streamMaxOffset, state })` RPC method; every batch carries the stream's reduced state as of `streamMaxOffset`, every subscription gets an immediate initial batch, and `events: false` subscriptions receive state-only batches
- stream delivery does not await each subscriber's `processEventBatch` result
- stream state is the reduced state of the inline core processor
- outbound subscribers are reconciled from `subscription-configured` events

## Append & subscription semantics

Non-obvious behaviors worth knowing:

- **Offsets are 1-based.** `stream/created` is offset 1; the next event is 2, etc.
- **Idempotency + offset precondition.** `idempotencyKey` is unique per stream; an append
  whose key already exists (persisted or earlier in the same batch) is skipped and the
  existing event returned. An optional `event.offset` acts as a precondition: it must equal
  the next offset, else the append throws `expected offset N, got M` — and on an idempotency
  hit it must equal the existing event's offset, else `idempotency hit at offset N, got M`.
- **Auto-appended core/presence facts.** The stream itself appends `stream/created` (offset 1),
  `stream/woken` on every Durable Object incarnation, and `stream/subscriber-connected` /
  `stream/subscriber-disconnected` presence facts once per delivery-connection open/close.
- **`eventTypes` subscription filter.** A subscription may pass `eventTypes` (processor hosts pass
  their contract's `consumes`); non-matching events are skipped and the cursor advances past them,
  so they are never re-delivered. Omit (or include `"*"`) for everything.
- **`events: false` state-only mode.** Subscriptions can request state-only batches (`events: []`
  plus current `state`/`streamMaxOffset`, coalesced per state advance); replay is ignored in this
  mode. Every subscription gets one immediate initial batch.
- **`replayAfterOffset` is exclusive and defaults to live-tail** (the current `maxOffset`); pass `0`
  to replay from the first event. Delivery starts at `replayAfterOffset + 1`.
- **512KB event chunking.** Each event's JSON is split into 512KB rows in `event_chunks`, so a
  single event can exceed the Durable Object per-row size limit.
- **Relative `streamPath`.** `append`/`appendBatch` accept a `streamPath` resolved relative to the
  current stream's path; appends to another stream are dispatched to that Durable Object.
- **`reset()` vs `kill()`.** `reset()` clears all durable storage for the stream then aborts the
  current incarnation; `kill()` only aborts the incarnation.

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

Terminology:

- A **processor snapshot** is the replay checkpoint: `{ offset, state }`, where
  `state` is the processor's reduced state at that stream offset.
- A **processor runtime state** is the broad live inspection value returned by
  `processor.getRuntimeState()`. It contains the snapshot plus optional runtime
  data such as health or metrics. Runtime state is observational; the snapshot
  remains the replay cursor.

Catch-up replay runs side effects for every delivered event past the durable
checkpoint. Side effects must therefore be idempotency-keyed and safe to retry.

Hosting:

- Workers: `createStreamProcessorHost(this.ctx)` in
  `src/workers/stream-processor-host.ts` hosts named processors inside a
  Durable Object. The host passes each processor's contract announcement in
  its subscribe call as `subscriber.processor.announcement`, alongside an
  optional live `subscriber.processor.getRuntimeState` capability; the stream
  appends the serializable announcement as part of the
  `events.iterate.com/stream/subscriber-connected` presence fact and retains the
  runtime-state capability only while the connection is live. There is no
  per-processor `standardProcessorBehavior` self-registration anymore.
- Browser: `acquireStreamRuntime` in `src/browser/stream-browser-store.ts`
  hosts a processor over an injected stream client with a Web Locks writer
  election. OS injects an ITX stream client; the streams example app injects its
  capnweb demo client (see `CONTEXT.md`).

Keep durable event type strings inline in the `events` object, `consumes`,
`emits`, and reducer. Repeating the string inside one processor definition is
preferred over local `eventTypes` objects or aliases that hide the wire
contract.

See `src/processors/examples/echo/` for a full example processor.
