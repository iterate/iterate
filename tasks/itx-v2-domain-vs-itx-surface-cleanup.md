# Minimal ITX v2: Separate Domain RPC From ITX RPC

## Problem

The v2 prototype currently blurs two separate ideas:

1. Domain RPC targets: project, agent, repo, stream durable object APIs.
2. ITX RPC targets: the contextual capability surface backed by an ITX processor.

The worst example is `AgentsRpcTarget.get()`:

```ts
get(path: string) {
  return new AgentItxRpcTarget({ path, projectId: this.input.projectId });
}
```

That means `itx.agents.get("/agents/foo")` does **not** behave like
`itx.streams.get(...)` or `itx.repos.get(...)`. It returns an agent ITX surface,
not the agent durable object's domain RPC target. The caller then needs to know
that domain methods live behind `.agent`, which is backwards.

The second bad smell is `ProjectItxRpcTarget.context()`:

```ts
protected context(): ItxContext {
  return env.PROJECT.getByName(this.#name("/")) as unknown as ItxContext;
}
```

`context()` is too vague. It is not the Cap'n Web connection context, the worker
execution context, the durable object context, or an ITX context object. It is
the durable object stub that owns the ITX processor and exposes the ITX processor
verbs over RPC.

## Target Model

The stateless ITX root should be a capability tree that contains normal domain
RPC handles:

```ts
itx.project; // Project durable object RPC target
itx.streams.get(path); // Stream durable object RPC target
itx.agents.get(path); // Agent durable object RPC target
itx.repos.get(path); // Repo durable object RPC target
itx.repo; // Alias for itx.repos.get("/repos/project")
```

Domain durable objects that host an ITX processor should expose their contextual
ITX surface explicitly:

```ts
itx.project.itx; // Project ITX surface
itx.agents.get(path).itx; // Agent ITX surface
```

The top-level `/api/itx/:projectId` endpoint can still return the project ITX
surface directly for convenience:

```ts
const itx = new ProjectItxRpcTarget({ projectId });
```

Dynamic workers can still use:

```ts
env.ITX.get();
```

because `ItxEntrypoint` still receives `{ projectId, path }` props and returns
the ITX surface for that host path.

## Naming Cleanup

Replace `ItxContext` and `context()` with names that say what they are.

Recommended names:

```ts
type ItxProcessorHost = {
  invokeCapability(input: { args?: unknown[]; path: string[] }): unknown;
  provideCapability(input: { capability: unknown; path: string[] }): unknown;
  revokeCapability(input: { path: string[] }): unknown;
  runScript(input: { code: string }): unknown;
};
```

```ts
protected itxProcessorHost(): ItxProcessorHost {
  return env.PROJECT.getByName(this.#name("/")) as ItxProcessorHost;
}
```

For agents:

```ts
protected override itxProcessorHost(): ItxProcessorHost {
  return env.AGENT.getByName(this.#name(this.input.path)) as ItxProcessorHost;
}
```

Why this name:

- `itx` says it is not a generic durable object context.
- `processor` says these are the four ITX processor verbs.
- `host` says the value is the domain durable object that owns the processor,
  not the processor instance itself.

Names to avoid:

- `context()`: too vague.
- `host()`: overloaded with stream processor host code.
- `processor()`: false; the RPC target is a DO stub, not the processor object.
- `itx()`: collides with the proposed public `.itx` getter.

## Desired Call Sites

### Domain Handles

Before:

```ts
const agentItx = itx.agents.get("/agents/alice");
await agentItx.agent.whoami();
```

After:

```ts
const agent = itx.agents.get("/agents/alice");
await agent.whoami();
```

### Agent ITX

Before:

```ts
const agentItx = itx.agents.get("/agents/alice");
await agentItx.runScript({ code });
```

After:

```ts
const agent = itx.agents.get("/agents/alice");
await agent.itx.runScript({ code });
```

### Project ITX

The root endpoint still gives project ITX directly:

```ts
await itx.runScript({ code });
```

But the domain handle is explicit:

```ts
await itx.project.whoami?.();
await itx.project.itx.runScript({ code });
```

If `ProjectDurableObject` does not need `whoami()`, do not add it just for
symmetry. The important part is that `.project` is the domain object and
`.project.itx` is the project ITX surface.

## Implementation Plan

### 1. Rename the ITX host protocol

File: `apps/minimal-itx-v2/src/itx/rpc-targets.ts`

Change:

```ts
type ItxContext = { ... };
protected context(): ItxContext;
```

To:

```ts
type ItxProcessorHost = { ... };
protected itxProcessorHost(): ItxProcessorHost;
```

Update call sites:

```ts
await this.itxProcessorHost().provideCapability(input);
return this.itxProcessorHost().revokeCapability(input);
return this.itxProcessorHost().runScript(input);
return this.itxProcessorHost().invokeCapability(...);
```

Keep the cast at the Cloudflare stub boundary for now, but avoid `as unknown as`
if TypeScript accepts a direct `as ItxProcessorHost`.

### 2. Add `.itx` to project and agent domain durable objects

Files:

- `apps/minimal-itx-v2/src/domains/projects/project-durable-object.ts`
- `apps/minimal-itx-v2/src/domains/agents/agent-durable-object.ts`

Add public getters:

```ts
get itx() {
  return new ProjectItxRpcTarget({ projectId: this.name.projectId });
}
```

```ts
get itx() {
  return new AgentItxRpcTarget({
    path: this.name.path,
    projectId: this.name.projectId,
  });
}
```

This makes the domain object itself the place where callers ask for its ITX
surface.

Open implementation detail:

- Direct `new ProjectItxRpcTarget(...)` is simplest.
- `this.ctx.exports.ItxEntrypoint({ props: this.name }).get()` is more uniform
  with dynamic worker bindings, but adds another WorkerEntrypoint hop and is
  harder to read.

Default: use direct construction unless runtime behavior proves that loopback
entrypoint binding is needed.

### 3. Change agent collection lookup to return the agent domain RPC target

File: `apps/minimal-itx-v2/src/itx/rpc-targets.ts`

Change:

```ts
get(path: string) {
  return new AgentItxRpcTarget({ path, projectId: this.input.projectId });
}
```

To:

```ts
get(path: string) {
  return env.AGENT.getByName(
    formatDurableObjectName({ path, projectId: this.input.projectId }),
  ).getRpcTarget();
}
```

Then simplify `create()`:

```ts
create({ path, ...input }: { path: string; [key: string]: unknown }) {
  return this.get(path).create(input);
}
```

This makes `agents`, `repos`, and `streams` all follow the same collection rule:
`.get(path)` returns the domain object's RPC target.

### 4. Keep `AgentItxRpcTarget`, but stop returning it from collections

`AgentItxRpcTarget` is still needed for:

- `AgentDurableObject.itx`
- `ItxEntrypoint.get()` when props path points at an agent
- dynamic worker `env.ITX.get()` inside agent-hosted code

But normal project capability tree traversal should not accidentally enter
agent ITX. It should enter agent domain RPC first, then `.itx` explicitly.

### 5. Decide whether `AgentItxRpcTarget extends ProjectItxRpcTarget` survives

This change makes the inheritance smell more obvious.

Current:

```ts
export class AgentItxRpcTarget extends ProjectItxRpcTarget {
  declare readonly input: AgentItxTargetInput;
  ...
}
```

Recommended follow-up:

```ts
abstract class ItxRpcTarget extends RpcTarget {
  constructor(readonly input: { projectId: string }) {
    super();
  }

  protected abstract itxProcessorHost(): ItxProcessorHost;

  // provideCapability, revokeCapability, runScript, fallbackCall live here.
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
  protected itxProcessorHost() { ... }
}
```

```ts
export class AgentItxRpcTarget extends ItxRpcTarget {
  constructor(readonly input: { projectId: string; path: string }) {
    super(input);
  }

  get project() { ... }
  get agent() { ... }
  get streams() { ... }
  get agents() { ... }
  get repos() { ... }
  get repo() { ... }
  protected itxProcessorHost() { ... }
}
```

Default: do this in the same cleanup if it stays small. It removes
`declare readonly input` and makes the hierarchy honest.

### 6. Update tests to lock the semantics

File: `apps/minimal-itx-v2/itx.e2e.test.ts`

Add or update tests for:

1. `itx.agents.get(path).whoami()` calls the agent domain durable object.
2. `itx.agents.get(path).itx` can use agent-hosted ITX verbs.
3. `itx.agents.create({ path, ... })` still appends create-requested and waits
   for created.
4. `env.ITX.get()` in a dynamic worker hosted by an agent still resolves to
   agent ITX, not project ITX.
5. Project built-ins still win over provided capabilities.

Remove tests or test helper assumptions where `agents.get()` means agent ITX.

### 7. Update README examples

File: `apps/minimal-itx-v2/README.md`

Document the distinction explicitly:

```ts
const agent = itx.agents.get("/agents/alice");
await agent.whoami();
await agent.itx.runScript({ code });
```

This is the core concept the prototype should teach.

### 8. Verify

Run:

```bash
pnpm --dir apps/minimal-itx-v2 types:wrangler:check
pnpm --dir apps/minimal-itx-v2 typecheck
pnpm --dir apps/minimal-itx-v2 verify:miniflare
```

Then, if this prototype is still being proven against deployed Workers:

```bash
CLOUDFLARE_ACCOUNT_ID=376ef7ed81b0573f93524de763666c15 \
  pnpm --dir apps/minimal-itx-v2 exec wrangler deploy --name minimal-itx-v2-proof

ITX_BASE=https://minimal-itx-v2-proof.iterate-dev-preview.workers.dev \
  pnpm --dir apps/minimal-itx-v2 verify:deployed
```

## Non-Goals

- Do not add explicit `BUILTIN_ROOTS`; keep method/getter collision checking
  unless that decision changes.
- Do not reintroduce explicit include arrays for generated domain RPC targets
  unless the one-liner wrapper decision changes.
- Do not make project ITX know special rules about agent ITX beyond exposing
  normal domain collections.
- Do not duplicate agent ITX behavior in `AgentsRpcTarget`; the agent durable
  object owns `.itx`.

## Open Questions

1. Should `.itx` be a getter or method?

   Recommendation: getter. It reads like a sub-capability, same as `.project`,
   `.repo`, `.agents`, and `.streams`.

2. Should `.itx` return a directly constructed target or use
   `ctx.exports.ItxEntrypoint({ props }).get()`?

   Recommendation: direct construction first. It is shorter and makes the
   reference implementation easier to read. Switch to the entrypoint only if we
   need identical behavior to dynamic-worker bindings.

3. Should `AgentItxRpcTarget` inherit project built-ins?

   Recommendation: yes for now, but via a shared base or explicit duplicate
   getters, not via `extends ProjectItxRpcTarget` plus `declare readonly input`.

4. Should the domain `.itx` getter be remotely callable through
   `makeRpcTargetClass(DomainDurableObject)`?

   Recommendation: yes. That is the point of this cleanup: domain handles expose
   their ITX surface explicitly.
