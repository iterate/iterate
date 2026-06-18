# Minimal ITX v2 cleanup fix research

This plan covers the current `apps/minimal-itx-v2` prototype only. The goal is to keep the v2 shape intentionally small: hand-written RPC targets, data-only target props, domain Durable Objects as the authority, and a tiny stream-backed ITX processor.

## 1. `Reflect.apply` / `Reflect.get` forwarding in `itx/rpc-targets.ts`

Current smell:

- [apps/minimal-itx-v2/src/itx/rpc-targets.ts:54](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/src/itx/rpc-targets.ts:54) through [apps/minimal-itx-v2/src/itx/rpc-targets.ts:75](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/src/itx/rpc-targets.ts:75) forward `provideCapability`, `revokeCapability`, `runScript`, and `fallbackCall` with `Reflect.apply(Reflect.get(host, method), host, [input])`.
- `itxHost()` is declared as `object` at [apps/minimal-itx-v2/src/itx/rpc-targets.ts:78](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/src/itx/rpc-targets.ts:78), which forces dynamic property access even though the host methods are known.

Why it exists:

- The host is a Durable Object stub from `env.PROJECT.getByName(...)` or `env.AGENT.getByName(...)`.
- Those stubs are Cloudflare `Rpc.Provider<T>` values. Direct calls against generated stub types can trigger deep conditional type expansion, especially through Cap'n Web / workerd `Rpc.Provider`.
- The current code works, but the workaround leaks into the center of the API and obscures the actual forwarding contract.

Recommended fix:

- Keep one tiny local type for the host surface and return that from `itxHost()`.
- Prefer direct method calls in the RPC target methods.
- If TypeScript still expands too deeply on the concrete Durable Object stub, localize the cast inside `ProjectItxRpcTarget.itxHost()` and `AgentItxRpcTarget.itxHost()`, not at every call site.

Concrete shape:

```ts
type ItxHost = {
  invokeCapability(input: { args?: unknown[]; path: string[] }): unknown;
  provideCapability(input: ProvideCapabilityInput): unknown;
  revokeCapability(input: { path: string[] }): void | Promise<void>;
  runScript(input: { code: string }): RunScriptResult | Promise<RunScriptResult>;
};

abstract class ItxRpcTarget extends RpcTarget implements ProjectItxRpc {
  protected abstract itxHost(): ItxHost;

  provideCapability(input: ProvideCapabilityInput) {
    this.#rejectBuiltinCollision(input.path);
    void this.itxHost().provideCapability(input);
    return { revoke: () => this.revokeCapability({ path: input.path }) };
  }

  revokeCapability(input: { path: string[] }) {
    return this.itxHost().revokeCapability(input);
  }

  runScript(input: { code: string }) {
    return this.itxHost().runScript(input);
  }

  [fallbackCall](path: (string | number)[], args: unknown[]) {
    return this.itxHost().invokeCapability({ args, path: path.map(String) });
  }
}
```

- If `void this.itxHost().provideCapability(input)` is too loose because the method should wait for persistence, make `ItxHost.provideCapability(...)` return `void | Promise<void>` and `await` it as today.
- Use the existing `ItxProcessorHostRpc` from [apps/minimal-itx-v2/src/itx-types.ts:21](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/src/itx-types.ts:21) if its `provideCapability` return can be tightened. Right now it returns `unknown`, so a small local `ItxHost` is clearer.

Estimated risk:

- Low runtime risk. It should compile to the same calls.
- Medium typecheck risk because this is exactly where the previous workaround was introduced. If direct calls hit TS2589 again, use one cast at the stub-return boundary:

```ts
protected itxHost(): ItxHost {
  return env.PROJECT.getByName(this.name("/")) as unknown as ItxHost;
}
```

Fix now or defer:

- Fix now. This is the highest-leverage readability cleanup.

## 2. Over-generic `ItxRpcTarget` base and `ItxTargetProps` / `AgentItxTargetProps`

Current smell:

- [apps/minimal-itx-v2/src/itx/rpc-targets.ts:18](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/src/itx/rpc-targets.ts:18) declares `ItxTargetProps`.
- [apps/minimal-itx-v2/src/itx/rpc-targets.ts:22](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/src/itx/rpc-targets.ts:22) declares `AgentItxTargetProps`.
- [apps/minimal-itx-v2/src/itx/rpc-targets.ts:26](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/src/itx/rpc-targets.ts:26) makes the base generic only so `AgentItxRpcTarget` can add `path`.

Why it exists:

- Project ITX only needs `{ projectId }`.
- Agent ITX needs `{ projectId, path }`.
- The generic avoids duplicating shared getters and verbs, but it makes a small hand-written file feel type-framework-ish.

Recommended fix:

- Keep a minimal base, but make it non-generic and store only `projectId`.
- Store `path` directly on `AgentItxRpcTarget`.
- Drop `ItxTargetProps` and `AgentItxTargetProps` unless a later change introduces enough reuse to justify them.

Concrete shape:

```ts
abstract class ItxRpcTarget extends RpcTarget implements ProjectItxRpc {
  constructor(readonly projectId: string) {
    super();
  }

  get project() {
    return new ProjectRpcTarget({ path: "/", projectId: this.projectId });
  }
}

export class ProjectItxRpcTarget extends ItxRpcTarget {
  protected itxHost() {
    return env.PROJECT.getByName(this.name("/")) as unknown as ItxHost;
  }
}

export class AgentItxRpcTarget extends ItxRpcTarget implements AgentItxRpc {
  constructor(readonly props: { path: string; projectId: string }) {
    super(props.projectId);
  }

  get agent() {
    return new AgentRpcTarget(this.props);
  }
}
```

Alternative:

- Split `ProjectItxRpcTarget` and `AgentItxRpcTarget` completely and duplicate the five shared getters plus four verbs. That is arguably more "Kenton Varda" for a reference implementation, but it increases maintenance and can drift. The non-generic base is the best balance.

Estimated risk:

- Low. This is a mechanical shape change with no behavior change.

Fix now or defer:

- Fix now, right after the `ItxHost` cleanup. It removes the named one-use props types and makes the file easier to read.

## 3. Collection target boilerplate in `AgentsRpcTarget`, `ReposRpcTarget`, `StreamsRpcTarget`

Current smell:

- [apps/minimal-itx-v2/src/itx/rpc-targets.ts:113](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/src/itx/rpc-targets.ts:113) and [apps/minimal-itx-v2/src/itx/rpc-targets.ts:127](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/src/itx/rpc-targets.ts:127) carry `props: ItxTargetProps`.
- [apps/minimal-itx-v2/src/domains/streams/streams-rpc-target.ts:5](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/src/domains/streams/streams-rpc-target.ts:5) carries inline `{ projectId: string }`.
- All three classes are real RPC targets, but their constructors are visually noisy for one field.

Why it exists:

- Collection targets need to remember `projectId` so `.get(path)` can return a data-only domain RPC target for the right project.
- They must extend `RpcTarget` to be returned over Cap'n Web as references.

Recommended fix:

- Do not introduce a factory.
- Use the same hand-written style in all three classes:

```ts
export class AgentsRpcTarget extends RpcTarget implements AgentsRpc {
  constructor(readonly projectId: string) {
    super();
  }

  get(path: string) {
    return new AgentRpcTarget({ path, projectId: this.projectId });
  }

  create({ path, ...input }: { path: string } & Record<string, unknown>) {
    return this.get(path).create(input);
  }
}
```

- Apply the same pattern to `ReposRpcTarget` and `StreamsRpcTarget`.
- Call sites become `new AgentsRpcTarget(this.projectId)`, `new ReposRpcTarget(this.projectId)`, `new StreamsRpcTarget(this.projectId)`.

Estimated risk:

- Low. The behavior is unchanged and the constructor payload gets simpler.

Fix now or defer:

- Fix now with the base cleanup. This removes `ItxTargetProps` entirely.

## 4. `client.ts` WebSocket cast

Current smell:

- [apps/minimal-itx-v2/src/client.ts:64](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/src/client.ts:64) casts `ws.WebSocket` through `unknown` to `Parameters<typeof newWebSocketRpcSession>[0]`.

Why it exists:

- Cap'n Web declares `newWebSocketRpcSession(webSocket: WebSocket | string, ...)` in `capnweb/dist/index.d.ts`.
- Node's `ws.WebSocket` is not the same type as the DOM/workerd `WebSocket`.
- The cast is a Node-side compatibility bridge, not an ITX design issue.

Recommended fix:

- Prefer passing the URL string to `newWebSocketRpcSession` when no custom headers are needed.
- For auth headers, keep `ws`, but isolate the compatibility cast behind a tiny helper with a name that says what boundary it crosses.

Concrete shape:

```ts
function capnwebSocket(socket: WebSocket): WebSocket {
  return socket as unknown as WebSocket;
}

export function connect<T extends RpcCompatible<T>>(
  url: string,
  headers?: Record<string, string>,
): RpcStub<T> {
  if (!headers) return newWebSocketRpcSession<T>(url);
  return newWebSocketRpcSession<T>(
    capnwebSocket(new WebSocket(url, { headers, handshakeTimeout: 10_000 })),
  );
}
```

- This cannot literally name both imports `WebSocket`; alias Node's import:

```ts
import NodeWebSocket from "ws";

function capnwebSocket(socket: NodeWebSocket): WebSocket {
  return socket as unknown as WebSocket;
}
```

- Do not use `Parameters<typeof newWebSocketRpcSession>[0]`; it is less clear than the actual boundary type.

Estimated risk:

- Low. The authenticated path still uses the same runtime object.
- Medium if `newWebSocketRpcSession(url)` cannot set headers and tests accidentally rely on token auth. Keep the `ws` path for headers.

Fix now or defer:

- Fix now. It reduces the ugliest cast in client-facing code and lets unauthenticated local REPL sessions avoid `ws` entirely.

## 5. `localStream()` cast over `ctx.exports.StreamDurableObject.getByName(...)`

Current smell:

- [apps/minimal-itx-v2/src/domains/streams/local-stream.ts:23](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/src/domains/streams/local-stream.ts:23) returns:

```ts
ctx.exports.StreamDurableObject.getByName(name) as unknown as LocalStream;
```

Why it exists:

- `worker-configuration.d.ts` does correctly generate `STREAM: DurableObjectNamespace<import("./src/worker").StreamDurableObject>` at [apps/minimal-itx-v2/worker-configuration.d.ts:14](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/worker-configuration.d.ts:14).
- It also wires `GlobalProps.mainModule` and durable namespaces at [apps/minimal-itx-v2/worker-configuration.d.ts:4](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/worker-configuration.d.ts:4).
- However, `ctx.exports.StreamDurableObject.getByName(name)` returns a Cloudflare RPC stub/provider of the durable object class, not the local `LocalStream` structural type.
- The helper intentionally exposes only the stream methods needed by processors.

Recommended fix:

- Keep the boundary cast, but name the returned type as the local RPC surface and make the cast the only cast in the file.
- Reuse `StreamRpc` if possible, plus `waitForEvent`, instead of maintaining a mostly duplicate `LocalStream`.

Concrete shape:

```ts
type LocalStream = Pick<StreamRpc, "append" | "appendBatch"> & {
  waitForEvent(args: {
    afterOffset?: number;
    eventTypes?: readonly string[];
    predicate: (event: StreamEvent) => boolean | Promise<boolean>;
    timeoutMs: number;
  }): Promise<StreamEvent>;
};

function localStreamStub(ctx: DurableObjectState, name: string): LocalStream {
  return ctx.exports.StreamDurableObject.getByName(name) as unknown as LocalStream;
}
```

- If wrangler types can type `ctx.exports.StreamDurableObject` directly after regenerating, try removing the cast in a compile-only experiment. Expected result: a cast is still needed because Cap'n Web/Cloudflare stubbifies the Durable Object surface.
- Keep the cast in `localStream.ts`; do not spread it to domain objects.

Estimated risk:

- Low. This is a boundary helper with stable behavior.

Fix now or defer:

- Defer unless touching stream helpers. The current cast is already localized and defensible.

## 6. `CompletedPayload` casts in `processor.ts`

Current smell:

- [apps/minimal-itx-v2/src/itx/processor.ts:27](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/src/itx/processor.ts:27) declares a one-use-ish `CompletedPayload`.
- [apps/minimal-itx-v2/src/itx/processor.ts:285](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/src/itx/processor.ts:285) and [apps/minimal-itx-v2/src/itx/processor.ts:295](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/src/itx/processor.ts:295) cast `event.payload as CompletedPayload`.

Why it exists:

- `waitUntilEvent` returns generic `StreamEvent`, not a narrowed event from `ItxContract`.
- The reducer/processEvent path narrows event payloads because the stream processor contract types are available there, but the generic wait path does not.

Recommended fix:

- Add a small type guard or parser next to `#waitForScriptCompletion`.
- Prefer using the contract's zod payload schema if it is easy to access. If not, define one local schema for completed payload and infer its type from zod.

Concrete shape:

```ts
const ScriptExecutionCompletedPayload = z.looseObject({
  error: z.string().optional(),
  executionId: z.string(),
  result: z.unknown().optional(),
});

function completedPayload(event: StreamEvent) {
  if (event.type !== "events.iterate.com/itx/script-execution-completed") return null;
  return ScriptExecutionCompletedPayload.parse(event.payload);
}
```

- Then `#waitForScriptCompletion` can store `{ event, payload }` and `runScript` can use the parsed payload without casts.
- Better option if `defineProcessorContract` exposes event type helpers: use the contract-derived type. I did not find an obvious exported helper in the v2 code, so the local zod schema is the least surprising fix.

Estimated risk:

- Low to medium. Adds runtime validation on the completion event path. That is probably good, but it may surface malformed events earlier than today.

Fix now or defer:

- Fix now if the file is already being cleaned. Otherwise defer; the current casts are localized and the event type is checked immediately before one of them.

## 7. Dynamic worker `runScript` cast in `processor.ts`

Current smell:

- [apps/minimal-itx-v2/src/itx/processor.ts:315](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/src/itx/processor.ts:315) casts the dynamic worker result to `{ run(): Promise<unknown> }`.

Why it exists:

- `DynamicWorkersRpcTarget.get(ref)` returns `Promise<unknown>` at [apps/minimal-itx-v2/src/domains/dynamic-workers/dynamic-workers-rpc-target.ts:35](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/src/domains/dynamic-workers/dynamic-workers-rpc-target.ts:35).
- Cloudflare `WorkerStub.getEntrypoint(...)` can be typed with a branded `WorkerEntrypoint`, but the dynamic worker module is a source string. The host TypeScript program cannot import that runtime class.

Recommended fix:

- Define a tiny interface for the script runner surface near the script execution code.
- Add an optional generic to `DynamicWorkersRpcTarget.get<T = unknown>(ref): Promise<T>` so callers can state the expected surface at the call site without a cast expression.

Concrete shape:

```ts
type ScriptRunner = {
  run(): Promise<unknown>;
};

// DynamicWorkersRpcTarget
async get<T = unknown>(ref: DynamicWorkerRef): Promise<T> {
  return (await this.#resolve(ref)) as T;
}

// ItxProcessor
const worker = await this.#dynamicWorkers.get<ScriptRunner>(this.#scriptWorkerRef(input.code));
const result = await worker.run();
```

- This still has a cast, but it is localized inside the dynamic worker boundary where it belongs.
- Do not over-model dynamic worker entrypoint classes in static TypeScript for this prototype.

Estimated risk:

- Low. Runtime behavior is identical.

Fix now or defer:

- Fix now. It makes the processor read like intent instead of assertion.

## 8. Other obvious grossness and streamlining candidates

Current smells:

- `retain()` and `dispose()` in [apps/minimal-itx-v2/src/itx/processor.ts:69](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/src/itx/processor.ts:69) through [apps/minimal-itx-v2/src/itx/processor.ts:97](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/src/itx/processor.ts:97) contain repeated structural casts for `dup` and `Symbol.dispose`.
- `LiveCapability` and `retainLiveCapability()` at [apps/minimal-itx-v2/src/itx/processor.ts:140](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/src/itx/processor.ts:140) through [apps/minimal-itx-v2/src/itx/processor.ts:157](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/src/itx/processor.ts:157) are legitimate but a little abstract for the "tiny processor" goal.
- `replayPath()` uses `Reflect.get` / `Reflect.apply` at [apps/minimal-itx-v2/src/itx/processor.ts:99](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/src/itx/processor.ts:99) through [apps/minimal-itx-v2/src/itx/processor.ts:125](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/src/itx/processor.ts:125). This is legitimate dynamic capability path traversal, unlike the fixed-method forwarding in `rpc-targets.ts`.
- `Parameters<StreamProcessor<typeof ItxContract>["reduce"]>[0]` at [apps/minimal-itx-v2/src/itx/processor.ts:176](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/src/itx/processor.ts:176) and the same pattern at [apps/minimal-itx-v2/src/itx/processor.ts:222](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/src/itx/processor.ts:222) are noisy, but likely inherited from the stream processor base.
- `WithItxInput` and `WithRootInput` in [apps/minimal-itx-v2/src/client.ts:29](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/src/client.ts:29) and [apps/minimal-itx-v2/src/client.ts:35](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/src/client.ts:35) are tiny exported one-use types. They may be useful client API names, so they are not urgent.
- `Record<string, unknown>` create payloads repeat across [apps/minimal-itx-v2/src/itx-types.ts:45](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/src/itx-types.ts:45), [apps/minimal-itx-v2/src/itx-types.ts:54](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/src/itx-types.ts:54), [apps/minimal-itx-v2/src/itx-types.ts:65](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/src/itx-types.ts:65), and the durable object methods. This is not a type smell yet; a named `CreateInput` would probably be worse until semantics exist.
- `ItxProcessorHostRpc.provideCapability(...)` returns `unknown` at [apps/minimal-itx-v2/src/itx-types.ts:23](/Users/jonastemplestein/.superset/worktrees/iterate/medieval-fibre/apps/minimal-itx-v2/src/itx-types.ts:23), while the processor returns `{ path }` and the public ITX target returns `{ revoke }`. This is a real contract ambiguity.

Recommended fixes:

- Leave `replayPath()` dynamic reflection alone. That is the core dynamic path invoker.
- Replace repeated `dup` / `Symbol.dispose` casts with two tiny guards only if editing processor anyway:

```ts
function hasDup(value: unknown): value is { dup(): unknown } { ... }
function hasDispose(value: unknown): value is { [Symbol.dispose](): void } { ... }
```

- Consider renaming `LiveCapability` to `MountedCapability` if keeping it. It represents the retained in-memory mount at a path, not every live capability in the system.
- Tighten `ItxProcessorHostRpc.provideCapability` to the processor return if it is meant to model the domain DO host:

```ts
provideCapability(input: ProvideCapabilityInput): { path: string[] } | Promise<{ path: string[] }>;
```

- Keep public `ItxVerbsRpc.provideCapability` returning `{ revoke() }`; that is a separate outward-facing convenience.
- Do not introduce `CreateInput` or generic collection factories yet.

Estimated risk:

- Low for guard extraction and naming.
- Medium for `ItxProcessorHostRpc.provideCapability` return tightening because it can reveal mismatches between host DOs and public ITX targets. That is still a useful mismatch to reveal.

Fix now or defer:

- Fix `ItxProcessorHostRpc.provideCapability` with the `ItxHost` cleanup.
- Defer `retain` / `dispose` guard extraction unless processor readability is the active focus.
- Defer `Parameters<...>` method arg cleanup unless the stream processor package offers obvious exported arg types.

## Suggested implementation order

1. Replace `rpc-targets.ts` Reflect forwarding with direct calls through a tiny `ItxHost` type, using boundary casts only in `itxHost()` if needed.
2. Make `ItxRpcTarget` non-generic and remove `ItxTargetProps` / `AgentItxTargetProps`; store `projectId` directly and only keep `props` where both `projectId` and `path` are needed.
3. Change collection targets to `constructor(readonly projectId: string)` and keep them hand-written.
4. Hide the Node `ws` compatibility cast behind a named helper and use URL-string sessions when headers are absent.
5. Add `DynamicWorkersRpcTarget.get<T = unknown>()` plus a `ScriptRunner` type at the processor call site.
6. Tighten or parse script completion payloads if touching `processor.ts`; otherwise defer.
7. Leave `localStream()` cast localized for now, possibly deriving `LocalStream` from `StreamRpc` to reduce duplicate method declarations later.
