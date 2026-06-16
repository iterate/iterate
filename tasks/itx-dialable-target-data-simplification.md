---
state: todo
priority: high
size: medium
tags: [os, itx, architecture, api-polish]
---

# Simplify itx dialable target data to worker entrypoints and Durable Objects

The current production itx target model exposes too many materialization details
as peer target kinds: `binding`, `loopback`, `source`, and `durable-object`.
That makes "what can I dial?" harder to understand than the actual platform
topology.

Collapse the durable/sturdy dialable data model to two target families:

1. **Worker entrypoint**
2. **Durable Object**

Everything else is a locator or materialization strategy inside one of those
families, not a separate top-level capability kind.

## Proposed shape

Sketch only; final names should follow the surrounding `apps/os` style.

```ts
type DialableTarget = WorkerEntrypointTarget | DurableObjectTarget;

type WorkerEntrypointTarget = {
  kind: "workerEntrypoint";
  worker:
    | { kind: "loopback"; name: string }
    | { kind: "envBinding"; envBindingName: string; name?: string };
  props?: Record<string, unknown>;
};

type DurableObjectTarget = {
  kind: "durableObject";
  namespace: { envBindingName: string };
  name: string;
};

type SourceWorkerProps = {
  source:
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
  entrypoint?: string;
  innerProps?: Record<string, unknown>;
  compatibilityDate?: string;
};

type ItxCapabilityBinding = {
  get(): Promise<unknown>;
};
```

Meaning:

- `workerEntrypoint.worker.kind === "loopback"` means a named `ctx.exports`
  entrypoint in the current worker script.
- `workerEntrypoint.worker.kind === "envBinding"` means a deployed/bound worker
  service binding, optionally with a named entrypoint.
- `workerEntrypoint.props` carries entrypoint construction parameters.
- Dynamic worker source is represented by a normal worker entrypoint adapter,
  not by a top-level `source` target. For example, a loopback
  `DynamicWorkerCapability` entrypoint can receive `SourceWorkerProps`. Use the
  existing production source shapes: inline modules or real repo source
  `{ type: "repo", repo, commit, path, bundle? }`.
  The adapter builds/loads the dynamic worker through `LOADER` and replays the
  requested path onto the loaded entrypoint.
- Dynamic workers loaded by that adapter should receive an `env.ITX` binding.
  The source worker should obtain its scoped itx handle with `await env.ITX.get()`
  rather than by being handed a special argument or by reaching back through
  HTTP. Express this as a named `ItxCapability` worker entrypoint/binding that
  the source adapter installs into the loaded worker's env.
- `context`, `itxRef`, `capabilityPath`, mounted path, origin, and similar
  attribution/scoping values must not appear in public target data. If
  `ItxCapability` needs them, they are internal host wiring: the host mounting
  the capability already knows which itx it is serving and where the capability
  is mounted.
- `durableObject.namespace.envBindingName` names a DO namespace binding.
- `durableObject.name` names the object instance inside that namespace.

## Rules

- OpenAPI, MCP, Slack, Gmail, Secrets, etc. are not target kinds. They are named
  worker entrypoints.
- Plain host resources like `env.AI`, R2, D1, KV, queues, and Hyperdrive should
  not be public target families. If they are exposed to itx, expose them through
  small worker-entrypoint adapters.
- Durable Objects are not modeled as generic env bindings. They require a
  namespace binding plus object identity, so they stay their own target family.
- Dynamic/source workers must not become a third top-level target family in the
  public model. Source loading is just a worker-entrypoint adapter with source
  code or the existing production repo source shape in `props`.
- The dynamic worker environment should expose `ITX`, not `ITERATE`, and the
  ergonomic API should be `env.ITX.get()` for the current scoped handle. The
  source target data does not need to carry an explicit context ref; the host
  mounting the capability already knows which itx it is wiring.
- Public `props` are for the worker entrypoint's own configuration only
  (`source`, `entrypoint`, `innerProps`, API URLs, etc.). They are not where the
  host smuggles identity or attribution.
- Live targets are outside this task. They are ephemeral session capabilities,
  not sturdy dialable data.

## Migration Notes

- Current `{ type: "rpc", worker: { type: "loopback" }, entrypoint, props }`
  maps to `workerEntrypoint` with `worker.kind = "loopback"`.
- Current `{ type: "rpc", worker: { type: "binding", binding }, entrypoint?,
props? }` maps only if the binding is actually a worker service binding.
  Direct replay onto arbitrary env resources should move behind adapters.
- Current `{ type: "rpc", worker: { type: "durable-object", binding, name } }`
  maps to `durableObject`.
- Current `{ type: "rpc", worker: { type: "source", source }, ... }` maps to a
  worker-entrypoint adapter, probably loopback first:
  `workerEntrypoint(DynamicWorkerCapability, { source, entrypoint, innerProps })`.
  Repo-backed sources use the current production shape
  `{ type: "repo", repo, commit, path, bundle? }`.

## Out of Scope

- Do not implement `/api/itx2` in this task.
- Do not port all existing production capabilities.
- Do not create a third public source target family. A source-loader design is
  allowed only as a named worker entrypoint adapter.
- Do not change the live-capability bridge.

## Acceptance

- The target data model has only two sturdy top-level families:
  `workerEntrypoint` and `durableObject`.
- Existing first-party capabilities currently represented as loopbacks are
  described as worker entrypoints.
- Durable Object targets require `{ envBindingName, name }` and are not confused
  with direct env binding replay.
- Raw resource bindings are reachable only through worker-entrypoint adapters.
- The current `source` target is represented as a named worker entrypoint
  adapter that builds/loads dynamic workers from inline code or the existing
  production repo source data passed in props.
- Source-loaded workers receive a scoped `env.ITX` binding and can call
  `await env.ITX.get()` to access their current itx context.
- The public target data contains no `context`, `itxRef`, `origin`, or
  `capabilityPath` fields. Those are internal host facts, not provider input.
