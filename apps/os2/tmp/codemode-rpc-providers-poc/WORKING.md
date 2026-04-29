# Codemode Stream Working Notes

This is a live working document for the codemode/event-stream redesign. Keep it
close to the PoC while decisions are still moving.

## Current Direction

- Codemode is event-stream native.
- Use one stream per codemode session.
- Do not nest streams for blocks or providers yet.
- `executeScript({ code })` appends a start event and returns the committed
  event immediately, including `{ streamPath, offset }`.
- UI-friendly oRPC can be an adapter: append/start, subscribe from the returned
  offset, then yield matching outcome events.
- The events app stream is the eventual source of truth. The temp
  `CodemodeSession` in-memory stream is only a standalone proof.
- Tool Function call authority is a scoped `CodemodeSessionCapability` carried
  as an `RpcTarget`.
- Dynamic-worker code and provider code should use the same local
  `CodemodeContext` builder. The RPC boundary carries a narrow session target;
  the ergonomic JS object is constructed locally on the caller side.
- Tool providers live directly on the `CodemodeContext` root by default:
  `ctx.providerA.math.add(...)`, not `ctx.tools.providerA.math.add(...)`. A
  provider may still choose the root name `tools` if it wants that namespace.
- Session controls are grouped under `ctx.codemode`: `ctx.codemode.append(...)`,
  `ctx.codemode.getSessionId()`, `ctx.codemode.executeScript(...)`, and
  `ctx.codemode.abortSignal`. They are not Tool Functions and do not create
  Tool Function lifecycle events.
- Passing the literal `CodemodeSession` Durable Object stub from inside the
  session failed in workerd with a `DataCloneError`. Keep a narrow
  `CodemodeSessionCapability` facade unless Cloudflare gives us a cleaner
  scoped-stub primitive for this.
- A DO method can return the facade: `getScopedRpcTarget()` returns a fresh
  `RpcTarget` capability. Access policy is deliberately deferred.
- For now, codemode code is explicit: users provide `async (ctx) => { ... }`.
  `ctx` is a `CodemodeContext`.
- The current PoC proves bidirectional provider calls: Provider A calls Provider
  B, and Provider B calls Provider A through the same scoped session target.

## Event Type Prefix

Use host-style event type strings with no `https://` prefix:

```text
events.iterate.com/codemode/...
```

## Core Events

Working set:

- `events.iterate.com/codemode/tool-provider-registered`
- `events.iterate.com/codemode/script-execution-requested`
- `events.iterate.com/codemode/script-execution-succeeded`
- `events.iterate.com/codemode/script-execution-failed`
- `events.iterate.com/codemode/tool-function-call-requested`
- `events.iterate.com/codemode/tool-function-call-succeeded`
- `events.iterate.com/codemode/tool-function-call-failed`
- `events.iterate.com/codemode/log-emitted`

Likely next events:

- `events.iterate.com/codemode/tool-provider-described`
- `events.iterate.com/codemode/execution-cancelled`

## Payload Sketches

Execution function shape:

```ts
type ExecutionTools = {
  providerA: {
    math: {
      add(input: { left: number; right: number }): Promise<{ value: number }>;
    };
    text: {
      upper(input: { value: string }): Promise<{ value: string }>;
    };
  };
  providerB: {
    somePath: {
      myFunction(input: { value: string }): Promise<{ value: string }>;
    };
    compose: {
      addThenUpper(input: { left: number; right: number }): Promise<{ value: string }>;
    };
  };
};

type CodemodeContext = {
  codemode: {
    append(input: EventInput): Promise<AppendedEvent>;
    getSessionId(): Promise<string>;
    executeScript(input: { code: string }): Promise<AppendedEvent>;
    abortSignal: AbortSignal;
  };
} & ExecutionTools;

export default async (ctx: CodemodeContext) => {
  await ctx.codemode.append({
    type: "events.iterate.com/codemode/log-emitted",
    payload: { message: `running in ${await ctx.codemode.getSessionId()}` },
  });
  return await ctx.providerB.compose.addThenUpper({ left: 19, right: 23 });
};
```

`tool-provider-registered`:

```ts
{
  path: string[];
}
```

`script-execution-requested`:

```ts
{
  executionId: string;
  code: string;
}
```

`script-execution-succeeded`:

```ts
{
  executionId: string;
  result: unknown;
}
```

`script-execution-failed`:

```ts
{
  executionId: string;
  error: string;
}
```

`tool-function-call-requested`:

```ts
{
  callId: string;
  executionId?: string;
  path: string[];
  payload: unknown;
}
```

`tool-function-call-succeeded`:

```ts
{
  callId: string;
  requestedOffset: number;
  path: string[];
  result: unknown;
}
```

`tool-function-call-failed`:

```ts
{
  callId: string;
  requestedOffset: number;
  path: string[];
  error: string;
}
```

## Open Questions

- Should `callId` be globally unique or scoped to `executionId`?
- Should `tool-function-call-*` events include `providerPath` and `toolPath` separately,
  or keep one full `path` array?
- Should provider registration include type definitions inline, or should
  `tool-provider-described` be a separate event?
- Should logs be attached to `executionId`, `callId`, or both?
- Should cancellation append a request event first, then produce a terminal
  `execution-cancelled` event?
- Does the oRPC adapter return only legacy `CodemodeEvent` shapes, or should the
  UI move straight to events-contract `Event` envelopes?

## Next Implementation Steps

1. Move event constants and payload schemas into a shared codemode module.
2. Replace current `ToolDispatcher` map with a scoped `callToolFunction` target.
3. Make provider execution receive a scoped `CodemodeSessionCapability`.
4. Persist events through the real events app instead of the temp in-memory log.
5. Design the provider/tool access policy tracked in
   `tasks/codemode-capability-policy.md`.
