---
state: todo
priority: high
size: large
dependsOn: [minimal-itx-v4-workers-domain-refactor]
tags: [minimal-itx-v4, workers, itx, capnweb, cloudflare, durable-objects, object-capabilities]
---

# Minimal ITX v4 workers domain capability review

This task records the review of the first `apps/minimal-itx-v4` workers-domain
implementation against:

- Cap'n Web docs and source.
- Cloudflare Workers RPC, Dynamic Workers, Worker Loader, `ctx.props`,
  `ctx.exports`, Durable Object facets, and RPC lifecycle docs.
- Kenton Varda's Cap'n Proto / Cap'n Web / Workers RPC writings and public
  design notes, including the Durable Object facets work.

The implementation works and the test coverage is already useful. The issue is
not that the current version is broken; the issue is that the shape still feels
more like a string-routed plugin host than a clean object-capability tree. That
will become expensive if this becomes the foundation for many domains and
user-supplied dynamic workers.

## Scope

Review and simplify the workers-domain design in:

- `apps/minimal-itx-v4/src/domains/workers/`
- `apps/minimal-itx-v4/src/domains/itx/`
- Project and agent RPC targets that expose workers and provided capabilities.
- Tests proving project worker, run script, provided worker capabilities, live
  capabilities, and cross-capability calls through `env.ITX`.

This is not asking for backwards compatibility. Prefer the cleanest model.

## Current implementation summary

Current public surface:

```ts
const worker = project.workers.get(ref);
await worker.someRpcMethod();

await project.worker.fetch(request);

await project.provideCapability({
  path: ["db"],
  capability: { type: "worker", workerRef },
});

await project.db.sql("select 1");
```

Current worker ref model:

```ts
export type WorkerSource =
  | {
      type: "inline";
      mainModule: string;
      modules: Record<string, string>;
    }
  | {
      type: "repo";
      repoPath: string;
      sourcePath: string;
    };

type WorkerRefBase = {
  path: string;
  source: WorkerSource;
};

export type StatelessWorkerRef = WorkerRefBase & {
  type: "stateless";
  entrypoint?: string;
  props?: Record<string, JsonValue>;
};

export type StatefulWorkerRef = WorkerRefBase & {
  type: "stateful";
  className: string;
  durableWorkerKey: string;
};
```

Current execution model:

- Stateless refs load a dynamic Worker and return `worker.getEntrypoint(...)`.
- Stateful refs use `StatefulWorkerDurableObject`, which loads a dynamic
  Durable Object class and hosts it as a facet named `target`.
- Provided worker capabilities are stored in the ITX capability table as
  durable `WorkerRef` records.
- Live capabilities duplicate retained RPC stubs with `dup()` and dispose them
  on revoke/replacement.
- Unknown properties on ITX/project/worker RPC targets become dynamic path
  segments through a function-backed proxy, eventually calling
  `invokeCapability({ path, args })`.

## Sources

Primary source links used for this review:

- Cap'n Web repository and README:
  <https://github.com/cloudflare/capnweb>
- Cap'n Web announcement:
  <https://blog.cloudflare.com/capnweb-javascript-rpc-library/>
- Workers native RPC announcement:
  <https://blog.cloudflare.com/javascript-native-rpc/>
- Cap'n Proto RPC protocol notes:
  <https://capnproto.org/rpc.html>
- Workers RPC docs:
  <https://developers.cloudflare.com/workers/runtime-apis/rpc/>
- Workers RPC visibility and object-capability security model:
  <https://developers.cloudflare.com/workers/runtime-apis/rpc/visibility/>
- Workers RPC lifecycle and `dup()` / disposal:
  <https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/>
- Workers RPC reserved methods:
  <https://developers.cloudflare.com/workers/runtime-apis/rpc/reserved-methods/>
- Workers `ctx.props` and `ctx.exports`:
  <https://developers.cloudflare.com/workers/runtime-apis/context/>
- Dynamic Workers getting started:
  <https://developers.cloudflare.com/dynamic-workers/getting-started/>
- Dynamic Workers egress control:
  <https://developers.cloudflare.com/dynamic-workers/usage/egress-control/>
- Dynamic Workers Durable Object facets:
  <https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/>
- Kenton Varda workerd Durable Object facets PR:
  <https://github.com/cloudflare/workerd/pull/4123>

Relevant docs takeaways:

- Cap'n Web and Workers RPC are object-capability systems: authority is conveyed
  by receiving a stub/reference, not by constructing a path string.
- Cap'n Web supports passing functions and objects by reference, bidirectional
  calling, and promise pipelining.
- Cap'n Proto argues that promise pipelining is essential for object-oriented
  distributed APIs.
- Workers RPC exposes class prototype methods/getters; TypeScript `private`
  does not hide RPC methods. JavaScript `#private` does.
- Workers RPC lifecycle requires explicit disposal for retained stubs. Received
  parameter stubs are automatically disposed when the call returns unless the
  receiver calls `dup()`.
- `ctx.props` is designed as authentic host-supplied configuration for service
  bindings and loopback exports.
- `ctx.exports` currently requires the `enable_ctx_exports` compatibility flag
  according to Cloudflare docs.
- Dynamic Workers docs recommend `globalOutbound: null` for untrusted or
  AI-generated code, then providing explicit bindings.
- Worker Loader `get(id, callback)` treats `id` as the warm-worker identity; the
  ID should uniquely identify the code/config intended to be reused.
- Durable Object facets are intended as dynamic child Durable Objects supervised
  by a normal Durable Object. Each facet name gets separate SQLite-backed
  storage. `abort()` preserves storage; `delete()` removes facet storage.

## High-level verdict

The domain split itself is good:

- `workers` is a better domain name than `dynamic-workers`.
- Splitting stateless and stateful refs is the right direction.
- Keeping repo source separate from runtime identity is directionally right.
- Sync KV in SQLite-backed Durable Objects is now confirmed and should stay.
- Tests now prove the important happy paths.

The parts that still smell:

- Dynamic dotted access is implemented through string path replay rather than
  real object references.
- `invokeCapability` is public RPC surface even though it is intended as
  internal transport glue.
- `WorkerRef` is a forgeable recipe, not a capability.
- `WorkerCollection.get<T>()` lets the caller invent the type.
- Dynamic workers receive broad `env.ITX.get()` authority.
- Stateful validation mutates runtime/storage before the capability event has
  committed.
- The stateful worker/facet relationship is probably one layer too awkward.
- Several type shapes imply behavior that is not true, especially stateful
  `props`.

## Findings

### 1. Dynamic dotted path proxy is the grossest abstraction

Implementation:

- [`path-proxy.ts`](../apps/minimal-itx-v4/src/domains/itx/path-proxy.ts)
- [`live-capability.ts`](../apps/minimal-itx-v4/src/domains/itx/live-capability.ts)
- [`workers/rpc-targets.ts`](../apps/minimal-itx-v4/src/domains/workers/rpc-targets.ts)
- [`itx-processor-implementation.ts`](../apps/minimal-itx-v4/src/domains/itx/itx-processor-implementation.ts)

Current shape:

```ts
return new Proxy(function () {}, {
  apply(_target, _thisArg, args) {
    return target.invokeCapability({ args: [...args], path });
  },
  get(target, key, receiver) {
    if (typeof key === "symbol") return Reflect.get(target, key, receiver);
    if (isReserved(key)) return undefined;
    return valueFor(key);
  },
});
```

And then:

```ts
export async function replayPath({ args, path, target }) {
  let receiver = await target;
  for (let i = 0; i < path.length - 1; i++) {
    receiver = await Reflect.get(receiver, path[i]);
  }
  const callable = Reflect.get(receiver, path.at(-1)!);
  return await Reflect.apply(callable, receiver, args);
}
```

Why this smells:

- Cap'n Web and Workers RPC already model object references and method calls.
- Cap'n Web supports promise pipelining by letting calls proceed on unresolved
  RPC promises. Our `replayPath()` awaits each intermediate segment.
- The path proxy recreates the "string path plus dispatcher" model that
  object-capability RPC is meant to avoid.
- This shape loses type information and pushes dynamic errors to runtime.
- It forces local reserved-name lists (`then`, `catch`, `map`, `dup`,
  `onRpcBroken`, object prototype names, etc.) that can drift from the actual
  RPC implementation.
- Tests require many `@ts-expect-error` comments for the desired surface,
  proving the TypeScript story is not actually coherent.

Why it seemed attractive:

- It makes `project.slack.chat.postMessage(...)` possible without codegen.
- It lets a mounted capability route arbitrary nested method paths to a worker.
- It avoids requiring every provided capability to be known at compile time.

Recommended direction:

- Do not make path replay the core object model.
- Prefer returning actual `RpcTarget` / Workers RPC stubs where possible.
- For known typed capabilities, expose real members or generated/adapted RPC
  targets.
- Keep a consciously unsafe explicit escape hatch for dynamic paths, for
  example:

```ts
await project.invokeCapability({
  path: ["slack", "chat", "postMessage"],
  args: ["hello"],
});
```

- If dotted dynamic syntax remains, isolate it as a client-side convenience
  adapter, not as the model stored in the system.

Acceptance criteria for cleanup:

- Stateless workers are not wrapped in a path proxy when a native stub can be
  returned directly.
- `replayPath()` is only used for the narrow cases where native stub forwarding
  is known not to work.
- Dynamic path calls are documented as dynamic/unsafe and are not confused with
  typed RPC surfaces.

### 2. `invokeCapability` is public RPC surface

Implementation:

- [`projects/rpc-targets.ts`](../apps/minimal-itx-v4/src/domains/projects/rpc-targets.ts)
- [`agents/rpc-targets.ts`](../apps/minimal-itx-v4/src/domains/agents/rpc-targets.ts)
- [`workers/rpc-targets.ts`](../apps/minimal-itx-v4/src/domains/workers/rpc-targets.ts)

Current smell:

```ts
async invokeCapability({ args = [], path }: { args?: unknown[]; path: string[] }) {
  // intended as proxy plumbing
}
```

Because this is a prototype method on an RPC target, remote callers can see it.
Cloudflare's Workers RPC visibility rules expose prototype methods/getters and
only hide JavaScript `#private` internals. TypeScript visibility is erased.

Why this matters:

- The user-facing capability tree should be the surface.
- `invokeCapability` is an internal dispatcher.
- Making it public widens the API and forces the rest of the implementation to
  defend it as if it were a supported endpoint.
- It also undermines the idea that a capability is a specific object/stub with
  a narrow interface.

Recommended direction:

- Change the dispatcher to `#invokeCapability`.
- Pass a closure into `withInvokeCapabilityFallback()` instead of requiring a
  public method on the target.
- Or remove the proxy and keep `invokeCapability()` as an explicit, documented
  unsafe API. Do not do both.

Acceptance criteria:

- No unintended public `invokeCapability` method appears on project, agent, or
  worker targets.
- If an explicit raw path API remains, it is deliberately named and documented
  as raw/dynamic.

### 3. `WorkerRef` is a recipe, not an object capability

Implementation:

- [`workers/types.ts`](../apps/minimal-itx-v4/src/domains/workers/types.ts)
- [`workers/schemas.ts`](../apps/minimal-itx-v4/src/domains/workers/schemas.ts)
- [`itx/types.ts`](../apps/minimal-itx-v4/src/domains/itx/types.ts)
- [`itx-processor-implementation.ts`](../apps/minimal-itx-v4/src/domains/itx/itx-processor-implementation.ts)

Current model:

```ts
export interface WorkerCollection {
  get<T = unknown>(ref: WorkerRef): T;
}
```

The caller can provide:

- Inline source modules.
- Repo source address.
- ITX path.
- Entrypoint name or Durable Object class name.
- `props`.
- `durableWorkerKey`.

Why this smells:

- A capability should be difficult or impossible to forge. It designates an
  object and confers permission to call it.
- `WorkerRef` is a serializable locator/recipe. Anyone with project access can
  construct one.
- That may be acceptable as a privileged project API, but it should not be
  described as if the ref itself were the capability.
- Persisting `WorkerRef` inside `capability-provided` means future behavior can
  change when repo source changes. That is a deliberate choice, but it means the
  mounted capability is more like "whatever this recipe resolves to later" than
  "this object reference".

Recommended direction:

- Rename or document `WorkerRef` as a worker recipe/source recipe if it remains
  caller-constructible.
- Introduce an opaque `WorkerHandle` or `CapabilityHandle` later if we need true
  persistent capabilities.
- For provided capabilities, decide whether the stored record should contain:
  - the recipe, meaning source changes affect next use; or
  - an immutable build/source digest, meaning the capability is pinned; or
  - a handle that resolves through a registry/stream record.

Possible cleaner shape:

```ts
type WorkerRecipe = StatelessWorkerRecipe | StatefulWorkerRecipe;

type ProvidedCapabilityRecord =
  | { type: "live"; path: string[] }
  | {
      type: "worker";
      path: string[];
      recipe: WorkerRecipe;
      sourcePolicy: "latest";
    };
```

Future shape if we want stronger capabilities:

```ts
type WorkerHandle = {
  type: "worker-handle";
  id: string;
  projectId: string;
  issuedForPath: string;
  rights: string[];
};
```

Acceptance criteria:

- Names and docs stop implying that a forgeable `WorkerRef` is itself an
  object-capability reference.
- Direct `project.workers.get(...)` is documented as privileged recipe
  execution, or it is replaced by a minted handle API.

### 4. `WorkerCollection.get<T>()` is a type lie

Implementation:

- [`workers/types.ts`](../apps/minimal-itx-v4/src/domains/workers/types.ts)
- [`workers/rpc-targets.ts`](../apps/minimal-itx-v4/src/domains/workers/rpc-targets.ts)

Current model:

```ts
get<T = unknown>(ref: WorkerRef): T;
```

Why this smells:

- The caller chooses `T`.
- Runtime validation does not prove the dynamic worker exports `T`.
- There is no build artifact, manifest, schema, or generated client connecting
  source to type.
- Tests use `@ts-expect-error` for dynamic roots and rely on casts.
- Cap'n Web explicitly warns that TypeScript does not provide runtime input
  validation for RPC. A malicious or simply wrong caller can send unexpected
  shapes.

Recommended direction:

- Simplest immediate cleanup: return `unknown` or a deliberately raw
  `WorkerRpcTarget` instead of generic `T`.
- Better later: make typed dynamic workers come from a typed build result or a
  generated handle.
- If we keep caller-provided `T`, force the unsafe cast to be visible at the
  callsite:

```ts
const worker = project.workers.get(ref) as unknown as MyWorkerApi;
```

This is uglier at the callsite but more honest.

Acceptance criteria:

- No public API lets the caller silently invent the type of a dynamic worker
  without an explicit unsafe cast or a real typed artifact.

### 5. Dynamic workers get broad `env.ITX.get()` authority

Implementation:

- [`itx-entrypoint.ts`](../apps/minimal-itx-v4/src/domains/itx/itx-entrypoint.ts)
- [`entrypoint-props.ts`](../apps/minimal-itx-v4/src/domains/itx/entrypoint-props.ts)
- [`workers/rpc-targets.ts`](../apps/minimal-itx-v4/src/domains/workers/rpc-targets.ts)
- [`stateful-worker-durable-object.ts`](../apps/minimal-itx-v4/src/domains/workers/stateful-worker-durable-object.ts)

Original reviewed model:

```ts
export class ItxEntrypoint
  extends WorkerEntrypoint<Env, ItxEntrypointProps>
  implements Pick<UnauthenticatedItx, "authenticate">
{
  authenticate(input: ItxAuthCredentials) {
    return new UnauthenticatedItxRpcTarget(new Headers(), this.ctx).authenticate(input);
  }

  async get(): Promise<ScopedItx> {
    const { path, projectId } = scopeFromItxEntrypointProps(this.ctx.props);
    const root = this.authenticate(TRUSTED_INTERNAL_ITX_PROPS);
    const project = await root.projects.get(projectId);
    if (path === "/") return project;
    if (path.startsWith("/agents/")) return await project.agents.get(path);
    throw new Error(...);
  }
}
```

Status note: `authenticate(...)` has since been removed from
`ItxEntrypoint`. Public `/api/itx` authentication still lives on
`UnauthenticatedItxRpcTarget`; the exported `ItxEntrypoint` used as the dynamic
worker `env.ITX` binding now only needs to expose scoped `get()`.

Why this smells:

- In the original reviewed version, dynamic worker code received a binding that
  could call both `get()` and `authenticate(...)`.
- The intended host-supplied authority was scoped `get()`, not public
  authentication.
- Cloudflare's `ctx.props` docs emphasize authentic host-supplied props that
  configure a binding for a resource. That pattern fits a scoped ITX binding
  with only `get()`.
- `env.ITX.get()` returns the whole project or agent surface. That may be the
  desired root capability, but it is broad and should be an explicit design
  decision.

Recommended direction:

- Keep the unauthenticated public ITX surface separate from the scoped
  dynamic-worker entrypoint. The immediate `authenticate(...)` removal achieves
  the most confusing part of this.
- Give dynamic workers:

```ts
export class ScopedItxEntrypoint extends WorkerEntrypoint<Env, ItxEntrypointProps> {
  async get(): Promise<ScopedItx> {
    // host-scoped only
  }
}
```

- Keep `authenticate()` only on the public `/api/itx` surface via
  `UnauthenticatedItxRpcTarget`.
- Decide whether dynamic workers should get `env.ITX.get()` as a broad scoped
  root or narrower imported capabilities.

Acceptance criteria:

- Dynamic workers cannot call `env.ITX.authenticate(...)`. This is already true
  after the follow-up cleanup.
- The binding name and docs clearly say whether dynamic code receives a project
  root, an agent root, or a narrower import object.

### 6. Stateful worker validation mutates runtime state before commit

Implementation:

- [`itx-processor-implementation.ts`](../apps/minimal-itx-v4/src/domains/itx/itx-processor-implementation.ts)
- [`stateful-worker-durable-object.ts`](../apps/minimal-itx-v4/src/domains/workers/stateful-worker-durable-object.ts)

Original reviewed flow:

```ts
// provideCapability()
const workerRef = WorkerRefSchema.parse(capability.workerRef);
await this.#workerRunner.validate(workerRef);
// append capability-provided after validation
```

For stateful workers:

```ts
async validate(ref: StatefulWorkerRef): Promise<void> {
  await this.#facet(ref);
}
```

And `#facet(ref)` can:

- Resolve source.
- Load the dynamic worker.
- Extract the DO class.
- Compare/write version marker in sync KV.
- Abort the existing facet if the version changed.
- Create/resume the facet.

Status note: the provide-time validation path has since been removed instead of
split into a pure validation helper. That is intentionally simpler: worker
capabilities now parse and append a durable recipe, and any bad source/missing
export failure happens on first invocation. The important invariant is that
`provideCapability()` does not load Worker Loader or mutate facet state.

Why this smells:

- Validation should not mutate durable state or abort a live facet.
- If validation succeeds but the event append later fails, a facet/version write
  may already have happened for a capability that was not committed.
- If validation is for a replacement using the same `durableWorkerKey`, it can
  abort the existing live worker before the replacement is durable.

Recommended direction:

- Prefer no provide-time worker loading at all.
- `provideCapability()` should:
  - validate the shape of the ref;
  - append the capability record;
  - update the live in-memory map only after the append commits.
- It should not resolve source.
- It should not call Worker Loader.
- It should not call `ctx.facets.get()`.
- It should not write the version marker.
- It should not call `ctx.facets.abort()`.
- Runtime mutation should happen on first actual invocation after the
  `capability-provided` event is committed.

Acceptance criteria:

- `provideCapability()` has no worker-loading or durable facet side effects.
- Stateful source/class changes only abort/restart facets during committed
  runtime use.

### 7. Stateful worker/facet layering is awkward

Implementation:

- [`stateful-worker-durable-object.ts`](../apps/minimal-itx-v4/src/domains/workers/stateful-worker-durable-object.ts)
- [`worker-runner.ts`](../apps/minimal-itx-v4/src/domains/workers/worker-runner.ts)

Current model:

- `StatefulWorkerDurableObject` is the outer DO.
- The dynamic Durable Object class is a facet named `target`.
- The outer DO name encodes stream path plus `durableWorkerKey` query prop.
- `ref` is passed to each call and checked against the DO name.

Why this smells:

- Cloudflare facets are already child DO-like compartments inside a supervisor.
  Our outer DO is basically a one-facet supervisor for each durable worker key.
- The facet name is always `target`, so the real worker key is not the facet
  name; it is in the outer DO name query prop.
- The full `ref` is sent on every call, duplicating identity that is already in
  the DO name.
- `StatefulWorkerDurableObject.get(ref)` originally remained public even though
  returning facet stubs across this boundary previously produced opaque RPC
  failures. That method has since been removed; stateful worker calls now stay
  on `invokeCapability(...)`.

Possible directions:

Option A: Keep the current one-outer-DO-per-durable-worker model, but tighten it.

- Remove public `get(ref)` if it is not safe. This has been done.
- Keep only `invokeCapability(...)` unless a real public dry-run API becomes
  necessary.
- Keep provide-time worker refs lazy instead of adding a separate validation
  path.
- Keep `durableWorkerKey` in DO name query props.

Option B: Make the worker runner DO a true supervisor for many facets under a
stream path.

- Outer DO name path equals the event stream path.
- Facet names are `durableWorkerKey`.
- One supervisor can host many dynamic stateful capabilities for that stream.
- This matches the Cloudflare facet model more directly.

Option C: Host facets in the ITX durable object.

- ITX is already the path-scoped capability host.
- Facets become a native implementation detail of a path-scoped ITX object.
- This may be clean if dynamic stateful capabilities are always ITX-mounted.
- It is less clean for direct `project.workers.get(statefulRef)` unless that is
  treated as a shortcut into ITX.

Recommendation:

- Short term: Option A. It is the smallest cleanup.
- Medium term: strongly consider Option B if many durable workers per stream
  path are expected.

Acceptance criteria:

- Public API no longer encourages moving a dynamic facet stub through an unsafe
  second RPC boundary.
- The relationship between stream path, durable worker key, outer DO name, and
  facet name is documented in one place.

### 8. `props` are stateless-only

Status: done. `props` now lives only on `StatelessWorkerRef`, and the strict
schema rejects `props` on stateful refs.

Implementation:

- [`workers/types.ts`](../apps/minimal-itx-v4/src/domains/workers/types.ts)
- [`workers/schemas.ts`](../apps/minimal-itx-v4/src/domains/workers/schemas.ts)
- [`worker-runner.ts`](../apps/minimal-itx-v4/src/domains/workers/worker-runner.ts)
- [`stateful-worker-durable-object.ts`](../apps/minimal-itx-v4/src/domains/workers/stateful-worker-durable-object.ts)

Current stateless behavior:

```ts
return worker.getEntrypoint(ref.entrypoint, { props: ref.props ?? {} });
```

Current stateful behavior:

```ts
return this.ctx.facets.get(FACET_NAME, () => ({ class: klass }));
```

Why this mattered:

- `props` on `WorkerRefBase` implied both stateless and stateful refs receive
  props, but the implementation never passed them to Durable Object facets.
- Cloudflare WorkerEntrypoint `ctx.props` applies naturally to stateless
  service bindings and loopback exports.
- Durable Object facets expose startup options with `class` and optional `id`;
  they do not mirror WorkerEntrypoint props in the same way.

Implemented direction:

- Move `props` from `WorkerRefBase` to `StatelessWorkerRef`.
- If stateful workers need config later, model it explicitly instead of
  pretending WorkerEntrypoint props apply to facet startup:

```ts
export type StatefulWorkerRef = {
  type: "stateful";
  path: string;
  source: WorkerSource;
  className: string;
  durableWorkerKey: string;
  facetId?: string;
};
```

Acceptance criteria:

- Types do not imply stateful props behavior that is not implemented.

### 9. `ctx.exports` is used without the documented compatibility flag

Implementation:

- [`wrangler.jsonc`](../apps/minimal-itx-v4/wrangler.jsonc)
- [`workers/rpc-targets.ts`](../apps/minimal-itx-v4/src/domains/workers/rpc-targets.ts)
- [`stateful-worker-durable-object.ts`](../apps/minimal-itx-v4/src/domains/workers/stateful-worker-durable-object.ts)
- [`itx-durable-object.ts`](../apps/minimal-itx-v4/src/domains/itx/itx-durable-object.ts)

Current config:

```jsonc
"compatibility_flags": ["nodejs_compat"]
```

Cloudflare docs currently say `ctx.exports` requires
`enable_ctx_exports`. The implementation uses `ctx.exports.ItxEntrypoint(...)`
and `ctx.exports.AppRunner.getByName(...)`-style loopback exports.

Why this matters:

- Deployed tests passed, so the runtime may be permissive, or generated local
  types/config may be masking something.
- The config should match the documented requirement.
- Future agents should not have to reverse-engineer why `ctx.exports` works.

Recommended direction:

- Add `enable_ctx_exports` to compatibility flags.
- Regenerate Worker types if needed.
- If the flag is no longer necessary in this runtime, add a comment with a
  source or remove reliance on `ctx.exports`.

Acceptance criteria:

- Config and docs agree on `ctx.exports` usage.

### 10. Dynamic workers should probably default to blocked egress

Implementation:

- [`worker-loader.ts`](../apps/minimal-itx-v4/src/domains/workers/worker-loader.ts)

Current load options:

```ts
return loader.get(cacheKey, () => ({
  compatibilityDate: WORKER_COMPATIBILITY_DATE,
  compatibilityFlags: ["nodejs_compat"],
  env: bindings,
  mainModule: resolved.mainModule,
  modules: resolved.modules,
}));
```

Cloudflare Dynamic Workers docs recommend:

- For untrusted or AI-generated code, set `globalOutbound: null`.
- Then pass explicit bindings/capabilities.
- If outbound access is needed, route it through a gateway binding.

Why this smells:

- `runScript`, inline worker capabilities, and repo-sourced worker capabilities
  may eventually run user/agent-generated code.
- The current default allows broad outbound `fetch()` / `connect()` behavior.
- `nodejs_compat` is enabled for every dynamic worker, whether it needs it or
  not.

Recommended direction:

- Set `globalOutbound: null` by default.
- Add an explicit opt-in later for egress gateway support.
- Consider making compatibility flags part of the source/build policy, not a
  global default.

Acceptance criteria:

- Dynamic workers cannot access the network unless the host deliberately gives
  them a binding or egress gateway.

### 11. Worker Loader cache key is too weak for source identity

Implementation:

- [`worker-loader.ts`](../apps/minimal-itx-v4/src/domains/workers/worker-loader.ts)

Current hashing:

```ts
export function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
```

Why this smells:

- Worker Loader `get(id, callback)` uses `id` as warm-worker identity.
- A 32-bit ad hoc hash is collision-prone for code identity.
- `JSON.stringify()` is order-sensitive.
- This is not safe if the cache key becomes part of build/source integrity.

Recommended direction:

- Use stable serialization for inline modules.
- Use SHA-256 for inline source.
- Use repo commit/content digests directly when available.
- Keep runtime dimensions in the cache key:
  - project ID;
  - path/scope key;
  - worker type;
  - entrypoint/class;
  - source digest;
  - relevant compatibility flags;
  - relevant binding shape/version.

Acceptance criteria:

- Worker Loader IDs are collision-resistant enough for code identity.
- The cache key clearly separates source identity from host/runtime scope.

### 12. Live capability retention needs broken-stub cleanup

Implementation:

- [`live-capability.ts`](../apps/minimal-itx-v4/src/domains/itx/live-capability.ts)
- [`itx-processor-implementation.ts`](../apps/minimal-itx-v4/src/domains/itx/itx-processor-implementation.ts)

Current behavior:

- Provider trees are deep-copied.
- Stub-like values are duplicated via `dup()`.
- Retained duplicates are disposed on revoke/replacement.

This is directionally correct. Cloudflare RPC lifecycle docs say received stubs
are automatically disposed when a call returns unless duplicated, and duplicates
must be independently disposed.

Remaining problem:

- If a retained live provider's underlying RPC session disconnects, the live map
  can keep a broken retained provider indefinitely.
- Cap'n Web exposes `onRpcBroken()` for detecting this lifecycle event.

Recommended direction:

- Track retained stub duplicates as values, not just `Disposable`s.
- If a duplicate supports `onRpcBroken()`, register cleanup.
- On broken stub:
  - dispose the retained provider;
  - remove or mark the live capability offline;
  - optionally append a durable event if live provider disconnection should be
    visible in the stream.

Acceptance criteria:

- Broken live providers do not stay in the live map forever.

### 13. Reserved path validation is duplicated and inconsistent

Implementation:

- [`path-proxy.ts`](../apps/minimal-itx-v4/src/domains/itx/path-proxy.ts)
- [`itx-processor-implementation.ts`](../apps/minimal-itx-v4/src/domains/itx/itx-processor-implementation.ts)

Current issue:

- `path-proxy.ts` has a broad reserved dynamic path segment set.
- ITX processor validation has its own path rules.
- Direct public `invokeCapability` can bypass some proxy-specific reservations.

Recommended direction:

- If dynamic path dispatch remains, put all reserved segment logic behind one
  exported predicate.
- Use it in:
  - `provideCapability`;
  - `revokeCapability`;
  - direct raw path invocation;
  - path proxy traversal.

Acceptance criteria:

- There is a single source of truth for reserved dynamic capability path
  segments.

## Proposed remediation order

### Phase 1: Make the current model honest and safer

1. Add `enable_ctx_exports` to `wrangler.jsonc`.
2. Set `globalOutbound: null` for dynamic workers by default.
3. Replace `hashString()` with SHA-256/stable source hashing.
4. Move `props` to `StatelessWorkerRef`.
5. Keep scoped ITX dynamic-worker binding separate from unauthenticated ITX:
   - dynamic workers get `env.ITX.get()`;
   - public root keeps `authenticate(...)` through `UnauthenticatedItxRpcTarget`.
6. Keep provided worker capabilities lazy: parse and append recipes, then load
   workers only on invocation. This has been done for the eager validation path.
7. Remove or hide `StatefulWorkerDurableObject.get(ref)` if not truly needed.
   This has been done.

### Phase 2: Reduce path proxy centrality

1. Return native stateless WorkerEntrypoint stubs from `project.workers.get()`
   where possible.
2. Keep stateful invocation inside `StatefulWorkerDurableObject` until the
   cross-DO facet stub issue is understood.
3. Make `invokeCapability` private or rename it to an explicit raw/dynamic
   public API.
4. Collapse duplicated reserved path validation.
5. Revisit all `@ts-expect-error` dynamic capability test callsites and decide
   which ones are acceptable dynamic escape hatches.

### Phase 3: Decide capability identity model

1. Decide whether `WorkerRef` should be renamed to `WorkerRecipe`.
2. Decide whether provided worker capabilities should store:
   - latest recipe;
   - pinned build/source digest;
   - opaque handle;
   - or a combination.
3. Decide whether stateful workers should be:
   - one outer DO per durable worker key; or
   - one supervisor DO per stream path with many facets; or
   - facets hosted directly inside ITX DOs.
4. Decide whether dynamic workers get broad scoped `env.ITX.get()` or an
   explicit import object of attenuated capabilities.

### Phase 4: Better typed dynamic surfaces

1. Add a worker build/typecheck artifact model.
2. If TypeScript worker sources are supported, compile before Worker Loader.
3. Add optional method/schema descriptors for provided capabilities.
4. Generate typed clients or typed worker handles from build artifacts.
5. Keep raw dynamic path calls visibly unsafe.

## Suggested implementation notes

### Scoped ITX binding split

Possible type split:

```ts
export interface ScopedItxBinding {
  get(): Promise<ScopedItx>;
}

export class ScopedItxEntrypoint
  extends WorkerEntrypoint<Env, ItxEntrypointProps>
  implements ScopedItxBinding
{
  async get(): Promise<ScopedItx> {
    const { path, projectId } = scopeFromItxEntrypointProps(this.ctx.props);
    const auth = trustedInternalAuthContext();
    const project = new ProjectCollectionRpcTarget({ auth, ctx: this.ctx }).get(projectId);
    if (path === "/") return project;
    if (path.startsWith("/agents/")) return await project.agents.get(path);
    throw new Error(`Unsupported scoped ITX path "${path}"`);
  }
}
```

Then dynamic worker bindings use:

```ts
ITX: props.ctx.exports.ScopedItxEntrypoint({ props: itxScope });
```

The public API root can keep:

```ts
export class ItxEntrypoint extends WorkerEntrypoint<Env> {
  authenticate(input: ItxAuthCredentials): ItxRoot {
    ...
  }
}
```

### Pure stateful validation

Possible split:

```ts
async validate(ref: StatefulWorkerRef): Promise<void> {
  await this.#loadDurableObjectClass(ref);
}

async invokeCapability(input: InvokeStatefulWorkerInput) {
  return await replayPath({
    args: input.args,
    path: input.path,
    target: await this.#facet(input.ref),
  });
}

async #loadDurableObjectClass(ref: StatefulWorkerRef) {
  this.#assertRefMatchesName(ref);
  const resolved = await resolveWorkerSource(...);
  const worker = loadResolvedWorker(...);
  const klass = worker.getDurableObjectClass?.(ref.className);
  if (!klass) throw new Error(...);
  return { klass, resolved };
}
```

`#facet()` can still do the version marker and abort/restart, but only on
actual invocation.

### Native stateless stubs

Current `project.workers.get(ref)` always returns `WorkerRpcTarget`, which wraps
stateless workers in the path proxy. A cleaner split could be:

```ts
get(ref: StatelessWorkerRef): Promise<unknown>; // native entrypoint stub
get(ref: StatefulWorkerRef): WorkerRpcTarget;   // stateful replay target
```

Or more honestly:

```ts
get(ref: WorkerRef): unknown;
```

Then tests/callers must explicitly cast when using dynamic types.

### Explicit raw dynamic calls

If raw path invocation remains public, prefer naming that makes the escape hatch
obvious:

```ts
await project.callDynamicCapability({
  path: ["slack", "chat", "postMessage"],
  args: [{ text: "hello" }],
});
```

Avoid pretending this is the same as a typed RPC stub.

## Test plan

Keep the existing miniflare and deployed-worker e2e coverage, then add focused
regressions as the cleanup lands.

Required tests:

1. Dynamic workers cannot call `env.ITX.authenticate(...)`.
2. Dynamic workers can still call `env.ITX.get()` at project scope.
3. Dynamic workers can still call `env.ITX.get()` at agent scope.
4. Stateless inline project worker can be called directly.
5. Stateless repo project worker can be called directly.
6. Stateless inline provided project capability works.
7. Stateless repo provided project capability works.
8. Stateless inline provided agent capability works.
9. Stateless repo provided agent capability works.
10. Stateful inline provided project capability works.
11. Stateful repo provided project capability works.
12. Stateful inline provided agent capability works.
13. Stateful repo provided agent capability works.
14. Provided capabilities can call sibling capabilities through scoped
    `env.ITX.get()`.
15. Stateful validation does not create or abort a facet before the capability
    event commits.
16. Revoking a mounted capability makes the mounted path unavailable.
17. If facet deletion is added, deleting state really removes stored counter
    state.
18. Dynamic worker outbound fetch is blocked by default when
    `globalOutbound: null`.
19. Worker Loader cache key changes when source changes.
20. Worker Loader cache key changes when ITX scope changes.

Verification commands:

```bash
pnpm --dir apps/minimal-itx-v4 typecheck
pnpm exec oxfmt --check apps/minimal-itx-v4/src apps/minimal-itx-v4/*.test.ts
pnpm exec oxlint apps/minimal-itx-v4/src apps/minimal-itx-v4/*.test.ts --deny-warnings
pnpm --dir apps/minimal-itx-v4 verify:miniflare
ITX_BASE=<deployed-url> pnpm --dir apps/minimal-itx-v4 verify:deployed
```

## Open design questions

1. Is `WorkerRef` meant to be a public, caller-constructible recipe, or should
   users receive opaque handles/capabilities?
2. Should provided worker capabilities be latest-source by design, pinned to a
   build digest, or configurable?
3. Should direct `project.workers.get(statefulRef)` be a first-class API, or
   should stateful worker usage go through provided/mounted capabilities?
4. Should stateful dynamic workers be hosted:
   - one outer DO per durable worker key;
   - one supervisor DO per stream path with multiple facets;
   - or directly as facets of ITX DOs?
5. Should dynamic code get `env.ITX.get()` as a broad scoped root capability,
   or should it get a narrower imports object?
6. Should raw dynamic path calls be supported at all, or should all dynamic
   capabilities require descriptors/codegen?
7. If raw path calls stay, what should the public name be so users understand
   it is dynamic and untyped?
8. What is the minimum build/typecheck artifact needed before we claim typed
   dynamic workers?
9. What lifecycle events should the workers domain emit for validation, build,
   typecheck, worker start, worker failure, source change, and facet restart?
10. What should revocation mean for stateful capabilities: unmount only,
    unmount plus abort, or unmount plus delete storage?

## Non-goals for the first cleanup pass

- Do not build the full Worker Bundler/typecheck artifact system yet.
- Do not require codegen before cleaning up the unsafe type signatures.
- Do not introduce a large registry abstraction unless the handle/recipe
  distinction cannot be made cleanly without it.
- Do not add backwards compatibility shims for old `dynamic-workers` names.

## Done criteria

This task is done when:

- The public API no longer exposes accidental transport plumbing.
- Dynamic worker refs/recipes are named honestly.
- The scoped ITX dynamic-worker binding no longer exposes `authenticate`.
  This is already true after the follow-up cleanup.
- There is no provide-time worker validation path that loads Worker Loader or
  mutates stateful facets.
- `props` only exists where it actually works.
- Dynamic workers block outbound network access by default.
- Worker Loader cache keys are stable and collision-resistant enough for source
  identity.
- The path proxy is either removed from the core model or documented and tested
  as an explicit dynamic escape hatch.
- Type checking passes.
- Miniflare e2e tests pass.
- Deployed-worker e2e tests pass.
