# Codemode RPC Provider PoC

Standalone Workers runtime proof of concept for tool-provider delegation across
separate Durable Object instances.

The important shape:

- `ProviderA` owns concrete tool functions.
- `ProviderB` owns no bindings or addresses for `ProviderA`.
- `CodemodeHost` creates live `RpcTarget` capabilities and passes them across
  RPC boundaries.
- `CodemodeSession` owns `callToolFunction()` and hands out a scoped
  `CodemodeSessionCapability` as an `RpcTarget`.
- Tool functions live at the `CodemodeContext` root. Codemode control functions
  live under `ctx.codemode`.

Proven paths:

1. `ProviderB` receives a live `ProviderAHandle extends RpcTarget` and calls it.
2. `ProviderB` receives a live `ToolBroker extends RpcTarget` that calls back
   into the codemode host, and the host routes to another provider.
3. `CodemodeExecutor` injects only provider B into generated code; provider B
   delegates the actual Tool Function Call back through the codemode host
   broker.
4. Codemode code uses the explicit `async (ctx) => { ... }` shape, where `ctx`
   is the constructed `CodemodeContext`.
5. A provider implementation can build the same local execution context from a
   scoped session capability and call `await ctx.otherProvider.somePath.myFunction({})`.
6. The same provider-side proxy works when the thing passed to provider A is a
   plain callback function instead of an `RpcTarget` broker.
7. A session-shaped DO can pass the same scoped capability to a dynamic worker
   and to provider executions, so both construct the same `CodemodeContext`
   locally.
8. `executeScript()` appends and returns the committed start event
   immediately, including its offset. An oRPC handler can use that offset to
   subscribe to the session/events stream and expose matching outcome events as
   an async iterator for UI ergonomics.

Run from repo root:

```bash
pnpm --dir packages/shared exec vitest run --config ../../apps/os2/tmp/codemode-rpc-providers-poc/vitest.config.ts
```

Real events service proof:

```bash
pnpm --dir apps/os2 exec tsx tmp/codemode-rpc-providers-poc/real-events-service-proof.ts
```

Design note: the key capability is the live `RpcTarget`, not a serializable
descriptor. A serializable callable can name an env binding, but it cannot carry
the authority of "this exact provider A instance" unless the receiver already
has enough ambient bindings to resolve it. Passing an `RpcTarget` lets the
Codemode Session mint a narrow callback capability and hand it to another worker
or Durable Object without giving that callee broad namespace access.

Proxy note: do not pass a JavaScript `Proxy` object across Workers RPC. Pass a
small `RpcTarget` broker or callback function, then construct the ergonomic
tool-function proxy inside the worker/Durable Object that is executing the
provider tool function.

Session note: the cleanest prototype is `CodemodeSession.scopedRpcTarget()`,
which returns a narrow `RpcTarget` implementing `CodemodeSessionCapability`.
`executeScript()` passes that capability to the dynamic worker.
`callToolFunction()` passes the same capability to provider execution, so
provider A can call provider B through exactly the same
`createCodemodeContext(capability)` helper as sandboxed code. The capability has
two surfaces: `callToolFunction()` for provider functions, and direct codemode
control methods used by `ctx.codemode.*`.

Stub note: passing the literal `CodemodeSession` Durable Object stub from inside
the session to another Durable Object/dynamic worker failed in workerd with
`DataCloneError: Could not serialize object of type "DurableObject"`. The
working shape is a DO method like `getScopedRpcTarget()` that returns a fresh
narrow `CodemodeSessionCapability` facade over the session.

Events-app note: this PoC stores events in memory on `CodemodeSession` only to
keep the experiment standalone. The production shape should append these same
event inputs to a real events app stream. The os2 oRPC method can be an adapter:
append the block-start event, get back `{ streamPath, offset }`, subscribe from
that cursor with the events client, then yield matching outcome events as an
oRPC async iterator for existing UI code.

Current execution code shape:

```ts
async (ctx) => {
  const value = await ctx.providerB.compose.addThenUpper({ left: 19, right: 23 });
  await ctx.codemode.append({
    type: "events.iterate.com/codemode/log-emitted",
    payload: { message: "called providerB.compose.addThenUpper" },
  });
  return value;
};
```
