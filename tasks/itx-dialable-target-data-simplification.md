---
state: todo
priority: high
size: medium
tags: [os, itx, architecture, api-polish]
---

# Simplify itx dialable target data to trusted and untrusted addresses

The current production itx target model exposes too many materialization details
as peer target kinds: `binding`, `loopback`, `source`, and `durable-object`.
That makes "what can I dial?" harder to understand than the actual platform
topology.

Collapse the durable/sturdy dialable data model into two layers:

1. **Untrusted capability addresses** — provider/user/script supplied.
2. **Trusted capability addresses** — platform/built-in supplied.

Untrusted addresses must not mention raw env bindings, loopback export names,
Durable Object namespace bindings, project ids, context refs, or mounted paths.
Trusted addresses may use those escape hatches because they are written by
platform code, not by a capability provider.

## Proposed shape

Sketch only; final names should follow the surrounding `apps/os` style.

```ts
type CapabilityAddress = UntrustedCapabilityAddress | TrustedCapabilityAddress;

type UntrustedCapabilityAddress = DynamicWorkerAddress | DynamicDurableObjectAddress;

type DynamicWorkerAddress = {
  type: "dynamic-worker";
  source: DynamicWorkerSource;
  entrypoint?: string;
  props?: Record<string, unknown>;
};

type DynamicDurableObjectAddress = {
  type: "dynamic-durable-object";
  source: DynamicWorkerSource;
  className: string;
};

type TrustedCapabilityAddress =
  | UntrustedCapabilityAddress
  | TrustedEnvBindingAddress
  | TrustedLoopbackAddress
  | TrustedDurableObjectAddress;

type TrustedLoopbackAddress = {
  type: "loopback";
  entrypoint: string;
  props?: Record<string, unknown>;
};

type TrustedEnvBindingAddress = {
  type: "env-binding";
  binding: string;
  path?: string[];
};

type TrustedDurableObjectAddress = {
  type: "durable-object";
  namespace: string;
  name: string;
  path?: string[];
};

type DynamicWorkerSource =
  | {
      type: "inline";
      mainModule: string;
      modules: Record<string, string>;
    }
  | {
      type: "repo";
      repo: string;
      commit: string | "latest";
      path: string;
      bundle?: { minify?: boolean; externals?: string[] };
    };

type DynamicWorkerOptions = {
  compatibilityDate?: string;
};

type ItxBinding = {
  get(): Promise<unknown>;
};
```

Meaning:

- `type === "dynamic-worker"` is the safe public source-backed capability
  address. It is the public form of what production currently represents as a
  `source` worker with `exportType: "worker-entrypoint"`.
- `type === "dynamic-durable-object"` is the safe public stateful source-backed
  address. It loads inline code or repo source, extracts a named class ending in
  `DurableObject`, and materializes it as a facet of the current
  `ItxDurableObject`.
- `type === "loopback"` is trusted-only. It means a named `ctx.exports`
  entrypoint in the current worker script. `WorkerEntrypoint` is the runtime
  backend for this shape, not the conceptual capability model.
- `type === "env-binding"` is trusted-only. It means a host env binding whose
  concrete object is replayed directly. Use sparingly; prefer loopback or
  durable-object addresses for domain surfaces.
- `type === "durable-object"` is trusted-only. It means a Durable Object
  namespace plus object name plus an optional path prefix. Trusted domain objects can use
  this to mount exact methods on themselves, for example an Agent Durable Object
  mounting its own `sendMessage` or `stream` method as an itx built-in.
- `props` carries WorkerEntrypoint construction parameters and only belongs on
  WorkerEntrypoint-backed addresses (`dynamic-worker` and `loopback`). It does
  not belong on `dynamic-durable-object`.
- Dynamic worker source is represented directly as `type: "dynamic-worker"`,
  not as a public loopback reference to an adapter. The runtime may share loader
  helper code, but that adapter name is not provider-supplied target data.
- Dynamic durable source is represented directly as
  `type: "dynamic-durable-object"`, not as `dynamic-worker` plus
  `exportType`. The dialer branch should inline the Cloudflare AppRunner shape:
  `this.ctx.facets.get(facetName, async () => ({ class }))`.
- The facet name is host-owned, e.g. `cap:<mounted-capability-path>` or
  `dynamic-durable-object:<mounted-capability-path>`, not provider-supplied
  target data.
- Dynamic workers loaded by the dialer should receive an `env.ITX` binding.
  The source worker should obtain its scoped itx handle with `await env.ITX.get()`
  rather than by being handed a special argument or by reaching back through
  HTTP. Express this as the one service-binding-style entrypoint we expect to
  expose to dynamic code.
- Dynamic durable workers require host facet power. The itx processor should
  not create facets directly; its host/dialer branch creates or resumes a facet
  on the current `ItxDurableObject`. This mirrors v1:
  `ItxDurableObject` passes `durableObjectFacetsHook(this.ctx)` into `makeDial`,
  and the dialer calls `ctx.facets.get(...)` for stateful source capabilities.
- `context`, `itxRef`, `capabilityPath`, mounted path, origin, and similar
  attribution/scoping values must not appear in public target data. If
  `env.ITX` needs them, they are internal host wiring: the host mounting
  the capability already knows which itx it is serving and where the capability
  is mounted.
- `durable-object.namespace` names a trusted Durable Object namespace known to
  the dialer.
- `durable-object.name` names the object instance inside that namespace.
- `durable-object.path` is a trusted path prefix replayed before the caller's
  remainder path. This is the deep sturdy-ref shape for trusted built-ins.

## Rules

- OpenAPI, MCP, Slack, Gmail, Secrets, etc. are not untrusted target kinds. They
  are trusted platform-provided capabilities, often implemented as loopback
  WorkerEntrypoints. WorkerEntrypoint is an implementation backend, not a
  capability concept.
- Plain host resources like `env.AI`, R2, D1, KV, queues, and Hyperdrive should
  not be public target families. If they are exposed to itx, expose them through
  trusted platform capabilities.
- Raw env binding names are trusted-only. This removes the need for a public
  allowlist around arbitrary provider-supplied env binding references.
- Durable Object namespace bindings are trusted-only. Dynamic durable user code
  gets state through facets instead of naming a namespace.
- Dynamic/source workers are the public untrusted address shape. They are safe
  because the host chooses the loader, env, `ITX` binding, facet host, and state
  address.
- Facet creation is a host/dialer dependency, not stream-fold state. The folded
  capability row stores only the `dynamic-durable-object` address; on invoke,
  the dialer calls `ctx.facets.get(...)` on the current `ItxDurableObject`.
- The dynamic worker environment should expose `ITX`, not `ITERATE`, and the
  ergonomic API should be `env.ITX.get()` for the current scoped handle. The
  source target data does not need to carry an explicit context ref; the host
  mounting the capability already knows which itx it is wiring.
- Public `props` are for the worker entrypoint's own configuration only
  (`dynamic-worker`, loopback clients, API URLs, etc.). They are not where the
  host smuggles identity or attribution, and they are not available on dynamic
  durable object addresses.
- Trusted domain objects may seed their own context with exact durable-object
  path refs. This is how an Agent Durable Object can expose `itx.sendMessage` or
  `itx.stream` without making the Agent Durable Object host the itx processor.
- Live targets are outside this task. They are ephemeral session capabilities,
  not sturdy dialable data.

## Migration Notes

- Current `{ type: "rpc", worker: { type: "loopback" }, entrypoint, props }`
  maps to trusted `type: "loopback"` with `entrypoint` and `props`.
- Current `{ type: "rpc", worker: { type: "binding", binding }, entrypoint?,
props? }` maps to trusted `type: "env-binding"` only when direct replay is
  genuinely intended. Service-binding/named-entrypoint usage should be modeled
  as a WorkerEntrypoint-backed runtime detail, not as public target language.
- Current `{ type: "rpc", worker: { type: "durable-object", binding, name } }`
  maps to trusted `type: "durable-object"`.
- Current `{ type: "rpc", worker: { type: "source", source }, ... }` maps to
  untrusted `type: "dynamic-worker"` or `type: "dynamic-durable-object"`.
  Repo-backed sources use the current production shape
  `{ type: "repo", repo, commit, path, bundle? }`.
- Current v1 dynamic durable source behavior maps directly: v1 creates a
  host-owned facet through the dialer. v2 should create an equivalent dynamic
  durable object facet keyed by the canonical mounted capability path, e.g.
  `dynamic-durable-object:<hash-of-mounted-path>`. There is no separate
  "capability name" concept in v2.

## Out of Scope

- Do not implement `/api/itx2` in this task.
- Do not port all existing production capabilities.
- Do not expose raw env bindings or loopback entrypoint names in untrusted
  provider data.
- Do not change the live-capability bridge.
- Do not introduce a generic dynamic Durable Object runner. The
  `ItxDurableObject` is the supervisor; facets are the platform primitive.
- Do not add DSL/helper builders for trusted built-ins as part of the model.
  Registration examples should show the literal address objects.

## Acceptance

- The public/untrusted target data model has no raw env binding names, loopback
  export names, Durable Object namespace binding names, project ids, context
  refs, origins, or capability paths.
- Untrusted dynamic stateless code is represented by `type: "dynamic-worker"`.
- Untrusted dynamic stateful code is represented by
  `type: "dynamic-durable-object"` and materialized as a facet.
- Trusted platform data can still represent loopback WorkerEntrypoints, direct
  env bindings, and deployed Durable Object namespace targets.
- Existing first-party capabilities currently represented as loopbacks are
  described as trusted loopback addresses, usually implemented by
  WorkerEntrypoint classes.
- Trusted Durable Object targets require `{ namespace, name }`, may include
  a `path` prefix, and are not confused with direct env binding replay.
- Raw resource bindings are reachable only through trusted platform
  capabilities.
- The current `source` target is represented as `type: "dynamic-worker"` or
  `type: "dynamic-durable-object"` using inline code or the existing production
  repo source data.
- Dynamic durable workers are materialized through a host-supplied facet
  dependency on the current `ItxDurableObject`, not by the processor fold and
  not by provider-supplied namespace data.
- Source-loaded workers receive a scoped `env.ITX` binding and can call
  `await env.ITX.get()` to access their current itx context.
- The public target data contains no `context`, `itxRef`, `origin`, or
  `capabilityPath` fields. Those are internal host facts, not provider input.
