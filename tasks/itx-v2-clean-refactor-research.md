# Minimal ITX v2 Clean Refactor Research

This consolidates the subagent research on how to cleanly address the current
v2 prototype smells while reducing complexity, sprawl, and type gymnastics.

## Recommendation

Use the domain-first refactor with direct ITX target construction everywhere.

The model should be:

```ts
itx.agents.get(path); // Agent domain RPC handle
itx.agents.get(path).itx; // Agent ITX surface
env.ITX.get(); // Direct ProjectItxRpcTarget / AgentItxRpcTarget
```

But there is one important implementation caveat: the current generated
`makeRpcTargetClass()` turns getters into zero-argument RPC methods. With the
current generator, the actual remote call shape for a domain getter is likely:

```ts
itx.agents.get(path).itx().runScript(...)
```

not:

```ts
itx.agents.get(path).itx.runScript(...)
```

Do not add complexity solely to hide that unless property syntax becomes a hard
requirement. For the prototype, accepting `agent.itx()` is probably less gross
than hand-writing domain RPC targets or changing the shared wrapper generator.

## Fixed Design Constraints

- `ItxEntrypoint.get()` directly constructs `ProjectItxRpcTarget` or
  `AgentItxRpcTarget`.
- Domain `.itx` exposes direct construction too.
- Do not route `.itx` through `ctx.exports.ItxEntrypoint({ props }).get()`.
- Keep `makeRpcTargetClass(DomainDurableObject)` one-liners unless we hit a hard
  syntax or safety constraint.
- Avoid explicit `BUILTIN_ROOTS`; keep collision checking against the current
  ITX target shape.

## Clean Refactor Shape

### 1. Split ITX target base from project/agent specializations

Current smell:

```ts
export class AgentItxRpcTarget extends ProjectItxRpcTarget {
  declare readonly input: AgentItxTargetInput;
}
```

Clean shape:

```ts
type ItxProcessorHost = {
  invokeCapability(input: { args?: unknown[]; path: string[] }): unknown;
  provideCapability(input: { capability: unknown; path: string[] }): unknown;
  revokeCapability(input: { path: string[] }): unknown;
  runScript(input: { code: string }): unknown;
};

abstract class ItxRpcTarget extends RpcTarget {
  constructor(readonly input: { projectId: string }) {
    super();
  }

  protected abstract itxProcessorHost(): ItxProcessorHost;

  async provideCapability(input: { capability: unknown; path: string[] }) {
    this.#rejectBuiltinCollision(input.path);
    await this.itxProcessorHost().provideCapability(input);
    return new CapabilityProvision(() => this.revokeCapability({ path: input.path }));
  }

  revokeCapability(input: { path: string[] }) {
    return this.itxProcessorHost().revokeCapability(input);
  }

  runScript(input: { code: string }) {
    return this.itxProcessorHost().runScript(input);
  }

  [fallbackCall](path: (string | number)[], args: unknown[]) {
    return this.itxProcessorHost().invokeCapability({ args, path: path.map(String) });
  }
}
```

Then:

```ts
export class ProjectItxRpcTarget extends ItxRpcTarget {
  get project() { ... }
  get streams() { ... }
  get agents() { ... }
  get repos() { ... }
  get repo() { ... }

  protected itxProcessorHost() {
    return env.PROJECT.getByName(projectName(this.input.projectId)) as ItxProcessorHost;
  }
}
```

```ts
export class AgentItxRpcTarget extends ItxRpcTarget {
  constructor(readonly agentInput: { projectId: string; path: string }) {
    super(agentInput);
  }

  get agent() { ... }
  get project() { ... }
  get streams() { ... }
  get agents() { ... }
  get repos() { ... }
  get repo() { ... }

  protected itxProcessorHost() {
    return env.AGENT.getByName(agentName(this.agentInput)) as ItxProcessorHost;
  }
}
```

This removes `declare readonly input`, makes the host boundary explicit, and
keeps direct construction.

### 2. Rename `context()` to `itxProcessorHost()`

`context()` is vague. The value is not an execution context or Cap'n Web context;
it is the domain durable object stub that hosts the ITX processor.

Use:

```ts
protected itxProcessorHost(): ItxProcessorHost
```

Avoid:

- `context()`
- `host()` because stream processor host already uses that term
- `processor()` because this returns a DO RPC stub, not the processor instance
- `itx()` because domain objects should expose `.itx`

### 3. Make agent collection lookup domain-first

Current:

```ts
get(path: string) {
  return new AgentItxRpcTarget({ path, projectId: this.input.projectId });
}
```

Clean:

```ts
get(path: string) {
  return env.AGENT.getByName(
    formatDurableObjectName({ path, projectId: this.input.projectId }),
  ).getRpcTarget();
}
```

Then:

```ts
create({ path, ...input }: { path: string; [key: string]: unknown }) {
  return this.get(path).create(input);
}
```

This makes `agents`, `repos`, and `streams` all follow one rule:
collections return domain handles.

### 4. Add `.itx` to project and agent domain objects

Project:

```ts
get itx() {
  return new ProjectItxRpcTarget({ projectId: this.name.projectId });
}
```

Agent:

```ts
get itx() {
  return new AgentItxRpcTarget({
    path: this.name.path,
    projectId: this.name.projectId,
  });
}
```

This is direct construction. `ItxEntrypoint` remains the adapter used by dynamic
worker bindings, not an internal factory.

### 5. Centralize the stream loopback cast

Current repeated shape:

```ts
return this.ctx.exports.StreamDurableObject.getByName(this.ctx.id.name!) as StreamRpc;
```

Add one helper:

```ts
export function streamForContext(ctx: DurableObjectState): StreamRpc {
  return ctx.exports.StreamDurableObject.getByName(ctx.id.name!) as StreamRpc;
}
```

Then each DO can keep:

```ts
get stream() {
  return streamForContext(this.ctx);
}
```

This keeps the unavoidable Cloudflare RPC stub cast in one place.

Possible improvement: parse/require `ctx.id.name` once and pass a name string to
the helper if the generic `DurableObjectState` type fights `ctx.exports`.

### 6. Keep domain RPC one-liners, but be disciplined about public helpers

Current one-liner preference:

```ts
export const AgentRpcTarget = makeRpcTargetClass(AgentDurableObject);
```

Keep it for now. The clean rule is:

- public prototype methods/getters are RPC surface
- implementation helpers should be `#private`, class fields, or free functions
- do not add public helpers casually

Known accidental-ish public methods today:

- `getRpcTarget`
- `requestStreamSubscription`
- `stream`
- ITX processor forwarding methods
- `getWorkerSource`

Do not solve this with allowlists yet unless the prototype starts optimizing for
surface safety over minimality.

### 7. Client typing: small built-in surface, dynamic intersections

Do not try to derive perfect types from Worker classes or Cap'n Web internals.

Add small exported types in `src/client.ts`:

```ts
type DisposableRpc = { [Symbol.dispose]?: () => void };
export type RpcStub<T extends object> = T & DisposableRpc;
```

Then model only built-ins:

```ts
export type ProjectItxClient = ItxVerbs & {
  project: ProjectHandle;
  streams: StreamsCollection;
  agents: AgentsCollection;
  repos: ReposCollection;
  repo: RepoHandle;
};

export type AgentItxClient = ProjectItxClient & {
  agent: AgentHandle;
};
```

Because generated domain getters are methods, model domain handles that way for
now:

```ts
export type AgentHandle = {
  whoami(): Promise<string>;
  project(): ProjectHandle;
  itx(): AgentItxClient;
};
```

Dynamic test mounts should use local intersections:

```ts
type EchoItx = ProjectItxClient & {
  echo: { ping(input: { text: string }): Promise<string> };
};
```

Avoid a broad index signature on `ProjectItxClient`; it makes built-ins less
useful.

### 8. Update `withItx({ path })`

Once `agents.get(path)` returns the agent domain handle, this is wrong:

```ts
const target = path === "/" ? session : session.agents.get(path);
```

Change to:

```ts
const target = path === "/" ? session : session.agents.get(path).itx();
```

Again, this assumes current generated getter-as-method behavior.

### 9. Fix receiver-preserving local path replay

Client-side:

```ts
receiver = Reflect.get(receiver, path[i]);
...
return Reflect.apply(leaf, receiver, args);
```

Server-side `replayPath()` should get the same treatment.

This is not just style; local SDK objects often depend on `this`.

### 10. Centralize URL/default plumbing

Add:

```ts
export const DEFAULT_ITX_BASE_URL = "http://127.0.0.1:8789";
```

and helpers based on `new URL`, not `base.replace(/^http/, "ws")`.

Use them from:

- `src/client.ts`
- `e2e-env.ts`
- `scripts/repl.ts`
- `scripts/verify-miniflare.ts`
- `scripts/verify-deployed.ts`
- `vitest.config.ts`

## Test Updates

Update existing tests:

```ts
test("agents.get returns an agent domain handle", async () => {
  using itx = connect();
  const agent = itx.agents.get("/agents/bla");
  expect(await agent.whoami()).toBe("agent prj_ref:/agents/bla");
});
```

Agent ITX:

```ts
const agent = itx.agents.get("/agents/scripted");
const result = await agent.itx().runScript({ code });
```

Add a regression proving agent-hosted dynamic workers see agent ITX:

```ts
const agentItx = itx.agents.get("/agents/probe").itx();
await agentItx.provideCapability({ ... });
expect(await caller.probe.agentWhoami()).toBe("agent prj_ref:/agents/probe");
```

Keep the existing `env.ITX.get()` project-root dynamic worker test too.

## Rejected Alternatives

### Route `.itx` through `ctx.exports.ItxEntrypoint(...).get()`

Rejected. It adds a WorkerEntrypoint hop, hides the direct class shape, and makes
`ItxEntrypoint` an internal factory. The chosen model is direct construction.

### Hand-write Project/Agent domain RPC targets now

Rejected for now. This would give prettier property-style `.itx.runScript`, but
it adds more wrapper code and conflicts with the current one-liner wrapper
preference. Reconsider only if `agent.itx()` is unacceptable.

### Full client type derivation from server classes

Rejected. It fights the Worker-vs-Node type split and will likely add more type
machinery than clarity. Use small hand-written client-facing types.

## Implementation Order

1. Refactor `rpc-targets.ts`: `ItxRpcTarget` base, `itxProcessorHost()`,
   domain-first `AgentsRpcTarget.get()`.
2. Add direct `.itx` getters on Project/Agent DOs.
3. Add `streamForContext()` helper and replace repeated stream casts.
4. Update `withItx({ path })`.
5. Update tests for domain-first agents and agent `.itx()`.
6. Add minimal client types and remove `connect<any>()` from tests.
7. Fix receiver-preserving path replay on client and server.
8. Centralize URL defaults.
9. Run `types:wrangler:check`, `typecheck`, `verify:miniflare`, and deployed
   verification if needed.
