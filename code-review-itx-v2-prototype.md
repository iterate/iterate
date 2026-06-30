# Minimal ITX v2 Prototype Review

Scope: `apps/minimal-itx-v2`, with emphasis on code that feels gross,
suspicious, awkward, over-wrapped, over-typed, or unlike small hand-written RPC
code.

No files were changed by the review agents.

## Findings

### High: Local capability replay drops method receivers

File: `apps/minimal-itx-v2/src/client.ts`

```ts
const leaf = (receiver as Record<string, unknown>)[path.at(-1)!];
...
return leaf(...args);
```

This extracts a method from a local SDK object and calls it unbound. That is a
real behavioral risk for exactly the kind of class-backed local capability this
client is trying to support.

Recommended cleanup: use receiver-preserving reflection.

```ts
const leaf = Reflect.get(receiver, path.at(-1)!);
return Reflect.apply(leaf, receiver, args);
```

The same pattern exists server-side in `replayPath()` and should be cleaned up
there too.

### High: ITX host boundary is hidden behind duplicate protocol casts

File: `apps/minimal-itx-v2/src/itx/rpc-targets.ts`

```ts
type ItxContext = {
  invokeCapability(input: { args?: unknown[]; path: string[] }): unknown;
  provideCapability(input: { capability: unknown; path: string[] }): unknown;
  revokeCapability(input: { path: string[] }): unknown;
  runScript(input: { code: string }): unknown;
};

return env.PROJECT.getByName(this.#name("/")) as unknown as ItxContext;
```

The simple model is "forward these four ITX verbs to the domain durable object".
The code currently says "cast this generated stub through `unknown` to a local
shape". That is the main type-gymnastics smell in the RPC target layer.

Recommended cleanup: name the host protocol once, probably in the ITX contract
or processor module, and cast only at the Cloudflare RPC boundary.

```ts
export type ItxHost = {
  invokeCapability(input: { args?: unknown[]; path: string[] }): unknown;
  provideCapability(input: ProvideCapabilityInput): unknown;
  revokeCapability(input: { path: string[] }): unknown;
  runScript(input: { code: string }): unknown;
};
```

Then `host()`/`context()` can return `ItxHost` without a one-off `ItxContext`
type duplicated in the target file.

### High: `AgentItxRpcTarget` inherits from project ITX and narrows with `declare`

File: `apps/minimal-itx-v2/src/itx/rpc-targets.ts`

```ts
export class AgentItxRpcTarget extends ProjectItxRpcTarget {
  declare readonly input: AgentItxTargetInput;

  constructor(input: AgentItxTargetInput) {
    super(input);
  }
```

`declare readonly input` is a strong signal the hierarchy is fighting the data.
An agent ITX target is not really a project ITX target; they share verbs and
collections, but forward to different host durable objects.

Recommended cleanup: use a tiny base that carries `{ projectId, path }` and
implements the shared ITX verbs. Project and agent targets can then be two
small concrete classes with different `host()` implementations, without type-only
property narrowing.

### High: `withItx<T>` and `connect<any>()` hide the actual client shape

Files: `apps/minimal-itx-v2/src/client.ts`, `apps/minimal-itx-v2/itx.e2e.test.ts`

```ts
export function withItx<T = unknown>(input: WithItxInput): T {
  ...
  return new Proxy(target, {
    ...
  }) as T;
}
```

Tests then use:

```ts
using itx = connect<any>();
```

The client is a very specific thing: a Cap'n Web stub/proxy with capability
normalization and disposal. The generic says callers can choose any return type,
which pushes all clarity out to `any` call sites.

Recommended cleanup: define small local client-facing types for the reference
implementation: `RootItx`, `ProjectItx`, `AgentItx`, `StreamHandle`, and
`ProvidedCapability`. Dynamic capability leaves can stay permissive, but the
built-in tree and executable spec should not be `any`.

### Medium: Capability address validation hand-rolls the schema and casts anyway

File: `apps/minimal-itx-v2/src/itx/processor.ts`

```ts
const type = (capability as Record<string, unknown>).type;
...
return capability as CapabilityAddress;
```

`CapabilityAddress` is already a Zod schema. The code duplicates the
discriminator list in a `Set`, checks only `type`, and then asserts the full
shape.

Recommended cleanup: let the schema parse.

```ts
const parsed = CapabilityAddress.safeParse(capability);
if (parsed.success) return parsed.data;
```

Keep a friendly unsupported-type error if useful, but do not duplicate the
schema.

### Medium: Stream loopback cast is repeated across domain objects

Files:

- `apps/minimal-itx-v2/src/domains/projects/project-durable-object.ts`
- `apps/minimal-itx-v2/src/domains/agents/agent-durable-object.ts`
- `apps/minimal-itx-v2/src/domains/repos/repo-durable-object.ts`

```ts
return this.ctx.exports.StreamDurableObject.getByName(this.ctx.id.name!) as StreamRpc;
```

Using `ctx.exports.StreamDurableObject` is the right direction, but the same
cast and non-null assertion in three domain objects makes the Cloudflare type
boundary feel leaky.

Recommended cleanup: centralize it in one helper, for example
`streamForContext(ctx): StreamRpc`, or in a small base/helper that domain DOs
call from their `stream` getter.

### Medium: ITX processor completion handling is side-channel-y

File: `apps/minimal-itx-v2/src/itx/processor.ts`

```ts
let completedEvent: StreamEvent | undefined;
const completed = this.waitUntilEvent({
  predicate: (event) => {
    const payload = event.payload as CompletedPayload;
    ...
    completedEvent = event;
    return true;
  },
});
...
const event = completedEvent!;
const payload = event.payload as CompletedPayload;
```

The side-channel variable, repeated payload cast, and non-null assertion obscure
the simple behavior: append script execution requested, wait for matching
completed, return or throw.

Recommended cleanup: hide this in `#waitForScriptCompletion(executionId)` and
parse the payload once.

### Medium: Project and agent duplicate ITX façade methods

Files:

- `apps/minimal-itx-v2/src/domains/projects/project-durable-object.ts`
- `apps/minimal-itx-v2/src/domains/agents/agent-durable-object.ts`

```ts
provideCapability(input: ProvideCapabilityInput) {
  return this.itxProcessor.provideCapability(input);
}
revokeCapability(input: { path: string[] }) {
  return this.itxProcessor.revokeCapability(input);
}
invokeCapability(input: { args?: unknown[]; path: string[] }) {
  return this.itxProcessor.invokeCapability(input);
}
runScript(input: { code: string }) {
  return this.itxProcessor.runScript(input);
}
```

These four methods are only there so generated RPC targets can call the ITX
processor. It is simple, but it makes domain objects read like plumbing.

Possible cleanups:

1. Keep the methods. This is the most direct version and matches the current
   trusting `makeRpcTargetClass(DomainObject)` direction.
2. Extract a tiny helper/mixin for these four methods. This reduces duplication
   but adds abstraction.
3. Hand-write the domain RPC target. This makes exposure explicit, but conflicts
   with the current one-liner wrapper preference.

Recommendation: keep the methods for now unless they become the dominant visual
noise. The other issues are more worth fixing first.

### Medium: Type extraction in processor overrides is noisy

Files:

- `apps/minimal-itx-v2/src/itx/processor.ts`
- `apps/minimal-itx-v2/src/domains/projects/project-processor.ts`
- `apps/minimal-itx-v2/src/domains/agents/agent-processor.ts`
- `apps/minimal-itx-v2/src/domains/repos/repo-processor.ts`

```ts
}: Parameters<StreamProcessor<typeof ItxContract>["reduce"]>[0]) {
```

This is inherited from existing stream-processor style, but in the minimal
prototype it reads like framework spelunking.

Recommended cleanup: either export named arg types from the stream engine, or
use local aliases so method signatures stay readable.

### Low: `Storage.get()` cast is unnecessary

File: `apps/minimal-itx-v2/src/domains/dynamic-workers/dynamic-workers-rpc-target.ts`

```ts
const previous = (await this.#storage.get(versionKey)) as string | undefined;
```

Recommended cleanup:

```ts
const previous = await this.#storage.get<string>(versionKey);
```

### Low: Processor `retain` / `dispose` code is dense boundary plumbing

File: `apps/minimal-itx-v2/src/itx/processor.ts`

```ts
typeof (target as { dup?: unknown }).dup === "function"
...
(target as { [Symbol.dispose]: () => void })[Symbol.dispose]();
```

This is probably necessary at the live-capability boundary, but it makes the core
processor look like generic object surgery.

Recommended cleanup: either simplify with local variables, or move the live
capability retain/dispose mechanics into a tiny helper so the processor reads at
the event level.

### Low: URL construction and default base URL are duplicated

Files:

- `apps/minimal-itx-v2/src/client.ts`
- `apps/minimal-itx-v2/e2e-env.ts`
- `apps/minimal-itx-v2/scripts/repl.ts`
- `apps/minimal-itx-v2/scripts/verify-miniflare.ts`
- `apps/minimal-itx-v2/vitest.config.ts`

```ts
const base = input.baseUrl ?? process.env.ITX_BASE ?? "http://127.0.0.1:8789";
const wsBase = base.replace(/^http/, "ws");
```

Recommended cleanup: one `DEFAULT_BASE_URL` and one `toWebSocketUrl()` helper
using `new URL`.

### Low: Tiny pointless spreads

Files:

- `apps/minimal-itx-v2/src/domains/agents/agent-durable-object.ts`
- `apps/minimal-itx-v2/src/domains/repos/repo-durable-object.ts`

```ts
(deps) => new AgentProcessor({ ...deps })
(deps) => new RepoProcessor({ ...deps })
```

Recommended cleanup: pass `deps` directly.

## Decision Pressure

These findings are real, but the obvious cleanup conflicts with previous design
constraints.

### Generated domain RPC target one-liners

```ts
export const ProjectRpcTarget = makeRpcTargetClass(ProjectDurableObject);
export const AgentRpcTarget = makeRpcTargetClass(AgentDurableObject);
export const RepoRpcTarget = makeRpcTargetClass(RepoDurableObject);
export const StreamRpcTarget = makeRpcTargetClass(StreamDurableObject);
```

Risk: public helper methods/getters become remotely callable by accident.

Prior decision: use trusting one-liner wrappers, no explicit include arrays.

Recommended stance: keep one-liners for the prototype, but avoid adding public
helper methods that are not meant to be RPC. Use private methods or free
functions for implementation helpers.

### Built-in collision detection

```ts
if (root && root in this) {
  throw new Error(`cannot provide capability "${root}": it is already on this ITX target`);
}
```

Risk: the reserved vocabulary is implicit.

Prior decision: do not maintain `BUILTIN_ROOTS`; check the current object.

Recommended stance: keep reflection-based collision detection for now, but make
the error good and keep intentional built-ins as visible getters/methods.

# Plan (TODO)
