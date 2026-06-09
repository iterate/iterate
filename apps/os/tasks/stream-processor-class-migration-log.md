# OS Stream Processor Class Migration — Decision Log

Rewrite of the #1402 spike on top of the merged class-based `StreamProcessor`
model (#1401). Goal: every processor apps/os hosts runs as a `StreamProcessor`
subclass owned directly by a domain Durable Object —

```ts
class RepoDurableObject extends DurableObject {
  repo = new RepoProcessor({ ... });
}
```

— and the Stream DO reaches subscribers through the `packages/shared` Callable
abstraction instead of a hardcoded runner binding.

This file records design decisions and issues hit along the way, in order.

## Decisions

### D1. Keep the subscribeOutbound pump; swap only the dialing to Callable

The Stream DO's outbound machinery (cursor per subscription, fire-and-forget
batch pump, reconcile-on-topology-change) is battle-tested. We do NOT redesign
delivery. The only change: `#connectOutboundConnection` no longer hardcodes
`env.STREAM_PROCESSOR_RUNNER.getByName(...).requestSubscription(...)`
(stream.ts:726). Instead the `stream/subscription-configured` payload carries a
`Callable` descriptor and the Stream DO runs
`dispatchCallable(subscriber.callable, { env, exports }, handshakeArgs)`.

The handshake args stay shape-compatible with today's `requestSubscription`:
`{ stream, subscriptionKey, streamMaxOffset, subscriptionConfiguredEvent,
streamRuntimeState }`. The live `stream` RpcTarget stub passes through Workers
RPC exactly as before — Callable's workers-rpc dispatch is the same transport.

Consequence: `packages/streams` depends on `packages/shared` (confirmed no
cycle: shared does not import streams).

### D2. Subscriber schema: `{ type: "callable", callable: Callable }`

The core contract's `SupportedOutboundSubscriber` gains a callable variant and
the legacy `{ type: "built-in", transport: "workers-rpc", processorSlug }`
moves to the historical (tolerated-but-dropped) union, like the old
capnweb-websocket transports before it. Old subscriptions on existing streams
keep reducing into state without runtime support; OS re-appends callable
subscriptions on agent/repo/etc. first access (the existing
`ensure*Subscriptions` paths already re-append idempotently — but see I3:
idempotency keys must change so the NEW subscription event actually lands).

No security/authorization on who may register which callable — explicitly out
of scope per the task.

### D3. One host helper, processors as plain DO fields

A small `StreamProcessorHost` (packages/streams, worker-side) gives a DO
everything it needs while keeping the class-field aesthetic:

```ts
class AgentDurableObject extends DurableObject<Env> {
  host = createStreamProcessorHost(this.ctx);
  agent = this.host.add("agent", (ctx) => new AgentProcessor({ ...ctx, openai }));
  chat = this.host.add("agent-chat", (ctx) => new AgentChatProcessor(ctx));

  requestStreamSubscription(args: RequestStreamSubscriptionArgs) {
    return this.host.requestStreamSubscription(args);
  }
}
```

- `add(name, build)` constructs the processor immediately with host-provided
  base deps (`iterateContext`, `readState`/`writeState` over `ctx.storage.kv`
  keyed by name, `keepAliveWhile` via `ctx.waitUntil`-compatible tracking).
- `requestStreamSubscription` routes by processor name (carried in the
  callable's `transformInput.shallowMerge: { processorName: "agent" }` or an
  explicit field in the subscription payload), reads the processor's
  checkpoint, and calls back `stream.subscribeOutbound({ processEventBatch:
(batch) => processor.ingest(batch), replayAfterOffset })`.
- Multiple processors with different names per DO fall out for free.

### D4. Late-bound stream context

Processors are constructed at DO field-init time, before any subscription
exists, but `iterateContext.stream.append` needs the stream. The host owns a
per-processor binding box `{ streamStub, namespace, path }` filled during
`requestStreamSubscription` (and re-filled on re-handshake after hibernation —
the Stream DO re-dials on reconcile exactly for this). The context the host
passes to `add(...)`'s builder closes over that box; appending before the
first handshake throws a clear error.

### D5. Side-effect anchor lives in the base class

The old runner had two cursors (`reducedThroughOffset`,
`afterAppendCompletedThroughOffset`) plus a first-attach lookback policy so a
processor attaching to an existing stream rebuilds state from full history
without re-running side effects. The class model has ONE checkpoint, so
without an equivalent, first attach would re-fire every historical side effect
(e.g. agent re-issuing LLM requests for old messages). Resolution:

- `StreamProcessorBaseDeps` gains optional `sideEffectsAfterOffset?: () =>
number` (default `() => 0`). The default `processEventBatch` skips
  `processEvent` for reduced events at or below it; `ProcessEventBatchArgs`
  exposes it so batch overrides can apply the same rule.
- The host sets it per subscription to the `subscription-configured` event's
  offset — the same anchor the old runner used.
- The old 1s first-attach lookback grace is dropped for now: OS appends
  subscription-configured events before the first user-visible event on a
  fresh agent stream, so anchor < first input holds. Revisit if e2e disagrees.

### D6. Processor migration shape

Each legacy processor (`implementProcessor(contract, build)` with
`afterAppend`/`onStart`) becomes a `StreamProcessor` subclass:

- contract keeps `defineProcessorContract` (the shared and streams models use
  compatible contract shapes; reducers move from contract/implementation into
  the class's `reduce`).
- `afterAppend` body → `processEvent` (sync) with async work routed through
  `blockProcessorWhile`/`runInBackground`; `streamApi.append` → typed append
  helper over `this.ctx.stream`.
- `onStart` connection warmup (openai-ws) → lazy instance fields; the DO
  instance is the connection scope, same as the old runner DO was.
- runner-only concepts (`shouldApplySideEffects`, `keepAlive`) map to the
  anchor (D5) and `runInBackground`.

### D7. The StreamProcessorRunner DO is retired

Processors move onto the domain DOs that already exist (Agent, Project, Repo,
SlackIntegration, SlackAgent, CodemodeSession). Where a stream needs a
processor with no natural domain DO (jsonata-reactor on arbitrary streams,
echo/circuit-breaker debug processors), a thin generic `ProcessorHostDO`
remains, built on the same host helper — but it is one `host.add` per
processor, no slug dispatch switch.

Callers of the old runner's `runtimeState()` (codemode session debug,
e2e `runtimeState` assertions) move to an equivalent on the host helper:
`host.runtimeState(name)` returning `{ snapshot, state, checkpointOffset }`.

### D8. Reverted #1401 fixes return here

The atomic browser-checkpoint transaction and `shutdown()` work was reverted
from #1401 after a consistent streams-e2e virtualized-scroll failure (see I1).
The `shutdown()` concept returns as part of the host helper teardown story if
needed; the browser-side atomic checkpoint is independent and will be re-done
separately with the e2e failure understood first.

### D9. Subscriptions filter by event type, driven by the contract

`subscribe`/`subscribeOutbound` accept `eventTypes?: readonly string[]`; the
pump filters post-read while its cursor advances past non-matching events, so
a resume offset can sit on a filtered-out event without re-delivery. The host
always passes `processor.contract.consumes` — the contract is the filter; a
`"*"` in consumes means unfiltered. Consequence to revisit: a processor whose
consumed events are sparse keeps a checkpoint behind the stream head, so
re-handshakes re-read (and re-filter) the gap server-side. Cheap until proven
otherwise.

### D10. Migrated OS processors move into apps/os domains

`packages/streams` now depends on `packages/shared` (for Callable), so shared
can no longer import streams — migrated processor classes cannot live in
`packages/shared/src/stream-processors`. They move next to the DOs that host
them under `apps/os/src/domains/*/stream-processors/`, which is where they
belonged anyway: they are OS product logic, and apps/os depends on both
packages. `packages/shared/src/stream-processors` is deleted at the end of the
migration. Wire formats (event types/payloads) are unchanged by the move.

Processors the old OS runner never selected (`scheduling`,
`jsonata-transformer`, `dynamic-worker`) are not migrated — they are deleted
with the legacy model unless a live subscription path turns up.

### D11. Processor self-registration moves to the host

`standardProcessorBehavior` (per-processor `processor-registered` self-append
with a `hasRegisteredCurrentVersion` state flag) is replaced by the host
appending one idempotency-keyed `processor-registered` event per slug+version
after each successful subscription handshake.

## Issues encountered

### I1. Atomic-checkpoint/shutdown commit broke the virtualized-scroll e2e

`41762ad81` (checkpoint upsert inside the projection transaction + browser
leader `shutdown()` + writer-lock release deferral) failed
`large streams stay virtualized and can scroll from tail to earliest rows`
twice in CI while the parent commit was green; mirror contents were complete
(event-count assertion passed) but the tail row never became visible —
i.e. a scroll/notification behavior change, not data loss. Reverted to unblock
#1401; root cause not yet established. Suspect the writer-lock release
deferral changing teardown/re-election timing during the seeding phase.

### I2. (running list — updated as migration proceeds)
