# Agents Domain — Stream Processor Class Migration Notes

Migrates `agent`, `agent-chat`, `openai-ws`, `cloudflare-ai`, `jsonata-reactor`
(from `packages/shared/src/stream-processors/`, originals left in place) and the
inline `agent-host` (from the OS runner) onto the class-based `StreamProcessor`
model under `apps/os/src/domains/agents/stream-processors/`, hosted directly on
`AgentDurableObject` via `createStreamProcessorHost`.

## What landed

- `apps/os/src/domains/agents/stream-processors/{agent,agent-chat,openai-ws,cloudflare-ai,jsonata-reactor,agent-host}/{contract,implementation}.ts`
  plus unit tests for agent, agent-chat, openai-ws, jsonata-reactor.
- `AgentDurableObject` registers all six processors on a
  `createStreamProcessorHost` and exposes `requestStreamSubscription`.
- `agent-stream-subscriptions.ts` emits `{ type: "callable" }` subscribers via
  `durableObjectProcessorSubscriber({ bindingName: "AGENT", durableObjectName,
processorName })`; the idempotency-key suffix changed `:workers-rpc` →
  `:callable` so the new subscription lands on existing streams (same
  `subscriptionKey`, so it replaces the legacy built-in subscriber in stream
  state). `agentProcessorRunnerName` is deleted.
- Event wire formats are unchanged: same event types, payload schemas, and
  idempotency-key derivations (`<slug>/<key>@<sourceOffset>` via
  `buildProcessorIdempotencyKey`).

## blockProcessorWhile vs runInBackground, per processor

- **agent** — all per-event appends (schedule/cancel/queue/status/rewrites) run
  under `blockProcessorWhile`. They are idempotency-keyed, but they are not
  best-effort: a dropped `llm-request-scheduled` means no response, and
  `runInBackground` failures advance the checkpoint so the event is never
  re-delivered. Blocking gives at-least-once retry semantics matching the old
  runner's `blockProcessorUntil`. The debounce-timer handoff
  (`llm-request-requested`) fires outside any batch and goes through
  `runInBackground` (keep-alive backed), the equivalent of the old
  `deps.waitUntil`.
- **agent-chat** — `blockProcessorWhile` (a dropped rewrite is a lost user
  message).
- **openai-ws** — the whole LLM request executes under `blockProcessorWhile`,
  matching the legacy OS runner (which awaited `afterAppend` without a detached
  `waitUntil`). The `requests` state map dedupes completed requests on
  re-delivery.
- **cloudflare-ai** — same as openai-ws.
- **jsonata-reactor** — reactions under `blockProcessorWhile`; rule-produced
  reactions may lack idempotency keys, so the checkpoint must not advance past
  a failed append.
- **agent-host** — exactly the legacy split: `ensureAgentRunnerForOwnStream`
  in `runInBackground` (blocking it would deadlock against the agent's
  onInstanceWake catch-up wait, which waits on agent-host itself), codemode
  bridging under `blockProcessorWhile`.

## openai-ws connection lifecycle

The WebSocket connection and `previousResponseId` moved from
`createOpenAiWsProcessor`'s closure to instance fields on `OpenAiWsProcessor`.
The hosting Durable Object instance is the connection scope, same as the old
runner DO: sequential requests reuse the socket while it is open; eviction
drops the warm connection and the next request opens a fresh one (distinct
`connectionId`). The legacy OS fallback survives: when `readOpenAiApiKey(env)`
is empty, the `"openai-ws"` host name is served by a `CloudflareAiProcessor`
instance.

## Decisions / deviations

- **standardProcessorBehavior dropped (per D11).** Migrated contracts no longer
  carry `hasRegisteredCurrentVersion` state or consume/emit
  `events.iterate.com/core/stream-processor-registered`; the host announces
  contracts via `stream/processor-registered`. Historical `core/...registered`
  events on existing streams are simply not consumed any more. Checkpoint
  state shape changed, but checkpoints live under new host KV keys, so no
  snapshot migration is needed.
- **`consumesAllEvents` → `"*"` in consumes** (jsonata-reactor, agent-host).
  This matters doubly now: the host passes `contract.consumes` as the
  subscription's event-type filter, so only `"*"` consumers get unfiltered
  delivery.
- **Reducer placement.** Reducers live on the classes, but the agent's pure
  reduction is also exported from `agent/contract.ts`
  (`reduceAgentEvent`/`reduceAgentEvents`) because the LLM provider processors
  and the agent's debounce handoff rebuild agent state from raw stream history
  (`isAgentLlmRequestStillCurrent`, `requestScheduledLlmWork`). Precedent:
  circuit-breaker keeps pure state helpers in its contract module.
- **`readStreamEvents` dep.** The old model's `streamApi.read` has no host
  equivalent (the host's iterate context only appends). Processors that need
  history (`agent`, `openai-ws`, `cloudflare-ai`) take a `readStreamEvents`
  dep; `AgentDurableObject` implements it by resolving the subscription's
  `namespace`/`path` from `host.runtimeState(name).subscription` and calling
  `STREAM.getByName(...).getEvents(...)`.
- **agent-host stream context is late-bound.** The processor is constructed at
  DO field-init time, before any handshake, so its
  `getStreamContext()` dep reads `host.runtimeState("agent-host").subscription`
  lazily. Safe because the host fills that state during the handshake that
  precedes any `ingest`.
- **Catch-up semantics changed in `waitForAgentProcessorsCatchUp`.** With
  consumes-filtered delivery (D9), a processor's checkpoint only reaches the
  offset of the last event it consumes — never the stream head, unless it
  consumes `"*"`. The wait now computes a per-processor target offset (max
  offset of consumed-type events in history; `maxOffset` for wildcard
  consumers) instead of comparing every checkpoint against `maxOffset`, which
  would always time out (5s) for filtered processors.
- **Runtime-state shape.** `getRuntimeState()` keeps its outward shape; both
  `reducedThroughOffset` and `afterAppendCompletedThroughOffset` now map to the
  single class-model checkpoint offset (the class has one checkpoint by design,
  written only after blocking side effects complete).
- **Codemode contract dep.** The new agent contract's `processorDeps` still
  imports the legacy `CodemodeProcessorContract` from `@iterate-com/shared`
  (for `codemode/tool-provider-registered`). Repoint it when the codemode
  domain migrates and the legacy tree is deleted.
- **Module layout to avoid an import cycle.** The agent-host handlers
  (`ensureAgentRunnerForOwnStream`, `handleAgentOutputAddedForCodemode`,
  `handleCodemodeScriptExecutionCompletedForAgent`, `extractCodemodeScript`,
  `codemodeCompletionInputBlock`) moved from `agent-durable-object.ts` into
  `stream-processors/agent-host/implementation.ts`; agent DO naming
  (`getAgentDurableObjectName`, `AgentDurableObjectStructuredName`,
  `AGENTS_STREAM_PATH`) moved into `agent-stream-subscriptions.ts` (which needs
  the DO name for callable subscribers anyway). `agent-durable-object.ts`
  re-exports all of them, so existing importers — including the legacy runner,
  which this migration must not edit — keep working.

## Issues hit

- **zod version skew broke contract typing.** The lockfile had
  `packages/streams` on zod 4.4.3 while apps/os and everything else resolved
  4.3.6. zod 4.4 bumps `_zod.version.minor`, making the two structurally
  incompatible, so `defineProcessorContract` calls from apps/os against the
  streams package failed to typecheck (and tsc OOM'd in one mixed
  configuration). Converging everything UP to 4.4.3 cascaded errors into
  better-auth/apps/auth typings; converging DOWN is the minimal fix:
  `packages/streams` zod is now pinned `~4.3.6` (4-line lockfile diff).
  Follow-up: bump the whole workspace to one zod version deliberately.
- **`@iterate-com/shared/streams/compiled-jsonata` had no package export**;
  added one so the migrated jsonata-reactor can reuse the shared compiled
  expression cache (apps/os has no direct jsonata dependency).
- **JSONata rules no longer see `streamPath` on the event.** The legacy
  adapter evaluated rules against the legacy event shape (with `streamPath`
  injected); the class processor evaluates the raw new-runtime event. A rule
  matching on `streamPath` would silently stop matching.
- **Stream-level side effects of unconsumed events.** `getEvents`-based
  helpers (`readStreamEvents`) parse consumed events strictly
  (`getEventSchema` is a strict object); any historical consumed-type event
  with unexpected extra top-level fields would throw during state rebuilds —
  same strictness the legacy reducer path had, just noted.
- Pre-existing (not addressed here): the legacy
  `apps/os/src/domains/streams/durable-objects/stream-processor-runner.ts`
  fails typecheck on this branch (`circuitBreakerProcessor`/
  `echoExampleProcessor` no longer exported by `@iterate-com/streams`). That
  file is owned by the orchestrator's cleanup pass.
