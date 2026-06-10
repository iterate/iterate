# RpcTarget Constructor Shape Research

Last updated: 2026-06-08

## Question

For OS capability objects such as `ProjectCapability`, `StreamCapability`,
`RepoCapability`, and `WorkspaceCapability`, what should the server-side target
hold?

Options:

1. a prebuilt `DurableObjectStub`;
2. `env` plus address/props, deriving the `DurableObjectStub` lazily;
3. a `WorkerEntrypoint`-like `{ env, ctx.props }` shape;
4. a standard OS capability runtime object, e.g. `{ env, props, scopes }`.

## Primary-source grounding

Cloudflare Workers RPC is explicitly object-capability RPC. The security model
is that callers can only invoke objects/functions for which they have received
stubs, not arbitrary objects on the other side:
https://developers.cloudflare.com/workers/runtime-apis/rpc/visibility/

Workers RPC is designed to feel like ordinary JavaScript calls. Durable Objects
can expose public methods directly, and `RpcTarget` instances are passed by
reference as stubs:
https://developers.cloudflare.com/workers/runtime-apis/rpc/

Kenton Varda's Workers RPC launch post emphasizes the same goals: no schemas, no
routers, object passing, promise pipelining, and object-capability security:
https://blog.cloudflare.com/javascript-native-rpc/

`ctx.props` is authentic deployer-controlled configuration for a
`WorkerEntrypoint`. Cloudflare docs explicitly describe using props to make an
RPC interface represent a specific resource, and `ctx.exports.Foo({ props })` is
called out as useful when passing a customized binding to another Worker or
dynamic Worker:
https://developers.cloudflare.com/workers/runtime-apis/context/

Durable Object stub creation is lazy. `env.MY_DO.getByName("foo")` does not send
a request or instantiate the DO; the request happens only when a method is
invoked on the stub:
https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/

Durable Object stubs implement E-order semantics. Multiple calls on the same
stub are delivered in order, but if a stub throws, future calls on it fail and
the caller must recreate the stub:
https://developers.cloudflare.com/durable-objects/api/stub/

Workers RPC stubs have explicit lifecycle rules. Returned objects that contain
stubs should generally be disposed with `using`; stubs passed as parameters have
ownership/duplication semantics that matter when storing or forwarding them:
https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/

Kenton's `workerd` PRs add useful color:

- `cloudflare/workerd#1692`
  (https://github.com/cloudflare/workerd/pull/1692): `RpcTarget` was introduced
  for objects that are not top-level entrypoints but can still be passed by
  reference.
- `cloudflare/workerd#1729`
  (https://github.com/cloudflare/workerd/pull/1729): promise pipelining and
  property access are built around custom thenables.
- `cloudflare/workerd#3212`
  (https://github.com/cloudflare/workerd/pull/3212): Proxy-wrapped `RpcTarget`s
  are an intentional opt-in to pass-by-stub behavior and
  public-interface-as-security-boundary.
- `cloudflare/workerd#4719`
  (https://github.com/cloudflare/workerd/pull/4719): pure-JS Cap'n Web stubs can
  interoperate by making `RpcStub` extend `RpcTarget`, with Proxy support
  important.
- `cloudflare/workerd#5733`
  (https://github.com/cloudflare/workerd/pull/5733): Workers RPC is moving
  toward Cap'n Web's stub duplication semantics for params.

Cap'n Web issue `cloudflare/capnweb#36`
(https://github.com/cloudflare/capnweb/issues/36) is especially relevant.
Kenton says the long-term hibernation approach is to terminate Cap'n Web in a
Worker, then use Workers RPC to the DO. He also notes that holding a DO stub does
not itself prevent hibernation; holding stubs pointing at functions or
`RpcTarget` objects inside a DO isolate can.

## Option A: constructor receives a DO stub

```ts
class ProjectCapability extends RpcTarget {
  constructor(private readonly project: DurableObjectStub<ProjectDurableObject>) {
    super();
  }

  fetch(request: Request) {
    return this.project.ingressFetch(request);
  }

  get repos() {
    return new ProjectReposCapability({ projectId: this.project.name! });
  }
}
```

Pros:

- Very object-capability-shaped: the stub is the authority.
- No address recomputation inside the capability.
- Good for small, ephemeral handles returned within one active RPC session.
- The wrapper can forward directly to the exact object reference selected by the
  parent.

Cons:

- Captures a live stub inside another live `RpcTarget`, so lifecycle/dup/dispose
  rules matter.
- If the `RpcTarget` is owned by a DO isolate, long-lived references can work
  against hibernation goals.
- Harder to turn into a custom binding for another Worker or dynamic Worker:
  the constructor argument is not persistently serializable configuration.
- Less aligned with Cloudflare's documented `ctx.props` resource-binding model.
- If the stub fails, the capability has to recreate it or become permanently
  failed.

Best use:

- Tiny session-local facets where the target is clearly ephemeral, not intended
  to be passed into dynamic workers or held across sessions.
- Facades over non-DO live objects, e.g. a parent-owned connection callback.

## Option B: constructor receives env plus props/address

```ts
class ProjectCapability extends RpcTarget {
  constructor(
    private readonly input: {
      env: { PROJECT: DurableObjectNamespace<ProjectDurableObject> };
      props: { projectId: string; scopes?: CapabilityScopes };
    },
  ) {
    super();
  }

  private project() {
    return this.input.env.PROJECT.getByName(`project:${this.input.props.projectId}`);
  }

  fetch(request: Request) {
    return this.project().ingressFetch(request);
  }
}
```

Pros:

- Recreates the DO stub on demand. That is cheap: `getByName()` does not create
  or call the DO.
- Avoids storing a failed stub forever.
- `props` are explicit, inspectable, and compose with narrowing.
- Closer to future `getCapability(props)` / attenuation machinery.

Cons:

- Passing broad `env` into arbitrary `RpcTarget`s is ambient authority. The class
  must be trusted and careful.
- A plain `RpcTarget` with `{ env, props }` is still not itself a platform custom
  binding unless we wrap it or instantiate it from a `WorkerEntrypoint`.
- If constructed inside a DO and returned over RPC, the `RpcTarget` still lives
  in that DO isolate.

Best use:

- Parent-owned local wrappers when using `WorkerEntrypoint` is awkward, provided
  they are short-lived.

## Option C: use WorkerEntrypoint-style capabilities

```ts
export type ProjectCapabilityProps = {
  projectId: string;
  scopes?: CapabilityScopes;
};

export class ProjectCapability extends WorkerEntrypoint<
  { PROJECT: DurableObjectNamespace<ProjectDurableObject> },
  ProjectCapabilityProps
> {
  private project() {
    return this.env.PROJECT.getByName(`project:${this.ctx.props.projectId}`);
  }

  fetch(request: Request) {
    return this.project().ingressFetch(request);
  }

  streams() {
    return this.ctx.exports.StreamsCapability({
      props: {
        namespace: this.ctx.props.projectId,
        scopes: this.ctx.props.scopes,
      },
    });
  }
}
```

Pros:

- Matches Cloudflare's built-in custom binding model.
- `ctx.props` is authentic and designed to represent a specific resource plus
  permissions.
- `ctx.exports.X({ props })` can create narrowed loopback bindings that are
  suitable to pass into another Worker or dynamic Worker.
- Deriving a DO stub inside the entrypoint is lazy and does not add a round trip
  until a method is invoked.
- Makes future narrowing natural: a child capability is just the same exported
  entrypoint with narrower props.
- Existing OS code already uses this for `ProjectCapability`,
  `StreamsCapability`, `ReposCapability`, `WorkspaceCapability`, and several
  integration capabilities.

Cons:

- It introduces a Worker hop before the DO call when the caller could otherwise
  call the DO-owned target directly. For normal Worker-to-DO calls this is
  usually acceptable; for hot inner loops, measure.
- `WorkerEntrypoint` instances are stateless per invocation, so cached child
  getters on the instance do not represent durable state.
- Getters returning child stubs may be awkward because property access is itself
  asynchronous over RPC; methods like `streams()` are mechanically simpler today
  even if the design sketch prefers property syntax.

Best use:

- Root and collection capabilities.
- Singular domain capabilities that may be passed as bindings to dynamic workers.
- Capabilities that should be reconstructable from stable authority data.

## Option D: standard OS capability runtime object

```ts
type CapabilityRuntime<Props> = {
  env: Env;
  props: Props;
  scopes: CapabilityScopes;
  exports: Pick<Cloudflare.Exports, "ProjectCapability" | "StreamsCapability">;
};
```

Pros:

- Gives OS one place for scope normalization, audit hooks, trace metadata, and
  mount/narrowing rules.
- Could make non-WorkerEntrypoint `RpcTarget`s look consistent.

Cons:

- Easy to invent too much framework before the domain model is stable.
- If it wraps all of `env`, it can hide broad authority in a friendly-looking
  object.
- It does not replace the platform's existing `ctx.props`/`ctx.exports` model.

Best use:

- Later, as an internal helper for shared scope checks. Not as the public
  constructor shape now.

## Domain implications

### ProjectCapability

Use a `WorkerEntrypoint`-style exported capability with `props: { projectId,
scopes? }`. It should derive `env.PROJECT.getByName(...)` internally on each
method. This is the best fit for binding a narrowed Project to dynamic workers
and for future `getCapability(props)` attenuation.

Avoid returning a DO-owned `RpcTarget` from `ProjectDurableObject.getCapability`
as the primary shape. It may be useful for short Cap'n Web sessions, but it is
less aligned with hibernation and custom binding goals.

### StreamCapability / StreamsCapability

For the current global hierarchy, split singular and plural:

```ts
ctx.streams.get({ namespace, path }) -> StreamCapability
ctx.projects.get("p").streams.get("/") -> StreamCapability
```

The bindable exported form should carry `props: { namespace, path?, scopes? }`.
The singular `StreamCapability` can be the same entrypoint narrowed to one path,
or a returned `RpcTarget` if it is only session-local. Prefer entrypoint props
when the handle might be passed to project code.

### RepoCapability / ReposCapability

Use `props: { namespace, slug?, scopes? }`. The plural collection can support
`get`, `create`, and `list({ namespace })`; the singular handle is just the same
authority narrowed to `{ namespace, slug }`.

The current `RepoHandle extends RpcTarget` wrapping a DO stub is fine as a small
ephemeral handle, but the cleaner long-term shape for codemode/dynamic-worker
bindings is a props-derived entrypoint.

### WorkspaceCapability / WorkspacesCapability

Use `props: { namespace, slug?, scopes? }`. `workspace.git` can remain a small
child `RpcTarget` facade because it is a facet of the already-held Workspace
authority. If `git` is passed independently to another Worker, make it a
props-derived exported capability too.

## Round-trip analysis

Deriving a DO stub inside the capability does not add a DO request. Cloudflare's
DO lifecycle docs explicitly say creating a stub does not instantiate or call
the DO; invocation does.

The real performance difference is topology:

```text
DO-owned RpcTarget handle:
caller -> ProjectCapability target in Project DO isolate -> project state/method

WorkerEntrypoint capability:
caller -> OS Worker ProjectCapability entrypoint -> Project DO method
```

The DO-owned target can be one hop shorter, but it ties the handle to the DO
isolate. The WorkerEntrypoint shape is more rebindable, more custom-binding-like,
and better aligned with dynamic-worker use. For OS's current design goals, that
trade-off is worth it unless profiling proves a hot-path problem.

## Recommendation

For OS's capability system, use this rule:

```text
Bindable or durable capability = exported WorkerEntrypoint + props.
Ephemeral local facet = RpcTarget may capture a stub or delegate.
Durable Object = state/command owner, not the primary capability wrapper.
```

Concretely:

- `ProjectCapability`, `StreamsCapability`, `ReposCapability`, and
  `WorkspacesCapability` should be exported `WorkerEntrypoint`s whose authority
  is represented by `ctx.props`.
- Singular handles can initially be returned `RpcTarget`s if that keeps the
  sketch simple, but the canonical pass-to-worker shape should be reproducible
  from `{ entrypoint, props }`.
- Capability props should include the narrowed address and scope data:

  ```ts
  type ProjectCapabilityProps = { projectId: string; scopes?: CapabilityScopes };
  type StreamsCapabilityProps = {
    namespace: string;
    path?: string;
    scopes?: CapabilityScopes;
  };
  type ReposCapabilityProps = {
    namespace: string;
    slug?: string;
    scopes?: CapabilityScopes;
  };
  type WorkspacesCapabilityProps = {
    namespace: string;
    slug?: string;
    scopes?: CapabilityScopes;
  };
  ```

- Parent capabilities should create child capabilities by passing narrower props
  through `ctx.exports.ChildCapability({ props })`.
- DO stubs should be derived inside methods from `env + props`. This does not add
  a network round trip and makes stubs easy to recreate after failures.
- Avoid a broad custom runtime object until scope/mount mechanics are clearer.

The key design distinction: **do not model a capability as "a wrapper around a
stub" by default. Model it as a small, bindable authority description that knows
how to derive the right stub when invoked.**
