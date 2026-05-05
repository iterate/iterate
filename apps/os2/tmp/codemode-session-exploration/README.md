# Codemode Session Exploration

This folder is a design scratchpad for turning the previous RPC-provider PoC
into a real OS2 `CodemodeSession` Durable Object.

Nothing here is production code. The point is to make the design alternatives
specific enough to critique when Jonas is back.

## Current Locked Shape

- `CodemodeSession` is a Durable Object in a tiny dedicated worker.
- The main OS2 worker invokes it through a `CODEMODE_SESSION` namespace binding.
- The Durable Object uses the shared mixin stack:
  - `withLifecycleHooks`
  - `withD1ObjectCatalog`
  - `withOuterbase`
  - `withKvInspector`
- The existing OS2 D1 database is bound into the tiny worker as `DO_CATALOG`.
- The public identity is `Event Stream Path`, not `sessionId`.
- There is at most one `CodemodeSession` per `Event Stream Path`.
- `CodemodeSession` calls the events service directly for now.
- `executeScript()` appends `script-execution-requested`, starts work, and
  returns the committed event immediately.
- `Script Execution` is identified by the requested event offset:
  `scriptExecutionRequestedOffset`.
- The session owns the Tool Provider registry. The one-shot oRPC handler may
  register providers before calling `executeScript()`.

## Prototype Files

- [session-api-sketch.ts](./session-api-sketch.ts) sketches the mixin stack,
  direct events-service append, provider registry cache, provider dispatch, and
  scoped capability.
- [context-proxy-sketch.ts](./context-proxy-sketch.ts) sketches the tiny
  `CodemodeContext` helper copied into dynamic workers.
- [event-payload-sketch.ts](./event-payload-sketch.ts) sketches the codemode
  event types and offset-based correlation payloads.
- [stream-processor-variant.ts](./stream-processor-variant.ts) sketches the
  more radical future where the session reacts to appended request events.
- [alchemy-shape-sketch.ts](./alchemy-shape-sketch.ts) sketches the tiny worker
  resource topology.
- The self-callable sketch graduated into
  `packages/shared/src/codemode/self-callable.ts`.

## API Shape Under Pressure

### Core Session API

```ts
type CodemodeSessionInitParams = {
  name: string;
  streamPath: StreamPath;
};

type CodemodeSession = {
  getStreamPath(): Promise<StreamPath>;
  append(input: EventInput): Promise<{ event: Event }>;
  registerToolProvider(descriptor: ToolProviderDescriptor): Promise<{ event: Event }>;
  executeScript(input: { code: string }): Promise<{ event: Event }>;
  callToolFunction(input: {
    path: string[];
    payload: unknown;
    scriptExecutionRequestedOffset?: number;
  }): Promise<unknown>;
  getScopedRpcTarget(): Promise<CodemodeSessionCapability>;
};
```

`initialize()` exists, but only as inherited lifecycle-mixin API. Normal callers
should use `getOrInitializeDoStub()`.

### One-Shot oRPC Adapter

```ts
async function* executeOneShot(input) {
  const session = await getOrInitializeDoStub({
    namespace: env.CODEMODE_SESSION,
    initParams: { streamPath: input.streamPath },
  });

  for (const provider of input.providers) {
    await session.registerToolProvider(provider);
  }

  const started = await session.executeScript({ code: input.code });

  yield* collectScriptExecutionEvents({
    streamPath: input.streamPath,
    afterOffset: started.event.offset - 1,
    scriptExecutionRequestedOffset: started.event.offset,
  });
}
```

This keeps `providers` out of core `executeScript()`. They belong to either the
session registry or to the one-shot adapter that populates that registry.

## Permutations Worth Discussing

### Execution Trigger Model

Option A: RPC starts execution.

```ts
await session.executeScript({ code });
```

Option B: stream append starts execution.

```ts
await events.append({
  path,
  event: {
    type: "events.iterate.com/codemode/script-execution-requested",
    payload: { code },
  },
});
```

Recommendation for the first slice: implement Option A internally by appending
the request event, but keep the body small enough that Option B becomes possible
later. Eventually `CodemodeSession` can behave like a real stream processor that
observes request events appended by anyone.

### Provider Registry Source Of Truth

Recommendation: append registry events and maintain a DO-local KV cache.

- Event stream is canonical.
- KV cache makes first implementation simple and fast.
- Future replay can rebuild the cache from stream history.

Alternative: only KV. Rejected because provider registration would be invisible
to the event stream.

Alternative: only event replay. Clean, but makes the first vertical slice depend
on replay/subscription correctness before we prove dynamic-worker execution.

### Registry Event Payload

Option A:

```ts
{
  path: ["linear"],
  descriptor: ToolProviderDescriptor
}
```

Option B:

```ts
{
  path: ["linear"],
  providerId: "linear-dev",
  descriptor: ToolProviderDescriptor
}
```

Recommendation for now: Option A. The path is the registry key. Add provider IDs
later if we need renaming, versioning, or multiple providers at one path.

### Provider Registration Idempotency

Recommendation: `idempotencyKey = tool-provider-registered:${path.join("/")}`.

Open issue: this makes re-registering a provider at the same path no-op in the
events service. If we want replacement, use a descriptor hash in the key and let
the session cache pick the latest event by offset.

### Tool Function Call Correlation

Recommendation: no `callId` yet. Use event offsets:

- `tool-function-call-succeeded.payload.toolFunctionCallRequestedOffset`
- `tool-function-call-failed.payload.toolFunctionCallRequestedOffset`
- include `scriptExecutionRequestedOffset` when the call belongs to a Script
  Execution

Open issue: for cross-stream calls or external UI traces, offsets are less
portable than IDs. Do not add IDs until we hit that requirement.

### Dynamic Worker Result Correlation

Recommendation: append:

```ts
{
  type: "events.iterate.com/codemode/script-execution-succeeded",
  payload: {
    scriptExecutionRequestedOffset: 123,
    result
  }
}
```

or failed:

```ts
{
  type: "events.iterate.com/codemode/script-execution-failed",
  payload: {
    scriptExecutionRequestedOffset: 123,
    error
  }
}
```

### Abort Signal

Recommendation: `ctx.codemode.abortSignal` exists locally, but cancellation is
not yet a real distributed cancellation protocol.

First implementation can pass a local signal into dynamic worker evaluation. A
future event-driven version should append cancellation-requested/cancelled events
and have long-running tool providers observe them.

### Provider Bridge Execution Input

Current descriptor dispatch payload should be:

```ts
{
  path: string[];
  payload: unknown;
  codemodeSessionCapability: CodemodeSessionCapability;
}
```

This lets bridges/providers call back to the session exactly like dynamic
workers do. The OpenAPI bridge may ignore the capability. MCP bridge probably
ignores it at first too, but provider-provided code can use it.

### Bridge Export Location

Option A: provider bridges live in the main OS2 worker exports. The OS2 worker
uses `ctx.exports` to create live self-capabilities for those exports, then
passes those capabilities to the tiny `codemode-session-do` worker when it needs
non-JSON capability passing.

Option B: provider bridges live in the tiny session worker exports too.

Option C: provider bridges are addressed as self-callables: the descriptor names
the source worker script and named entrypoint so another worker can call the
same app worker through a Service Binding to that named entrypoint.

Recommendation: use Option C for serializable Provider Descriptors, and reserve
Option A for live capability plumbing inside one request/RPC graph. The tiny
session worker should remain mostly session logic plus dynamic-worker loading.

Important runtime finding: `dispatchCallable()` resolves `loopback-binding`
against the `CallableContext.exports` of the Worker doing the dispatch. Once
dispatch moves into the tiny `codemode-session-do` worker, loopback descriptors
that currently expect main OS2 exports will not resolve unless the session
worker also exports those bridge classes or receives another explicit dispatch
capability.

That pushes me toward either:

- export lightweight bridges from `codemode-session-do` too, or
- stop using `loopback-binding` for provider descriptors that need to be called
  from Codemode Sessions, and use explicit service/DO env bindings instead.

Cloudflare's named Worker entrypoints give us a cleaner self-callable model:
another Worker can configure a Service Binding to a specific named
`WorkerEntrypoint` export. `ctx.exports` can still create loopback bindings with
dynamic props, and those props can contain Service Bindings. That means the app
can mint a live self-capability for short-lived RPC handoff, but any descriptor
that is stored in the session registry should name the worker script and
entrypoint explicitly.

### Self-Callables

A self-callable is a Provider Descriptor created by an app that points back to a
named `WorkerEntrypoint` exported by the same app worker.

Conceptually:

```ts
createSelfToolProvider({
  workerScriptName: "os2-jonas",
  entrypoint: "OpenApiBridge",
  path: ["petstore"],
  props: {
    specUrl: "https://petstore.swagger.io/v2/swagger.json",
    baseUrl: "https://petstore.swagger.io/v2",
  },
});
```

This is different from `loopback-binding`:

- `loopback-binding` means "resolve this export from the currently dispatching
  Worker".
- self-callable means "call this named entrypoint on this specific Worker
  script".

The app abstraction should expose the deployed worker script name as runtime
metadata, because a serialized self-callable needs stable script identity after
it leaves the worker that created it. `initAlchemy()` already computes
`ctx.workerName`; the missing piece is carrying that into app runtime metadata
or into the Provider Descriptor factory.

Alchemy already has the deployment-side shape for this:
`Worker.experimentalEntrypoint(workerOrSelf, "OpenApiBridge")` emits a Service
Binding with `service` and `entrypoint`. It also has `Self`, which emits a
Service Binding back to the current worker script with an optional entrypoint.
Current Alchemy warns that experimental entrypoint bindings are not supported in
local development, so workerd/Vitest proof should stay separate from
local-Alchemy proof until that gap closes.

That means the current callable runtime can already call a named entrypoint if
the env binding was created for that entrypoint:

```ts
type ServiceEntrypointProviderDescriptor = {
  path: string[];
  workerScriptName: string;
  entrypoint: string;
  executeToolFunction: {
    type: "workers-rpc";
    rpcMethod: "executeToolFunction";
    via: {
      type: "env-binding";
      bindingType: "service";
      bindingName: "SELF_OS2_JONAS_OPEN_API_BRIDGE";
    };
  };
};
```

The first-class extension we may still want is not runtime
`getEntrypoint(...)`; it is a descriptor/deployment abstraction that remembers
the target worker script and named entrypoint, then guarantees the required
Service Binding exists in every worker that may dispatch the descriptor:

```ts
type SelfEntrypointBinding = {
  type: "env-binding";
  bindingType: "service";
  bindingName: string;
  workerScriptName: string;
  entrypoint: string;
};
```

### Session As Stream Processor

Mild version: `executeScript()` and `registerToolProvider()` are RPC methods
that append events and update local cache.

Strong version: the only write API is `append()`, and the session reacts to
events from its stream. A caller appends `script-execution-requested`; the
session processes it and appends terminal events.

Recommendation: mild version first. The strong version is where we want to go,
but it needs a durable subscription/replay story so we do not miss events when
the DO is cold.

### Local Registry Cache Shape

Option A: one KV key with the whole registry object.

Option B: one KV key per provider path.

Option C: local SQLite table.

Recommendation: Option A for first slice, because registry size is likely small
and the code is easy to reason about. Move to Option C if provider lists get
large, frequently replaced, or need local querying by path prefix.

### Provider Prefix Resolution

Option A: longest registered provider-path prefix wins. This supports leaf
providers and nested provider namespaces.

Option B: reject overlapping provider paths at registration time. This prevents
ambiguous mental models.

Recommendation: Option A, but append a warning or reject exact duplicate paths
unless replacement semantics are explicitly enabled.

## Questions For Later

1. Should `registerToolProvider()` replacement be allowed, or is provider path
   immutable once registered on a stream?
2. Should provider registry events store the full descriptor, or only a
   descriptor reference once we have more provider catalog infrastructure?
3. Should `append()` on the Codemode Control Surface allow arbitrary event types,
   or only codemode/event-contract-approved types?
4. Should a Tool Function be allowed to call `ctx.codemode.executeScript()`, or
   should nested script execution be reserved for scripts only?
5. Should `executeScript()` append `script-execution-requested` before or after
   loading provider descriptions/type definitions?
6. Should `describeToolProviders()` append `tool-provider-described`, or just
   return descriptions for UI/editor use?
7. Should oRPC one-shot execution create a stream path when absent, or require
   the caller to pass one so the stream-first model is explicit?
8. Should the tiny `codemode-session-do` worker export provider bridges too, or
   should provider bridge callables resolve through the main OS2 worker exports?
9. Should the session catalog index include organization/project information, or
   is `streamPath` enough for discovery?
10. Should `callToolFunction()` pick longest provider-path prefix, or should the
    registry reject overlapping provider paths entirely?
