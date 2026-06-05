# Legacy Shared Streams Used By OS

This document inventories the legacy streams and stream processor implementation in `packages/shared` that `apps/os` currently depends on. The goal is migration planning, not endorsement of the current API shape.

## Scope

Primary shared modules:

- `packages/shared/src/streams/*`
- `packages/shared/src/stream-processors/*`
- `packages/shared/src/durable-object-utils/mixins/with-stream-processor.ts`
- `packages/shared/src/durable-object-utils/mixins/with-stream-processor-runner.ts`
- supporting Durable Object base/lifecycle helpers in `packages/shared/src/durable-object-utils/*`

Package export surface is declared in `packages/shared/package.json:29-81`; `apps/os` imports these modules through `@iterate-com/shared/...`.

## Stream Event Log

### Main durable object

`packages/shared/src/streams/stream-durable-object.ts:114` exports `StreamDurableObject`.

One `StreamDurableObject` owns one stream:

- namespace: `StreamDurableObjectStructuredName.namespace`
- path: `StreamDurableObjectStructuredName.path`
- persisted append-only event log
- persisted reduced stream state
- live NDJSON readers from `stream()`
- built-in privileged processors for circuit breaking and external subscribers

Public RPC methods on the DO:

- `append(inputEvent: EventInput): Promise<Event>` at `packages/shared/src/streams/stream-durable-object.ts:232`
- `appendBatch(inputEvents: EventInput[]): Promise<Event[]>` at `packages/shared/src/streams/stream-durable-object.ts:272`
- `alarm()` at `packages/shared/src/streams/stream-durable-object.ts:487`
- `getState(): StreamState` at `packages/shared/src/streams/stream-durable-object.ts:500`
- `destroy({ destroyChildren? }): Promise<DestroyStreamResult>` at `packages/shared/src/streams/stream-durable-object.ts:505`
- `history({ after?, before? }): Event[]` at `packages/shared/src/streams/stream-durable-object.ts:559`
- `historyIfInitialized(...)` at `packages/shared/src/streams/stream-durable-object.ts:576`
- `stream({ after?, before? }): ReadableStream<Uint8Array>` at `packages/shared/src/streams/stream-durable-object.ts:584`

Initialization:

- `StreamDurableObject` uses `withLifecycleHooks` plus `withDurableObjectCore`, `withOuterbase`, `withKvInspector`, and `withPublicFetchRoute` in `packages/shared/src/streams/stream-durable-object.ts:66-107`.
- `initializeFirstStream(...)` migrates local SQLite, creates initial reduced state, and appends `events.iterate.com/core/stream-first-initialized` at `packages/shared/src/streams/stream-durable-object.ts:150-176`.
- `hydratePersistedStreamState(...)` reads `reduced_state`, validates it, and optionally appends `events.iterate.com/core/durable-object-woke-up` on instance wake at `packages/shared/src/streams/stream-durable-object.ts:180-226`.

Append lifecycle:

- `append` and `appendBatch` parse `EventInput`, check idempotency, run `beforeAppend`, assign the next offset, reduce state, commit event plus reduced state in one SQLite transaction, then run `afterAppend`.
- Core validation enforces `stream-first-initialized` uniqueness, optional offset preconditions, and core event schemas in `packages/shared/src/streams/stream-durable-object.ts:323-373`.
- `reduceStreamCore(...)` increments `eventCount`, updates metadata, and records immediate child streams from `child-stream-created` at `packages/shared/src/streams/stream-durable-object.ts:1031`.
- `propagateInitializedStreamToAncestors(...)` appends deterministic `child-stream-created` events to all ancestor streams after a child stream initializes at `packages/shared/src/streams/stream-durable-object.ts:1088`.

### Stream schemas and helpers

`packages/shared/src/streams/types.ts` exports:

- `JSONObject`, `StreamPath`
- all circuit breaker, core event, external subscriber, and HTML renderer types
- `StreamNamespace`
- `StreamCursor`
- `StreamQuery`
- built-in event schemas/types: `StreamInitializedEvent`, `ChildStreamCreatedEvent`, `StreamMetadataUpdatedEvent`, `ErrorOccurredEvent`, `InvalidEventAppendedEvent`
- generic event schemas/types: `GenericEventInput`, `GenericEvent`, `EventInput`, `Event`
- `StreamState`
- `DestroyStreamResult`

`packages/shared/src/streams/event-base-types.ts` defines:

- `StreamPath`: canonical path parser, max length 1023, path syntax `/segment/segment`, lowercase alnum, `_`, `-`
- `JSONObject`: object-shaped JSON
- `EventTypeSchema`
- generic event envelopes with optional `metadata`, `idempotencyKey`, and client-supplied `offset`

`packages/shared/src/streams/core-event-types.ts` exports core event constants:

- `STREAM_FIRST_INITIALIZED_TYPE`
- `STREAM_DURABLE_OBJECT_WOKE_UP_TYPE`
- `STREAM_CHILD_STREAM_CREATED_TYPE`
- `STREAM_METADATA_UPDATED_TYPE`
- `STREAM_ERROR_OCCURRED_TYPE`
- `STREAM_INVALID_EVENT_APPENDED_TYPE`
- `STREAM_SUBSCRIPTION_CONFIGURED_TYPE`
- `STREAM_CIRCUIT_BREAKER_CONFIGURED_TYPE`
- `STREAM_HTML_RENDERER_CONFIGURED_TYPE`
- `STREAM_PAUSED_TYPE`
- `STREAM_RESUMED_TYPE`
- `getCoreEventTypeSlug(type)`
- `isCoreEventType(type)`

`packages/shared/src/streams/helpers.ts` exports the typed DO access layer:

- `StreamOffsetPreconditionError`
- `StreamDurableObjectInitInput`
- `StreamDurableObjectName`
- `StreamDurableObjectStub`
- `StreamDurableObjectNamespace`
- `getStreamDurableObjectName(...)`
- `getStreamStub(...)`
- `getInitializedStreamStub(...)`

All OS stream access ultimately goes through `getInitializedStreamStub(...)` or a wrapper around it.

### Built-in stream processors

These are not the public `stream-processors` contract model. They are privileged in-process processors run inside `StreamDurableObject`.

`packages/shared/src/streams/builtin-processor.ts` exports `BuiltinProcessor<State>`:

- `slug`
- `initialState`
- optional pre-commit `beforeAppend`
- optional pure `reduce`
- optional post-commit `afterAppend`

`packages/shared/src/streams/circuit-breaker.ts` exports `circuitBreakerProcessor`:

- state schema/events live in `packages/shared/src/streams/circuit-breaker-types.ts`
- uses a token bucket with default `{ burstCapacity: 500, refillRatePerMinute: 500 }`
- `beforeAppend` rejects most appends while paused, but allows resume, error, and DO wake events
- `afterAppend` auto-appends `STREAM_PAUSED_TYPE` when the token bucket goes negative

`packages/shared/src/streams/external-subscriber.ts` exports:

- `ExternalSubscriberPublishFailure`
- `externalSubscriberProcessor`
- `publishExternalSubscribers(...)`
- `publishExternalSubscriber(...)`
- `hasExternalSubscribersOfType(...)`
- `resetSubscriberSocketsForStream(...)`

External subscribers are configured by `STREAM_SUBSCRIPTION_CONFIGURED_TYPE` events. Subscriber types:

- `webhook`: dispatches a callable with optional JSONata filter/transform
- `callable`: dispatches a callable with `{ event }`
- `websocket`: opens a callable fetch target as a WebSocket and sends framed stream events

`StreamDurableObject` treats websocket/webhook subscribers as non-callable immediate post-commit delivery, while callable subscribers are enqueued for alarm-driven delivery.

## Persistence And Storage Behavior

Stream event storage is SQLFu-generated SQLite over Durable Object storage:

- schema source: `packages/shared/src/streams/db/definitions.sql`
- migration: `packages/shared/src/streams/db/migrations/0000_init.sql`
- generated query source files under `packages/shared/src/streams/db/queries`

Tables:

- `events`: `offset integer primary key`, `type`, JSON `payload`, JSON object `metadata`, unique `idempotency_key`, `created_at`
- `reduced_state`: singleton row with JSON `StreamState`

Important persistence behavior:

- event append and reduced-state update are committed together in `this.client.transaction(...)` in `packages/shared/src/streams/stream-durable-object.ts:255-264` and `packages/shared/src/streams/stream-durable-object.ts:306-318`
- `idempotency_key` is globally unique per stream; appends with an existing key return the existing event before reduction
- `history` resolves `StreamCursor` values to half-open SQLite ranges using `offset > afterOffset and offset < beforeOffset`
- live `stream()` emits NDJSON lines and retains in-memory `ReadableStreamDefaultController`s until cancelled
- `destroy()` can recursively destroy child streams, closes subscribers, resets websocket subscriber caches for the path, and calls `ctx.storage.deleteAll()`
- callable subscriber queue is Durable Object KV, not SQLite:
  - current key: `stream-do:callable-subscriber-delivery-queue-v2`
  - legacy key migrated on read: `stream-do:callable-subscriber-alarm-queue`
  - alarm delay: 10 ms

Runner state is also Durable Object KV:

- `withStreamProcessor` stores per stream path and processor at `stream-processor:<encoded-stream-path>:<processor-slug>:stored-state` in `packages/shared/src/durable-object-utils/mixins/with-stream-processor.ts:630`
- `withStreamProcessorRunner` stores one processor per DO at `stream-processor:<processor-slug>:stored-state` in `packages/shared/src/durable-object-utils/mixins/with-stream-processor-runner.ts:458`

Runner state shape:

- `state`: processor reduced state
- `hasCompletedFirstAttach`
- `liveAfterOffset`
- `reducedThroughOffset`
- `afterAppendCompletedThroughOffset`

The split between `reducedThroughOffset` and `afterAppendCompletedThroughOffset` is deliberate: reducer progress can be persisted before `afterAppend` side effects finish, allowing retries of failed side effects without replaying reducer state.

## Public Stream Processor Contract Model

The shared processor contract model is in `packages/shared/src/stream-processors`.

### Core exports

`packages/shared/src/stream-processors/types.ts` exports the type model:

- event shapes: `StreamEventInput`, `StreamEvent`
- event catalog types: `EventExample`, `EventDefinition`, `EventCatalog`
- type-level event resolution helpers: `EventCatalogFromObject`, `ContractEventCatalog`, `ResolvedEventType`, `EventDefinitionForType`, `EventFromTypes`, `InputFromTypes`
- contract input/shape types: `ProcessorContractShape`, `ProcessorContractInput`, `ProcessorContractInputWithoutDeps`
- processor state/event API types: `ProcessorState`, `ConsumedEvent`, `EmittedInput`, `ProcessorStreamApi`, `ProcessorReduction`
- runner state and policies: `StoredProcessorState`, `FirstAttachAfterAppendPolicy`
- implementation types: `ProcessorImplementation`, `BuiltinProcessorImplementation`, `Processor`, `BuiltinProcessor`

`packages/shared/src/stream-processors/stream-processor.ts` exports runtime helpers:

- `createEvent(...)`
- `getEventInputSchema(...)`
- `getEventSchema(...)`
- `defineProcessorContract(...)`
- `implementProcessor(...)`
- `implementBuiltinProcessor(...)`
- `assertNever(...)`
- `buildProcessorIdempotencyKey(...)`
- `validateProcessorContract(...)`
- `getProcessorStateSchema(...)`
- `getInitialProcessorState(...)`
- `createStoredProcessorState(...)`
- `runProcessorReduce(...)`
- `reduceProcessorEvents(...)`
- `runProcessorOnStart(...)`
- `runProcessorAfterAppend(...)`
- `catchUpProcessorFromStream(...)`
- `consumeLiveProcessorEvent(...)`

Contract invariants:

- processor state must parse to an object
- `consumes` and `emits` must resolve against the processor's own `events` plus `processorDeps`
- duplicate event ownership across deps is rejected at runtime validation
- reducer input is parsed through the consumed event's schema
- `streamApi.append(...)` is typed from declared `emits`
- `consumesAllEvents` is a runner escape hatch for processors such as the JSONata reactor

`packages/shared/src/stream-processors/pull-runner.ts` exports a non-DO pull runner:

- `PullProcessorStorage`
- `runPullProcessor(...)`
- `createMemoryPullProcessorStorage(...)`

### Runtime sequencing

`catchUpProcessorFromStream(...)` at `packages/shared/src/stream-processors/stream-processor.ts:454`:

- reads stream history after `storedState.reducedThroughOffset`
- reduces each consumed event
- persists updated state
- calls `onStart` after state is current
- runs `afterAppend` for missed live events, and on first attach only according to `FirstAttachAfterAppendPolicy` (default lookback: 1000 ms)

`consumeLiveProcessorEvent(...)` at `packages/shared/src/stream-processors/stream-processor.ts:619`:

- catches up missing offsets before accepting an out-of-order pushed event
- reduces and saves state
- runs `afterAppend` only for consumed events
- advances ignored events through `afterAppendCompletedThroughOffset`
- reports `afterAppend` errors through runner callbacks but preserves retry semantics

### Standard processor behavior

`packages/shared/src/stream-processors/core/standard-processor-behavior.ts` defines shared behavior most processors compose:

- state field: `hasRegisteredCurrentVersion`
- dependency: `CoreProcessorContract`
- consumes `events.iterate.com/core/stream-processor-registered`
- emits `events.iterate.com/core/stream-processor-registered` and `events.iterate.com/core/error-occurred`
- `afterAppend` appends the processor registration event until the reducer has observed the current version registration

`packages/shared/src/stream-processors/core/contract.ts` exports:

- `CoreProcessorRegisteredEventType`
- `CoreProcessorErrorOccurredEventType`
- `CoreProcessorContract`
- `buildProcessorRegisteredEvent(...)`

## Durable Object Utilities And Mixins

### Base stack

`packages/shared/src/durable-object-utils/mixins/with-durable-object-core.ts` exports:

- `DurableObjectCoreProtected`
- `withDurableObjectCore(...)`

Protected capabilities include local SQLite, KV, transactions, DO ID/name, alarms, and `blockConcurrencyWhile`.

`packages/shared/src/durable-object-utils/iterate-durable-object.ts` exports:

- `IterateDurableObjectBaseOptions`
- `createIterateDurableObjectBase(...)`
- `withIterateDurableObjectStack(...)`

The standard app DO stack composes:

- Cloudflare `DurableObject`
- `withDurableObjectCore`
- `withLifecycleHooks`
- D1 object catalog projection
- `withOuterbase`
- `withKvInspector`

### Lifecycle hooks

`packages/shared/src/durable-object-utils/mixins/with-lifecycle-hooks.ts` is used by streams and OS stream processors. Relevant exports include:

- structured name and initial state types
- lifecycle errors such as `NotInitializedError`
- `withLifecycleHooks(...)`
- `getInitializedDoStub(...)`
- `listD1ObjectCatalogRecordsByIndex(...)`
- `upsertD1ObjectCatalog(...)`
- `deriveDurableObjectNameFromStructuredName(...)`
- `serializeDurableObjectStructuredName(...)`

Streams use lifecycle hooks with D1 catalog indexes on `namespace` and `path`. OS domain DOs use them for project/repo/agent/slack/codemode cataloging.

### Legacy multi-processor mixin

`packages/shared/src/durable-object-utils/mixins/with-stream-processor.ts` exports:

- `StreamProcessorRuntimeEntry`
- `StreamProcessorRuntimeState`
- `StreamProcessorProtected`
- `withStreamProcessor(...)`

Protected runtime API:

- `registerStreamProcessor(processor)`
- `ensureStreamProcessorCallableSubscription(...)`
- `ensureStreamProcessorWebSocketSubscription(...)`
- `catchUpStreamProcessors({ streamPath, signal? })`
- `consumeStreamProcessorEvent({ event, signal? })`
- `waitUntilStreamProcessor(promise)`
- public `getStreamProcessorRuntimeState()`

Runtime model:

- one DO can register multiple processors
- runner state is stored per stream path and processor
- live events are delivered by external subscription callbacks into the DO
- callable and websocket subscription helpers append `STREAM_SUBSCRIPTION_CONFIGURED_TYPE` events to the stream
- appends made through processor stream APIs get provenance metadata `{ processor: { slug, version }, whileProcessingEvent? }`
- `#pendingWaitUntil` tracks background promises but does not use Cloudflare `ctx.waitUntil`

Current OS use:

- `apps/os/src/domains/agents/durable-objects/agent-durable-object.ts` uses `withStreamProcessor` so one Agent DO can register `jsonata-reactor` for `/agents`, or `agent-chat`, `agent`, and an LLM provider processor for concrete agent streams.

### Single-processor runner mixin

`packages/shared/src/durable-object-utils/mixins/with-stream-processor-runner.ts` exports:

- `StreamProcessorRunnerState<Contract>`
- `wrapProcessorStreamApiWithProvenance(...)`
- `StreamProcessorRunnerProtected`
- `withStreamProcessorRunner(...)`

Protected runtime API:

- `catchUpStreamProcessor({ signal? })`
- `consumeStreamProcessorEvent({ event, signal? })`
- `startStreamProcessorSubscription({ signal? })`
- `getStreamProcessorRunnerState()`
- `waitUntilStreamProcessor(promise)`

Runtime model:

- one DO owns one processor bound to one stream path
- processor instance is cached per warm DO instance so closure state can survive between events
- reduced state is persisted in DO KV
- stream API appends get the same provenance metadata wrapper as the legacy mixin
- `afterAppend` failures append `events.iterate.com/core/error-occurred` through `CoreProcessorContract`
- `startStreamProcessorSubscription` can run a pull subscription loop, but OS mostly uses callable stream subscriptions and calls `consumeStreamProcessorEvent` from `afterAppend`

Current OS use:

- `apps/os/src/domains/codemode/durable-objects/codemode-session.ts`
- `apps/os/src/domains/projects/durable-objects/project-durable-object.ts`
- `apps/os/src/domains/repos/durable-objects/repo-durable-object.ts`
- `apps/os/src/domains/slack/durable-objects/slack-integration-durable-object.ts`
- `apps/os/src/domains/slack/durable-objects/slack-agent-durable-object.ts`

## Shared Processor Definitions

Shared contracts and implementations exported from `packages/shared/package.json:53-81`:

| Processor           | Contract                                                                | Implementation                                                                | Notes                                                                      |
| ------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| core                | `packages/shared/src/stream-processors/core/contract.ts`                | `packages/shared/src/stream-processors/core/implementation.ts`                | lifecycle registration and processor error events                          |
| agent               | `packages/shared/src/stream-processors/agent/contract.ts`               | `packages/shared/src/stream-processors/agent/implementation.ts`               | maintains model-visible history, schedules LLM requests                    |
| agent-chat          | `packages/shared/src/stream-processors/agent-chat/contract.ts`          | `packages/shared/src/stream-processors/agent-chat/implementation.ts`          | renders user/assistant chat events into agent input                        |
| cloudflare-ai       | `packages/shared/src/stream-processors/cloudflare-ai/contract.ts`       | `packages/shared/src/stream-processors/cloudflare-ai/implementation.ts`       | executes agent LLM request through Workers AI                              |
| codemode            | `packages/shared/src/stream-processors/codemode/contract.ts`            | `packages/shared/src/stream-processors/codemode/implementation.ts`            | stream-backed script execution, tool registration, function call telemetry |
| dynamic-worker      | `packages/shared/src/stream-processors/dynamic-worker/contract.ts`      | `packages/shared/src/stream-processors/dynamic-worker/implementation.ts`      | tracks dynamic worker module/env config                                    |
| jsonata-reactor     | `packages/shared/src/stream-processors/jsonata-reactor/contract.ts`     | `packages/shared/src/stream-processors/jsonata-reactor/implementation.ts`     | consumes all events and appends configured reactions                       |
| jsonata-transformer | `packages/shared/src/stream-processors/jsonata-transformer/contract.ts` | `packages/shared/src/stream-processors/jsonata-transformer/implementation.ts` | transforms matching source events using JSONata                            |
| openai-ws           | `packages/shared/src/stream-processors/openai-ws/contract.ts`           | `packages/shared/src/stream-processors/openai-ws/implementation.ts`           | executes agent LLM request through OpenAI Responses WebSocket              |
| scheduling          | `packages/shared/src/stream-processors/scheduling/contract.ts`          | `packages/shared/src/stream-processors/scheduling/implementation.ts`          | reduces schedule config and exposes helpers to append due events           |
| slack               | `packages/shared/src/stream-processors/slack/contract.ts`               | `packages/shared/src/stream-processors/slack/implementation.ts`               | routes raw Slack webhooks into routed streams                              |
| slack-agent         | `packages/shared/src/stream-processors/slack-agent/contract.ts`         | `packages/shared/src/stream-processors/slack-agent/implementation.ts`         | handles routed Slack-agent behavior and Slack codemode provider calls      |

OS-local processor contracts built on the shared contract helper:

- `apps/os/src/domains/projects/stream-processors/project-lifecycle.ts`: `ProjectLifecycleProcessorContract`, `createProjectLifecycleProcessor(...)`, `reduceProjectLifecycleEvents(...)`
- `apps/os/src/domains/repos/stream-processors/repo-stream-processor.ts`: `RepoStreamProcessorContract`, `createRepoStreamProcessor(...)`, `reduceRepoStreamEvents(...)`

## OS Runtime Wiring

### Worker exports and bindings

`apps/os/src/entry.workerd.ts`:

- imports `StreamDurableObject` and re-exports it as a Worker Durable Object class
- registers `StreamDurableObject` public debug routes through `with-public-fetch-route`
- exposes `StreamsCapability`
- builds `AppContext.stream = env.STREAM`

`apps/os/alchemy.run.ts`:

- imports the `StreamDurableObject` type
- creates `DurableObjectNamespace<StreamDurableObject>("stream", { className: "StreamDurableObject", sqlite: true })`
- binds it as `STREAM`
- also binds processor-runner DOs: `CODEMODE_SESSION`, `PROJECT`, `REPO`, `AGENT`, `SLACK_INTEGRATION`, `SLACK_AGENT`

`apps/os/src/context.ts`:

- carries `stream?: DurableObjectNamespace<StreamDurableObject>`
- carries other DO namespaces that run stream processors

### StreamsCapability

`apps/os/src/domains/streams/entrypoints/streams-capability.ts` is the main OS wrapper over `StreamDurableObject`.

It exposes:

- `append`
- `appendBatch`
- `create`
- `list`
- `read`
- `stream`
- `getState`
- `listChildren`
- `executeCodemodeFunctionCall`

It uses:

- `getInitializedStreamStub(...)`
- `listD1ObjectCatalogRecordsByIndex(...)`
- `StreamPath`, `StreamCursor`, core event types
- capability props for `projectId`, optional base `streamPath`, append metadata, and append policy

`apps/os/src/orpc/routers/streams.ts` exposes project stream operations through oRPC and decodes NDJSON from `StreamsCapability.stream(...)`.

`apps/os/src/components/project-stream-view.tsx` streams events through the browser oRPC client, parses them with shared `Event`, and uses `runProcessorReduce(...)` plus the UI `StreamViewProcessorContract` to project renderer state.

### OS Durable Objects that run processors

`apps/os/src/domains/agents/durable-objects/agent-durable-object.ts`:

- uses `createIterateDurableObjectBase(...)`
- uses `withStreamProcessor(...)`
- registers processors on wake:
  - `/agents`: `createJsonataReactorProcessor()`
  - other agent paths: `createAgentChatProcessor()`, `createAgentProcessor(...)`, and either `createCloudflareAiProcessor(...)` or `createOpenAiWsProcessor(...)`
- ensures websocket stream subscription with `ensureStreamProcessorWebSocketSubscription(...)`
- receives websocket frames at `/stream-subscription`, parses `StreamSocketFrame`, and calls `afterAppend({ event })`
- exposes `getRuntimeState()` from `getStreamProcessorRuntimeState()`

`apps/os/src/domains/codemode/durable-objects/codemode-session.ts`:

- uses `withStreamProcessorRunner(...)` with `CodemodeProcessorContract`
- creates `createCodemodeProcessor(...)` with callable context, script executor, and session callable builders
- appends a callable stream subscription targeting `CODEMODE_SESSION.afterAppend`
- `afterAppend` calls `consumeStreamProcessorEvent(...)`
- local `processorStreamApiFromNamespace(...)` wraps `getInitializedStreamStub(...)`

`apps/os/src/domains/projects/durable-objects/project-durable-object.ts`:

- uses `withStreamProcessorRunner(...)` with `ProjectLifecycleProcessorContract`
- appends a callable stream subscription targeting `PROJECT.afterAppend`
- `afterAppend` consumes the project lifecycle event, then forwards the same event into the project config dynamic worker if present
- local stream API wraps `getInitializedStreamStub(...)`

`apps/os/src/domains/repos/durable-objects/repo-durable-object.ts`:

- uses `withStreamProcessorRunner(...)` with `RepoStreamProcessorContract`
- appends a callable subscription targeting `REPO.afterAppend`
- appends `events.iterate.com/repo/created`, consumes it immediately, and uses runner state as the repo projection

`apps/os/src/domains/slack/durable-objects/slack-integration-durable-object.ts`:

- uses `withStreamProcessorRunner(...)` with `SlackProcessorContract`
- appends callable subscriptions for the integration stream and routed streams
- creates bootstrap events for routed `SLACK_AGENT.afterAppend` and `AGENT.afterAppend`

`apps/os/src/domains/slack/durable-objects/slack-agent-durable-object.ts`:

- uses `withStreamProcessorRunner(...)` with `SlackAgentProcessorContract`
- consumes routed Slack-agent stream events through `afterAppend`
- supplies Slack Web API side effects to `createSlackAgentProcessor(...)`

### Other direct OS imports

High-signal direct importers:

- `apps/os/src/domains/streams/entrypoints/streams-capability.ts`
- `apps/os/src/orpc/routers/streams.ts`
- `apps/os/src/components/project-stream-view.tsx`
- `apps/os/src/domains/agents/durable-objects/agent-durable-object.ts`
- `apps/os/src/domains/codemode/durable-objects/codemode-session.ts`
- `apps/os/src/domains/projects/durable-objects/project-durable-object.ts`
- `apps/os/src/domains/repos/durable-objects/repo-durable-object.ts`
- `apps/os/src/domains/slack/durable-objects/slack-integration-durable-object.ts`
- `apps/os/src/domains/slack/durable-objects/slack-agent-durable-object.ts`
- `apps/os/src/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts`
- `apps/os/src/entry.workerd.ts`
- `apps/os/alchemy.run.ts`

Broader direct import areas:

- project routes and UI: `apps/os/src/routes/_app/projects/$projectSlug/**`, `apps/os/src/components/**`, `apps/os/src/lib/*stream*`, `apps/os/src/lib/*agent*`
- stream TUI: `apps/os/src/stream-tui/*`
- oRPC routers: `apps/os/src/orpc/routers/{agents,codemode,projects,streams}.ts`
- codemode provider/capability modules: `apps/os/src/domains/codemode/**`, `apps/os/src/rpc-targets/**`
- tests and e2e support: `apps/os/src/durable-objects/*.test.ts`, `apps/os/e2e/**`, `apps/os/src/stream-tui/*.test.ts`

## Tests

Shared tests:

- `packages/shared/src/streams/circuit-breaker.test.ts`: token bucket reduction, paused/resumed behavior, auto-pause after append, configured limits
- `packages/shared/src/streams/external-subscriber.test.ts`: subscriber state, websocket framed delivery, reconnects, webhook transforms/filters, callable subscriber payloads, websocket append/error frames, socket reset behavior
- `packages/shared/src/stream-processors/stream-processor.test.ts`: event schema helpers, contract validation, duplicate ownership rejection, reducer parsing, runtime object-state validation, `onStart`, catch-up semantics, first-attach lookback, live consume ordering, retry/error semantics, frontend projection example
- `packages/shared/src/stream-processors/stream-processor.type.test.ts`: compile-time contract inference, consumed/emitted event typing, unresolved event rejection, `beforeAppend` builtin-only, stored state typing
- per-processor unit tests:
  - `packages/shared/src/stream-processors/agent/contract.test.ts`
  - `packages/shared/src/stream-processors/agent/implementation.test.ts`
  - `packages/shared/src/stream-processors/agent-chat/contract.test.ts`
  - `packages/shared/src/stream-processors/agent-chat/implementation.test.ts`
  - `packages/shared/src/stream-processors/codemode/contract.test.ts`
  - `packages/shared/src/stream-processors/codemode/implementation.test.ts`
  - `packages/shared/src/stream-processors/openai-ws/implementation.test.ts`
  - `packages/shared/src/stream-processors/slack/slack.test.ts`
  - `packages/shared/src/stream-processors/slack-agent/slack-agent.test.ts`
- runner mixin tests:
  - `packages/shared/src/durable-object-utils/mixins/with-stream-processor-runner.unit.test.ts`
  - `packages/shared/src/durable-object-utils/mixins/with-stream-processor-runner.type.test.ts`

OS tests covering shared stream integration:

- `apps/os/src/durable-objects/codemode-session.test.ts`: callable stream subscription to `afterAppend`, session/provider/function-call flows
- `apps/os/src/durable-objects/iterate-mcp-server.test.ts`: MCP -> CodemodeSession -> stream append flows
- `apps/os/src/domains/repos/stream-processors/repo-stream-processor.test.ts`: repo reduced state projection
- `apps/os/e2e/vitest/agents.e2e.test.ts`: agent, OpenAI/Cloudflare AI, codemode, Slack-agent, append ordering regression
- `apps/os/e2e/vitest/codemode.e2e.test.ts`: script execution and stream output
- `apps/os/e2e/vitest/codemode-mcp-provider-stack.e2e.test.ts`: codemode providers across stream/OpenAPI/MCP/Slack paths
- stream UI/TUI tests under `apps/os/src/stream-tui/*.test.ts`

Notable gap:

- I did not find a direct shared unit test file for `StreamDurableObject` itself. The stream DO is indirectly exercised by OS Durable Object and e2e tests plus shared tests for its built-in processors.

## Migration-Relevant Findings

1. `StreamDurableObject` is both event store and privileged processor host. Migrating it requires preserving append semantics, idempotency, reduced `StreamState`, child stream propagation, circuit breaker behavior, and external subscriber delivery.
2. Built-in stream processors and public stream processors are different systems. Built-ins can reject an append pre-commit; public processors cannot.
3. OS delivery is mostly callback-driven, not pull-driven. Shared runners have `subscribe(...)` support, but OS stream APIs commonly implement `subscribe` as an empty generator that throws because live delivery arrives through stream subscription events targeting `afterAppend`.
4. Processor state is not in stream SQLite. It is DO KV owned by each processor runner DO, with storage keys that differ between `withStreamProcessor` and `withStreamProcessorRunner`.
5. Callable subscriber delivery has its own durable queue and alarm behavior inside `StreamDurableObject`; this is separate from runner state and from stream SQL.
6. `apps/os` depends on shared stream contracts in frontend code too. Contracts and reducers are imported into UI/TUI surfaces for local projection, so a backend-only migration still needs a compatibility story for exported types and pure reducer helpers.
7. `StreamsCapability` is the OS facade over shared streams. Most product/API access can migrate behind this boundary, but processor DOs also call `getInitializedStreamStub(...)` directly through local stream API wrappers.
8. The D1 object catalog is part of observable stream behavior for OS listing/debugging. `StreamsCapability.list()` depends on lifecycle catalog records for `StreamDurableObject`.
