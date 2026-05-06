# Any Stream Processor Can Be A Tool Provider

## Question

Can any stream processor be usable as a codemode tool provider, while keeping the event stream as the durable surface and still taking advantage of Cloudflare Workers RPC / Cap'n Web for rich imperative calls?

Short answer: yes, but do not make events and RPC compete for ownership. Use stream events as the durable lifecycle and audit surface. Use narrow live RPC capabilities as the execution surface when a caller needs a result now, especially for provider-to-provider calls.

## Primary Source Grounding

Cloudflare Workers RPC exposes public methods on `WorkerEntrypoint` and `DurableObject` classes through service bindings and Durable Object stubs, and is intended to feel like ordinary JavaScript calls across Workers ([Workers RPC overview](https://developers.cloudflare.com/workers/runtime-apis/rpc/)). Durable Object RPC is the preferred method-call shape for projects on compatibility date `2024-04-03` or later; calls are async, accept/return serializable values, and propagate exceptions without stack traces ([Durable Object invoke methods](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/)).

The important Cap'n Web / Workers RPC properties for this design:

- Objects extending `RpcTarget` and plain functions can be passed by reference. The receiver gets a stub that calls back to where the object/function was created ([Workers RPC overview](https://developers.cloudflare.com/workers/runtime-apis/rpc/), [Cap'n Web README](https://github.com/cloudflare/capnweb)).
- RPC supports bidirectional calls and promise pipelining; a promise returned from RPC can be used for dependent method calls before awaiting it ([Workers RPC overview](https://developers.cloudflare.com/workers/runtime-apis/rpc/), [Cap'n Web README](https://github.com/cloudflare/capnweb)).
- RPC stubs are capabilities. If a callee has not received a stub, it cannot call that object. Dynamic Workers documentation makes this explicit: stubs have no global identifier and cannot be forged ([Dynamic Workers bindings](https://developers.cloudflare.com/dynamic-workers/usage/bindings/)).
- Stub lifetime is execution-context scoped unless explicitly duplicated/disposed. If stubs are passed in RPC parameters/results, the execution context may stay alive until stubs are disposed and calls through them return; received stubs are disposed when the call returns unless duplicated ([Workers RPC lifecycle](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/)).
- `ctx.props` can carry trusted deployment-time or loopback-provided scoping data, and `ctx.exports` can mint loopback bindings with dynamic props that are useful when passing scoped bindings into other Workers or Dynamic Workers ([Workers context docs](https://developers.cloudflare.com/workers/runtime-apis/context/)).
- Dynamic Workers let the parent choose exactly what bindings, network access, limits, and tailing the sandbox receives. The loader API supports `load()` for fresh one-off code and `get()` for cached isolates; the dynamic worker `env` may include structured clonable data and service bindings, including loopback bindings from `ctx.exports` ([Dynamic Workers overview](https://developers.cloudflare.com/dynamic-workers/), [Dynamic Workers API reference](https://developers.cloudflare.com/dynamic-workers/api-reference/)).
- Cap'n Web is designed to interoperate with built-in Workers RPC. Cap'n Web stubs/promises can be passed over Workers RPC and vice versa with proxying, given compatible runtime flags/dates ([Cap'n Web README](https://github.com/cloudflare/capnweb)).

Implication: live RPC capabilities are excellent for scoped authority and fast provider calls, but they are not durable state. Anything needed for replay, UI, audit, retry, or handoff after an execution context ends must be represented as stream events or JSON descriptors.

## Local Baseline

The shared processor contract already separates frontend-safe contracts from side-effecting implementations:

- `defineProcessorContract(...)` is a typed identity over `slug`, `version`, `description`, `stateSchema`, event catalog, `processorDeps`, `consumes`, `emits`, and optional pure `reduce` (`packages/shared/src/stream-processors/types.ts`, `packages/shared/src/stream-processors/stream-processor.ts`).
- Processor implementations expose `onStart` and `afterAppend`; `afterAppend` runs after reducer state is persisted for a live event (`packages/shared/src/stream-processors/types.ts`).
- `withStreamProcessorRunner(...)` binds one processor instance to one stream path in a Durable Object, persists reduced processor state, catches up from stream history, and consumes live events (`packages/shared/src/durable-object-utils/mixins/with-stream-processor-runner.ts`).

The current codemode processor is event-native:

- `tool-provider-registered` stores model-visible docs/instructions/type definitions by path.
- `script-execution-requested/completed` records script lifecycle.
- `function-call-requested/completed` records tool/function lifecycle.
- The implementation executes scripts on `script-execution-requested`, creates a session object, appends `function-call-requested`, and waits for a matching completion event (`packages/shared/src/stream-processors/codemode/contract.ts`, `packages/shared/src/stream-processors/codemode/implementation.ts`).

The OS2 `CodemodeSession` Durable Object already exposes imperative methods around those events:

- `createSession`, `startScriptExecution`, `registerToolProvider`, `executeScript`, `callFunction`.
- It registers itself as a callable stream subscriber by appending `events.iterate.com/core/stream-subscription-configured` with a Workers RPC callable targeting `afterAppend`.
- It passes a narrow `CodemodeSessionCapabilityTarget extends RpcTarget` into a Dynamic Worker, instead of passing the whole Durable Object stub (`apps/os2/src/durable-objects/codemode-session.ts`).

The local PoC proves the key RPC shape:

- Provider B can receive a live Provider A `RpcTarget` and call it.
- Provider B can call Provider A through a broker callback.
- Dynamic Worker code and provider-side code can construct the same `CodemodeContext` from a scoped session capability.
- Passing the literal `CodemodeSession` Durable Object stub from inside the session failed with `DataCloneError`; returning a fresh narrow `RpcTarget` facade worked (`apps/os2/tmp/codemode-rpc-providers-poc/README.md`, `apps/os2/tmp/codemode-rpc-providers-poc/entry.workerd.vitest.ts`).

Callable descriptors matter too:

- `Callable` is JSON, not authority. It names how to invoke something; live authority is supplied by `CallableContext` through `env`, `ctx.exports`, `fetch`, or loader bindings (`packages/shared/src/callable/types.ts`, `packages/shared/src/callable/README.md`).
- The callable task note already says tool providers are product-level records composed of one Callable, but internal providers should prefer capability-first APIs; JSON/MCP shapes are edge adapters (`packages/shared/src/callable/tasks/tool-providers.md`).

## Design Goals

1. A processor can publish tools without becoming a special processor kind.
2. Tool calls are durable enough for UI/audit/retry: request and terminal outcome are stream events.
3. Provider-to-provider calls do not require ambient namespace bindings or global addresses.
4. The ergonomic codemode API stays local: `ctx.providerA.math.add(...)`, with the proxy built inside the dynamic worker or provider execution context.
5. Documentation and type metadata are available before execution.
6. Authorization is capability-based: callers receive only scoped stubs/descriptors for paths they may call.
7. The event schema stays small and avoids encoding transport details.

## Candidate Designs

### Design A: Event-Only Provider Processors

Shape:

- A processor declares tool metadata in its contract or appends a provider registration event.
- The codemode script calls `ctx.foo.bar(input)`.
- The session appends `function-call-requested`.
- Any processor that consumes that event may respond by appending `function-call-completed`.
- The original caller waits by reading/subscribing to the stream after the request offset.

Pros:

- Cleanest event-sourced story.
- Providers can be installed/removed/replayed by stream history.
- No live stub handoff required for the basic path.
- Works for providers implemented outside Workers RPC if they can append outcomes.

Cons:

- Latency and scheduling are worse: every call pays append, processor delivery, provider work, append, subscription/read.
- Exactly-one responder is a registry/routing problem, not guaranteed by the event shape.
- Provider A calling Provider B means A appends another request and then waits for B's completion. If A is itself running inside an `afterAppend` that blocks the same runner or stream delivery path, this can deadlock or stall unless the runner supports concurrent live consumption.
- The current OS2 `CodemodeSession` stream API path has `subscribe()` unimplemented for processor-local use, so event-only waiting would need more runtime work.
- In-memory promises cannot be the source of truth. If the Durable Object wakes, restarts, or the execution context ends, pending in-memory waiters vanish.

Use this for long-running asynchronous workflows and external integrations where immediate return is not needed.

### Design B: Session Broker As The Only Imperative Provider Surface

Shape:

- `CodemodeSession` owns a provider registry keyed by path prefix.
- Code and providers receive a scoped `CodemodeSessionCapability extends RpcTarget`.
- Calling `ctx.providerB.some.tool(input)` invokes `session.callFunction({ path, input, scriptExecutionId })`.
- The session appends `function-call-requested`, dispatches to the provider through a live stub or Callable descriptor, appends `function-call-completed`, then returns/throws to the caller.
- Provider A calling Provider B also goes through the same session capability, not by directly holding Provider B's global binding.

Pros:

- One place owns routing, authorization, lifecycle events, nested call correlation, timeouts, and budgets.
- Provider-to-provider calls are natural and match the PoC.
- Providers do not need ambient access to each other. They receive only the scoped broker capability.
- Dynamic Worker and provider code use the same local context builder.
- Durable events are still appended for every call.

Cons:

- The broker becomes central runtime infrastructure.
- A provider that wants pure event-only execution still needs an adapter path.
- The session must avoid reentrancy traps when it dispatches to a provider that calls back into the same session.

This is the best first production shape.

### Design C: Every Processor Runner Exposes A Provider RPC Surface

Shape:

Each processor runner may additionally implement:

```ts
type StreamProcessorToolProviderRpc = {
  describeToolProvider(): Promise<ToolProviderDocumentation>;
  callToolFunction(input: {
    path: string[];
    input: unknown;
    callContext: ToolCallContext;
    session?: CodemodeSessionCapability;
  }): Promise<unknown>;
};
```

The session registry maps a path prefix to a callable/stub for that processor's provider surface. The processor still consumes events in normal `afterAppend`, but direct tool execution uses RPC.

Pros:

- Any processor can be a provider without forcing all calls through event-only completion.
- Existing processor boundaries remain intact.
- Provider implementation can use warm runner state, in-memory clients, timers, or MCP sessions created in `onStart`.
- The session can dispatch to providers uniformly through `callToolFunction(...)`.

Cons:

- Processor contracts need a way to declare provider metadata without importing runtime bindings.
- A runner may now have two side-effect surfaces: `afterAppend` and `callToolFunction`. The reportable lifecycle must stay in events to avoid invisible work.
- Long-lived returned stubs must be disposed/duplicated carefully.

This is compatible with Design B and should be the extensibility point.

### Design D: Direct Provider-To-Provider RpcTarget Handoff

Shape:

The session or host passes Provider B's live `RpcTarget` directly to Provider A for one call graph.

Pros:

- Fastest and most capability-pure for a known composition.
- Proven by the PoC.
- No global registry lookup once the call graph is constructed.

Cons:

- Not durable, not serializable, and not discoverable after the execution context ends.
- Harder to audit unless all calls still route through a lifecycle appender.
- Leaks more topology into providers unless the handoff is carefully scoped.

Use this as an optimization inside one execution graph, not the canonical model.

## Provider A Calling Provider B

The recommended rule: Provider A should call Provider B through the same scoped session/broker capability that codemode scripts use.

That means Provider A receives a `CodemodeSessionCapability` or smaller `ToolBrokerCapability` with:

```ts
type ToolBrokerCapability = {
  callFunction(input: {
    path: string[];
    input: unknown;
    parentFunctionCallId?: string;
    scriptExecutionId?: string;
  }): Promise<unknown>;
};
```

Provider A constructs its local tool proxy from that capability. When it calls `ctx.providerB.foo(...)`, the session appends a nested `function-call-requested`, routes by longest path prefix, appends completion, and returns the value to Provider A.

The broker should carry `parentFunctionCallId` or equivalent metadata so the event log can render a call tree. This metadata should not be needed for routing.

Direct handoff of Provider B's `RpcTarget` to Provider A is acceptable only when the session minted it for this exact call and still appends lifecycle events around the invocation.

## In-Memory Promise Juggling

Use in-memory promises only as an optimization for currently-live callers.

Acceptable pattern:

- Append request event.
- Store `pendingCalls.set(functionCallId, { resolve, reject, expiresAt })` in the session or runner instance.
- Dispatch provider via RPC.
- On completion, append completed event, resolve/reject waiter, delete map entry.
- On wake/catch-up, never try to resurrect old waiters; use stream events to observe final state.

Event-only waiters can read history after the request offset first, then subscribe from that cursor. This is what the current shared codemode implementation sketches. It needs a real subscription implementation in the OS2 session path if used there.

Avoid:

- Waiting inside the same serialized `afterAppend` path for another event that only the same blocked path can produce.
- Persisting live stubs or promise IDs in stream state.
- Treating a missing in-memory waiter as failure. The durable completed event is authoritative.

Timeouts should append failed/cancelled outcomes only from the owner that accepted responsibility for the call. Other observers should not synthesize terminal events.

## Route Composition

Use a path-prefix registry:

```ts
type ToolProviderRoute = {
  path: string[];
  providerId: string;
  processorSlug?: string;
  callable?: Callable;
  liveTarget?: RpcTarget; // only in memory, never persisted
  docs: ToolProviderDocumentation;
  policy: ToolProviderPolicy;
};
```

Routing rule: longest prefix wins. If two active providers register the same path, registration should fail or the later event should explicitly replace the earlier provider; do not allow duplicate responders.

Recommended separation:

- Durable registry event stores `path`, provider identity, documentation, type metadata, and a JSON callable/descriptor if the provider is resumable.
- Live registry cache may additionally hold an `RpcTarget` minted for the current execution graph.
- Session broker chooses live target first when present, otherwise resolves the JSON callable through a narrow `CallableContext`.

This lets processors be providers in three forms:

1. Static provider: contract metadata plus runtime implementation registered by deployment.
2. Callable-backed provider: durable JSON descriptor names a service/DO/dynamic worker.
3. Live provider: current execution graph passes a scoped `RpcTarget`.

## Documentation And Type Metadata

There are two different metadata needs:

- Processor contract metadata: stable, frontend-safe, importable, replayable. This is where a processor can declare that it owns tool paths and type/docs schemas without importing bindings.
- Runtime registration metadata: stream event saying this provider is active on this stream/session with this path, docs, instructions, and callable/policy.

Current `ToolProviderDocumentation` has `path`, `docs`, optional `instructions`, and optional `typeDefinitions`. Keep that as the minimal model-visible shape.

For stronger routing and validation, add optional structured function metadata later:

```ts
type ToolFunctionDocumentation = {
  path: string[];
  description: string;
  inputSchema?: unknown; // JSON Schema or Zod-derived JSON Schema
  outputSchema?: unknown;
};
```

Do not require structured schemas for the first slice. TypeScript definitions are enough for codemode ergonomics, and runtime validation can remain provider-owned until a concrete validation boundary is needed.

## Authorization

Authority should be attached to capabilities, not inferred from event text.

Rules:

- A stored `Callable` or provider registration event is not authority by itself. Dispatching it with `env`, `ctx.exports`, `fetch`, or a loader binding is the authority grant.
- Dynamic Worker code receives only the session/broker binding, logger binding, and explicitly allowed provider/context bindings. Use `globalOutbound: null` unless a specific egress capability is intended.
- Provider code receives a scoped broker capability, not broad Durable Object namespaces.
- The broker checks path allowlists, stream/project scope, provider visibility, call depth, timeout, and budget before dispatching.
- `ctx.props` is a good place for authentic scope such as `projectId`, `streamPath`, `providerPath`, `permissions`, and `executionId` when minting loopback service bindings.
- Returned `RpcTarget` objects should be narrow facades. Do not pass the whole session/runner stub when a three-method capability is enough.

Policy can start small:

```ts
type ToolProviderPolicy = {
  allowedCallerPathPrefixes?: string[][];
  allowedCalleePathPrefixes?: string[][];
  maxNestedCalls?: number;
  timeoutMs?: number;
};
```

The first required checks are path prefix authorization and max call depth.

## Minimal Event Schemas

Keep the durable lifecycle independent of transport. Do not encode "called over RPC" or "called over fetch" in the event names.

Recommended minimal event set, staying close to the current `function-call-*` contract:

```ts
type ToolProviderRegistered = {
  path: string[];
  docs: string;
  instructions?: string;
  typeDefinitions?: string;
  providerId?: string;
};
```

```ts
type FunctionCallRequested = {
  functionCallId: string;
  path: string[];
  input: unknown;
  scriptExecutionId?: string;
  parentFunctionCallId?: string;
};
```

```ts
type FunctionCallCompleted = {
  functionCallId: string;
  path: string[];
  durationMs?: number;
  outcome: { status: "succeeded"; output: unknown } | { status: "failed"; error: unknown };
};
```

This matches the current shared codemode processor closely. If the team prefers offset correlation from the OS2 exploration, use `functionCallRequestedOffset` instead of `functionCallId`, but do not use both unless UI/cross-stream tracing needs both. For provider-to-provider trees, a stable `functionCallId` is more portable than offsets.

For script execution, keep the existing shape:

```ts
type ScriptExecutionRequested = {
  scriptExecutionId: string;
  code: string;
};
```

```ts
type ScriptExecutionCompleted = {
  scriptExecutionId: string;
  durationMs?: number;
  outcome: { status: "succeeded"; output: unknown } | { status: "failed"; error: unknown };
};
```

Do not split succeeded/failed events until there is a strong consumer need. The current discriminated `outcome` keeps event count smaller and makes reducers simpler.

## Recommendation

Adopt a hybrid broker/provider model:

1. Keep stream events as the source of truth for registration, script execution, function-call request, function-call completion, and logs.
2. Make `CodemodeSession` or a small `ToolBroker` capability the only default object passed into Dynamic Workers and provider executions.
3. Let any stream processor opt into being a tool provider by adding provider metadata to its contract and by registering a route to either:
   - a live `RpcTarget` for the current execution graph,
   - a durable JSON `Callable`,
   - or an event-only responder for async workflows.
4. Route calls by longest path prefix through the broker. Providers should call other providers by calling the broker, not by resolving ambient bindings.
5. Append lifecycle events inside the broker around every provider call, even when the actual dispatch is direct RPC.
6. Keep in-memory pending promise maps as a live convenience only; stream completion events are the durable completion record.
7. Start with documentation/type metadata as `ToolProviderDocumentation` and add structured per-function schemas later.

This gives the product the user-facing simplicity of "any processor can provide tools" without making every processor invocation depend on slow event-only request/reply. It also matches Cloudflare's capability model: live stubs carry authority across one execution graph; JSON descriptors and stream events carry durable intent and history.

## Open Questions

- Should provider metadata live directly on `ProcessorContractShape`, or should processors append/register it through a standard event on attachment?
- Should call correlation standardize on `functionCallId` now, or should OS2 switch to offset correlation before the first UI contract hardens?
- Does the session broker live inside `CodemodeSession`, or should it become its own reusable stream capability for non-codemode processors?
- How much provider policy is stream-local versus deployment-local?
- Should event-only responders be supported in the first slice, or deferred until the RPC-backed route is stable?
