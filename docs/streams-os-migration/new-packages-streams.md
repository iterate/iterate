# `packages/streams` Research Notes

This package is a staging implementation for the future OS stream runtime. It is intentionally small, private, and source-oriented today: `packages/streams/package.json` has no `exports` map and there is no `src/index.ts`, so the de facto public surface is the set of source entrypoints imported by the example app and tests.

## Public API Exports

Package shape:

- `packages/streams/package.json` names the private package `@iterate-com/streams`, with package scripts delegating `dev`, `build`, `preview`, and `deploy` to `example-app`, and with `test`, `test:e2e`, and `typecheck` at the package root.
- Runtime dependencies are `capnweb`, `zod`, `react`, and `@journeyapps/wa-sqlite`; browser SQLite is therefore part of the package shape, not just the example app.
- There is no package-level export map yet. OS migration should expect to add one, or keep direct source imports temporarily.

De facto source entrypoints:

- Stream event schemas and storage helpers: `packages/streams/src/shared/event.ts`.
- Typed processor contract helpers: `packages/streams/src/shared/stream-processors.ts`.
- Active processor authoring API used by the runner: `packages/streams/src/processor.ts`.
- Runtime-agnostic processor runner: `packages/streams/src/processor-runner.ts`.
- Subscription callback/async iterable adapter: `packages/streams/src/subscription.ts`.
- CapnWeb stream RPC types: `packages/streams/src/types.ts`.
- WebSocket/CapnWeb connection wrapper: `packages/streams/src/connection.ts`.
- Node client entrypoints: `packages/streams/src/node/connect.ts` and `packages/streams/src/node/connect-processor-runner.ts`.
- Worker client entrypoint: `packages/streams/src/workers/connect.ts`.
- Browser client/runtime entrypoints: `packages/streams/src/browser/connect.ts`, `packages/streams/src/browser/stream-browser-store.ts`, `packages/streams/src/browser/stream-browser-db.ts`, and `packages/streams/src/browser/hooks/use-stream-query.ts`.
- Durable Object classes: `packages/streams/src/workers/durable-objects/stream.ts` and `packages/streams/src/workers/durable-objects/stream-processor-runner.ts`.
- Processor implementations/contracts: `packages/streams/src/processors/**`.

## Durable Object Classes

`Stream` in `packages/streams/src/workers/durable-objects/stream.ts` is the stream append log and Workers RPC endpoint.

- CapnWeb HTTP/WebSocket termination is owned by the fronting Worker, which wraps the stream stub in `PublicStreamRpcTarget`; the Durable Object itself stays focused on storage and Workers RPC.
- Constructor initializes two Durable Object SQL tables, `events` and `processor_state`, then reads inline processor state, appends a first `events.iterate.com/stream/created` event when empty, appends a `woken` event on each incarnation, and starts outbound reconciliation.
- `append()` delegates to `appendBatch()`. `appendBatch()` validates input, handles idempotency keys, assigns offsets, reduces inline built-ins, persists event rows and processor state, then wakes delivery connections.
- Stream paths are resolved by `resolveStreamPath()` and addressed as Durable Object names `${namespace}:${path}`.
- `subscribe()` accepts a CapnWeb-hosted `processEventBatch` callback, delivers catch-up then live batches from SQL, replaces existing inbound connections by `subscriptionKey`, and returns `unsubscribe()`.
- `runtimeState()` returns inline reduced state plus connection counters; `reset()` clears Durable Object storage and aborts; `kill()` aborts the current incarnation.
- Outbound subscriptions are persisted in core state and reconciled on boot or `subscription-configured` events. Built-in subscribers dial `env.STREAM_PROCESSOR_RUNNER` over Workers RPC. External URL/WebSocket outbound subscribers are intentionally cut for now and can be brought back when there is a concrete need.

`StreamProcessorRunner` in `packages/streams/src/workers/durable-objects/stream-processor-runner.ts` hosts built-in processors outside the stream object.

- `fetch()` exposes the runner over CapnWeb.
- `requestSubscription()` is called by `Stream` during outbound reconciliation. It receives the stream RPC stub, subscription key, stream max offset, the `subscription-configured` anchor event, and stream reduced state.
- It currently supports only built-in `workers-rpc` subscribers and only maps `processorSlug === "echo-example"` to `echoExampleProcessor`.
- It builds `createProcessorRunner(...)` with Durable Object KV storage for `{ state, offset }`, a duplicated stream RPC stub, and `sideEffectAnchor` from the subscription-configured event.
- It calls `subscribeOutbound({ processEventBatch, replayAfterOffset })` on the stream stub, where `processEventBatch` is backed by `createStreamSubscription()` and `replayAfterOffset` is the persisted runner checkpoint or `0`.
- `runtimeState()` exposes `processorSlug` and the saved snapshot for tests/operator inspection.

## Processor Runner Model

`createProcessorRunner()` in `packages/streams/src/processor-runner.ts` is runtime-agnostic and is used in Node, browser, and the runner Durable Object.

- Inputs are `processor`, `deps`, optional `storage`, `stream`, and optional `sideEffectAnchor`.
- The runner loads its snapshot once. Snapshots are `{ state, offset }`.
- Batch reduction skips offsets already checkpointed. It reduces only events the processor consumes, but the checkpoint advances across unconsumed events too.
- A processor chooses either `afterAppendBatch` or `afterAppend`; defining both throws.
- `afterAppendBatch` runs once with all reduced events and final batch state. `afterAppend` runs once per reduced event.
- `blockProcessorUntil()` must be called synchronously inside the hook. The runner awaits all blockers before saving the snapshot, giving at-least-once replay after failures.
- `keepAlive()` tracks detached work and logs failures but does not hold the checkpoint.
- Side-effect eligibility is local processor policy via `shouldApplySideEffects({ event, gracePeriodMs })`, derived from the subscription anchor.
- If side effects throw, the runner appends `events.iterate.com/stream/error-occurred` with idempotency key `processor-error:${slug}:${checkpointOffset}` before rethrowing.
- `run({ subscription })` consumes any `StreamSubscription` async iterable and disposes it on runner disposal.

## Processor Definition Model

There are two related layers:

- `packages/streams/src/shared/stream-processors.ts` defines the typed contract model: `defineProcessorContract`, event catalogs keyed by durable event type strings, `processorDeps`, `consumes`, `emits`, Zod payload validation, reducer typing, `runProcessorReduce`, `reduceProcessorEvents`, validation helpers, and idempotency-key helpers.
- `packages/streams/src/processor.ts` defines the active implementation model consumed by `createProcessorRunner()`: `implementProcessor(contract, build)` and `implementBuiltinProcessor(contract, build)`. `build(deps)` returns synchronous `afterAppend`/`afterAppendBatch` hooks; built-ins may also expose `beforeAppend`.

Important migration detail: the richer `ProcessorStreamApi`, `onStart`, and stored-state lifecycle types in `packages/streams/src/shared/stream-processors.ts` are present, but the currently wired runner uses the simpler `src/processor.ts` model with `ProcessorStream`, `blockProcessorUntil`, and `keepAlive`.

Standard processor self-registration lives in `packages/streams/src/processors/standard-processor-behavior.ts`. Processors that spread it consume `stream/processor-registered`, emit registration/error events, reduce `hasRegisteredCurrentVersion`, and append their public contract once per version.

## Built-in Processors

Inline stream built-ins:

- `core` in `packages/streams/src/processors/core/contract.ts` and `packages/streams/src/processors/core/implementation.ts` maintains namespace, path, created/woken state, metadata, config, event count, max offset, child paths, pause state, registered processors, and configured subscriptions. Its `beforeAppend` gate rejects ordinary appends while paused. Its `afterAppend` propagates `child-stream-created` to ancestor streams when a stream is created.
- `circuit-breaker` in `packages/streams/src/processors/circuit-breaker/contract.ts` and `packages/streams/src/processors/circuit-breaker/implementation.ts` is a token bucket. It consumes all events, can be configured by `events.iterate.com/circuit-breaker/configured`, and appends `stream/paused` when tokens go negative.

Runner-hosted example:

- `echo-example` in `packages/streams/src/processors/examples/echo/contract.ts` and `packages/streams/src/processors/examples/echo/implementation.ts` counts input events, self-registers via standard behavior, and appends `output-echoed` after eligible input events. This is the only built-in processor currently recognized by `StreamProcessorRunner`.

Browser processors:

- `browser-raw-events` in `packages/streams/src/processors/browser-raw-events/implementation.ts` consumes all events and mirrors them into the browser SQLite `events` table. Its checkpoint is derived from `MAX(offset)` in that table; runner `storage.save` is intentionally a no-op in the browser runtime.
- `browser-event-feed` in `packages/streams/src/processors/browser-event-feed/implementation.ts` consumes all events and writes grouped `feed_items` rows. Its reduced state can be reconstructed from the last row in `feed_items`; grouping logic is pure in `packages/streams/src/processors/browser-event-feed/grouping.ts`.

## Browser And Client API

Connection helpers:

- `withStreamConnectionFromBrowser()` in `packages/streams/src/browser/connect.ts` opens a browser WebSocket to a stream URL, reports status, and returns a disposable `StreamConnection` with `stream: RpcStub<StreamRpc>`.
- `streamRpcPath(streamPath)` maps `/` to `/api/streams` and non-root paths to `/api/streams/${encodeURIComponent(path)}`.
- `withStreamConnectionFromNode()` in `packages/streams/src/node/connect.ts` does the same from Node.
- `withStreamConnectionFromWorkers()` in `packages/streams/src/workers/connect.ts` connects from Workers/Durable Objects using fetch plus a WebSocket upgrade.

Browser runtime:

- `acquireStreamRuntime()` in `packages/streams/src/browser/stream-browser-store.ts` creates or reuses one runtime per `(streamPath, processorSlug)` in a tab.
- Each runtime always opens a CapnWeb connection. Only the Web Locks leader subscribes and writes; followers read the shared OPFS database.
- Runtime keys use a hardcoded browser namespace `"default"` and subscription key `${namespace}:${browserSubscriberId}:${slug}`; browser subscriber ID is stored in `localStorage`.
- `BrowserProcessorConfig` requires `processor`, `schemaVersion`, owned `tables`, and `loadCheckpoint(sql)`.
- `StreamBrowserStore` exposes `appendBatch`, `runtimeState`, `clearLocalDatabase`, `kill`, `reset`, `getSnapshot`, `subscribe`, and `streamDatabase`.
- `useStreamQuery()` in `packages/streams/src/browser/hooks/use-stream-query.ts` wraps `StreamBrowserDatabase.query()` in `useSyncExternalStore`.

## Expected Env Bindings

The expected Cloudflare bindings are declared in `packages/streams/src/env.d.ts`:

- `STREAM: DurableObjectNamespace<Stream>`
- `STREAM_PROCESSOR_RUNNER: DurableObjectNamespace<StreamProcessorRunner>`

The example app repeats these in `packages/streams/example-app/src/env.d.ts` and configures them in `packages/streams/example-app/wrangler.jsonc` with:

- Durable Object bindings named `STREAM` and `STREAM_PROCESSOR_RUNNER`.
- A migration tag `v1` with `new_sqlite_classes: ["Stream", "StreamProcessorRunner"]`.
- `compatibility_date: "2026-05-01"` and `nodejs_compat`.

`packages/streams/example-app/src/worker.ts` exports both Durable Object classes and routes:

- `/api/streams` and `/api/streams/...` to `newWorkersRpcResponse(request, new PublicStreamRpcTarget(env.STREAM.getByName("default:${path}")))`.
- `/stream-processor-runner/...` to `env.STREAM_PROCESSOR_RUNNER.getByName(name)`.
- All other requests to the TanStack Start handler.

## Storage Behavior

Server Durable Object storage:

- `Stream` uses Durable Object SQL storage for `events` and `processor_state`.
- `events` has autoincrement `offset`, `type`, `created_at`, unique `idempotency_key`, and `raw_json`.
- `processor_state` stores inline built-in state by `processor_slug` as JSON.
- Append persistence is await-free after validation/reduction: event rows and reduced state are the append boundary; delivery/reconciliation are post-commit fan-out.
- `StreamProcessorRunner` uses Durable Object KV for `processorSlug` and the runner `snapshot`.

Browser storage:

- `StreamBrowserDatabase` in `packages/streams/src/browser/stream-browser-db.ts` stores one OPFS SQLite database per `(namespace, streamPath)`, with a deterministic filename under `${encodeURIComponent(namespace)}/${databaseSlug}.sqlite3`.
- It uses a dedicated worker in `packages/streams/src/browser/stream-db.worker.ts`, `@journeyapps/wa-sqlite`, and `OPFSCoopSyncVFS`. The design deliberately avoids COOP/COEP and SharedArrayBuffer.
- A BroadcastChannel notifies same-stream database changes across tabs. Registered queries rerun on changes.
- Writes go through `exec` or `batch(..., { transaction: true })`. The worker serializes requests and retries transient `SQLITE_BUSY`.
- `browser-raw-events` owns the `events` table, generated columns, `events_type_local_index` index, and an insert trigger that ignores identical replay, rejects changed same-offset replay, and enforces continuous offsets.
- `browser-event-feed` owns `feed_items`, with dense `local_index`, component name, offset span, event count, and JSONB data.
- Browser reset/reconcile discards local processor tables when the server max offset is lower than the local checkpoint.

## Tests

Unit/in-process tests:

- `packages/streams/src/stream-processor.test.ts` covers runner reduction, checkpointing, `blockProcessorUntil`, side-effect anchor logic, consume-all projectors, inline built-ins, child-stream propagation, and circuit-breaker pause behavior.
- `packages/streams/src/stream-processor-failures.test.ts` covers snapshot resume, replay deduplication, and at-least-once retry after a blocker failure, including `stream/error-occurred`.
- `packages/streams/src/processors/core/contract.test.ts` covers core state reduction, subscriptions/processor registration, pause/resume, metadata, and child-path helpers.
- `packages/streams/src/processors/circuit-breaker/contract.test.ts` covers circuit-breaker config and pause/resume interaction.
- `packages/streams/src/processors/browser-event-feed/grouping.test.ts` covers deterministic feed grouping.

End-to-end tests:

- `packages/streams/example-app/e2e/vitest/stream-capnweb.test.ts` covers browser and Node CapnWeb clients, append path resolution, idempotency, subscription delivery, outbound built-in/external subscriber behavior, and runtime inspection.
- `packages/streams/example-app/e2e/vitest/stream-processor-node.test.ts` hosts `echo-example` in-process over a real stream subscription and verifies reconnect/resume from snapshot.
- `packages/streams/example-app/e2e/playwright/stream-browser.spec.ts` covers browser append/mirror, SQLite type filtering and downloaded DB inspection, split views, multi-tab leadership handoff, stale writer-lock migration, bulk streams, virtualization, reconnect after `kill`, reset/local mirror discard, event-feed rendering, state view RPC, and view switching.

## Example App Usage

The example app is a TanStack Start/Cloudflare Worker app under `packages/streams/example-app`.

- Worker integration is in `packages/streams/example-app/src/worker.ts`: export the two DO classes, route stream RPC requests to the `STREAM` Durable Object using namespace `default`, route runner requests to `STREAM_PROCESSOR_RUNNER`, and otherwise serve the app.
- Wrangler integration is in `packages/streams/example-app/wrangler.jsonc`: bind both DO namespaces and declare SQLite DO migrations.
- Vite integration is in `packages/streams/example-app/vite.config.ts`: exclude `@journeyapps/wa-sqlite` from dependency optimization so the worker-loaded `.wasm` asset remains paired correctly; do not enable COOP/COEP.
- Route model is in `packages/streams/example-app/src/routes/streams/index.tsx`, `packages/streams/example-app/src/routes/streams.$.tsx`, and `packages/streams/example-app/src/routes/split-stream.tsx`.
- View selection is query-param based in `packages/streams/example-app/src/routes/-stream-views.ts`: `browser-raw-events`, `browser-event-feed`, and `browser-state`.
- The raw-events view in `packages/streams/example-app/src/routes/-stream-page.tsx` builds a stable `BrowserProcessorConfig` for `browserRawEvents`, acquires a stream runtime, and reads SQL counts/rows from `events`.
- The event-feed view in `packages/streams/example-app/src/routes/-event-feed-view.tsx` acquires a runtime for `browserEventFeed`, reads `feed_items`, and maps each row's `component` to React rendering.
- The state view in `packages/streams/example-app/src/routes/-stream-state-view.tsx` has no browser processor or table; it opens a browser stream connection and polls `runtimeState()` over RPC.

## OS Migration Notes

- Add a real package export map before OS imports this broadly; today consumers rely on source paths.
- Keep the `StreamRpc` API small: append, appendBatch, getEvent(s), subscribe, runtimeState, reduce, kill, reset.
- Decide whether OS wants the active `src/processor.ts` implementation model, the richer `shared/stream-processors.ts` lifecycle model, or a merged version. Both exist today.
- Generalize `StreamProcessorRunner` processor lookup. It is currently hardcoded to `echo-example`.
- Thread namespace explicitly in browser APIs. `stream-browser-store.ts` currently hardcodes `"default"`.
- Preserve the browser processor/runtime decomposition. It is the main architectural difference from a generic cache: each view owns a processor config, each processor owns tables/checkpoint logic, and Web Locks elect one writer per `(namespace, path, slug, schemaVersion)`.
