# Minimal ITX v4 Capability Plan

This plan captures the current design direction for first-party and dynamic
capabilities in `apps/minimal-itx-v4`. It is intentionally a plan, not a claim
that every API described here exists today.

## Goals

- Keep the `Project` RPC surface as the place where capability helpers live.
  `AgentItx` extends `Project`, so agents inherit the same behavior.
- Make MCP and OpenAPI first-party conveniences because they are common, while
  preserving the ability to implement equivalent behavior in dynamic workers.
- Keep remote network behavior in the existing project fetch/egress layer.
  Capability adapters name remote services and call fetch; egress resolves
  secrets, applies policy, and performs requests.
- Make mounted capabilities durable event-sourced recipes. Avoid eager
  connection work during `provideCapability(...)`.
- Avoid runtime probing of live capabilities for metadata. Use declared event
  metadata for now.

## Non-Goals

- Do not add `itx.mount(...)` or separate mounting sugar.
- Do not introduce a generalized dialer abstraction in v4 yet.
- Do not expose built-in WorkerEntrypoint mechanics as part of the minimal v4
  public model.
- Do not preserve backward compatibility for the current `type: "worker"` /
  `workerRef` mounted capability recipe.
- Do not add capability description update events, type discovery events, or
  runtime target shape requirements yet.

## Current Reference Points

`apps/os` already proves the broad pattern:

- OS has loopback named WorkerEntrypoints for MCP and OpenAPI clients.
- Those entrypoints are addressed through a generalized dialer shape.
- MCP and OpenAPI clients fetch through project egress.
- The OpenAPI client dispatches by flat `operationId`.
- The MCP client exposes tools as invokable capability methods.

Minimal v4 should take the useful result without copying the whole OS dialer
model. In v4, MCP and OpenAPI helpers should be normal `ProjectRpcTarget`
built-ins in `src/rpc-targets.ts`, alongside `streams`, `repos`, `workers`,
`worker`, `agents`, and `egress`.

## Two API Surfaces

There are two distinct surfaces.

### Durable Mounted Capabilities

Mounted capabilities are installed explicitly:

```ts
await project.provideCapability({
  path: ["pets"],
  capability: {
    type: "openapi",
    specUrl: "https://example.com/openapi.json",
    baseUrl: "https://api.example.com",
    headers: {
      Authorization: 'Bearer getSecret("PETS_API_TOKEN")',
    },
  },
  instructions: "Use this for pet inventory and adoption workflows.",
  types: "OpenAPI operation ids are exposed as dotted capability methods.",
});
```

The mount is durable because it is recorded in the ITX event stream. The recipe
should be lazy: appending the event validates the recipe shape but does not
connect to MCP, fetch an OpenAPI spec, load a dynamic worker, or allocate a
stateful worker facet.

### Ad-Hoc Clients

Ad-hoc clients are temporary helpers for scripts and RPC sessions:

```ts
const docs = await project.mcp.connect({
  url: "https://docs.example.com/mcp",
  headers: {
    Authorization: 'Bearer getSecret("DOCS_MCP_TOKEN")',
  },
});

await docs.listTools();
await docs.search_cloudflare_documentation({ query: "Workers RPC" });
```

```ts
const pets = await project.openapi.connect({
  specUrl: "https://example.com/openapi.json",
  baseUrl: "https://api.example.com",
  headers: {
    Authorization: 'Bearer getSecret("PETS_API_TOKEN")',
  },
});

await pets.listOperations();
await pets.findPetsByStatus({ status: "available" });
```

These helpers should return dynamic dotted capability objects, not low-level
transport clients. They are not durable mounts and should not add events.

## Public Capability Recipes

The mounted recipe union should move toward:

```ts
type ProvidedCapability =
  | {
      flattenNestedPath?: boolean;
      target: unknown;
      type: "live";
    }
  | {
      flattenNestedPath?: boolean;
      ref: DynamicWorkerRef;
      type: "dynamic-worker";
    }
  | {
      headers?: Record<string, string>;
      timeoutMs?: number;
      type: "mcp";
      url: string;
    }
  | {
      baseUrl?: string;
      headers?: Record<string, string>;
      specUrl: string;
      type: "openapi";
    };
```

`instructions?: string` and `types?: string` stay on the
`provideCapability(...)` input and the `capability-provided` event. They are
plain string fields. No special runtime type exchange is needed now.

### Dynamic Worker Recipe

Rename the durable worker capability recipe:

```ts
{
  type: "dynamic-worker";
  ref: DynamicWorkerRef;
  flattenNestedPath?: boolean;
}
```

Remove the old shape:

```ts
{
  type: "worker";
  workerRef: WorkerRef;
}
```

No compatibility aliases are required in minimal v4.

The domain should be consistently named `dynamic-worker`:

- source folder: `src/domains/dynamic-workers/`
- event namespace / processor slug: `dynamic-worker`
- code names: `DynamicWorkerRef`, `StatelessDynamicWorkerRef`,
  `StatefulDynamicWorkerRef`, `DynamicWorkerRunner`,
  `DynamicWorkerCollection`

Keep the public project affordances short:

- `project.workers`
- `project.worker`
- `itx.workers` where applicable

The repo/domain folder can still use `worker` for source file names and brevity
where it refers to user-authored worker code, such as `worker.js`.

### MCP Recipe

The MCP mounted shape should be compatible with the common remote server entry
style used by `mcp.json`, but flattened for this API:

```ts
{
  type: "mcp";
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}
```

Do not nest this under `server`. Do not add an explicit transport field yet.
Remote HTTP is the default. SSE or other transports can be added later if the
fetch layer and adapter need them.

The ad-hoc form omits the mounted `type`:

```ts
await project.mcp.connect({
  url: "https://example.com/mcp",
  headers: { Authorization: 'Bearer getSecret("MCP_TOKEN")' },
});
```

### OpenAPI Recipe

The OpenAPI mounted shape should be:

```ts
{
  type: "openapi";
  specUrl: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}
```

The ad-hoc form omits the mounted `type`:

```ts
await project.openapi.connect({
  specUrl: "https://example.com/openapi.json",
  baseUrl: "https://api.example.com",
  headers: { Authorization: 'Bearer getSecret("OPENAPI_TOKEN")' },
});
```

Dispatch should be by flat `operationId`. Include a discovery method such as
`listOperations()`.

## Fetch, Egress, And Secrets

MCP and OpenAPI adapters should not own egress policy. The fetch layer is the
boundary:

- resolve `getSecret("KEY")` placeholders in headers
- apply project outbound policy
- perform network fetches
- provide the same behavior to built-in helpers and dynamic workers

Dynamic workers receive only their `env.ITX` binding. If a dynamic worker wants
MCP or OpenAPI access, it should call back into ITX, for example through
`itx.mcp.connect(...)`, `itx.openapi.connect(...)`, or a mounted capability.

## Built-Ins Versus Dynamic Workers

MCP and OpenAPI are first-party because they are common, not because they need
special routing semantics. The mounted capability router can treat them as
recipe types that instantiate the appropriate project helper on demand.

Equivalent behavior must remain possible in dynamic workers:

- OpenAPI should be proved first with a dependency-free dynamic worker test.
- MCP needs worker bundling or vendored modules before a realistic dynamic
  worker end-to-end test is useful.

This means built-in MCP/OpenAPI code should avoid depending on private host
state that dynamic workers could never access, except for the normal ITX
capability and project egress path.

## Live Capabilities

Do not force all live capabilities into an object with `run()` and
`describe()`. Cap'n Web / Workers RPC does not give a reliable generic way to
distinguish a bare function stub from an RPC target stub after crossing the
boundary. Runtime shape probing should not be part of the design.

Live capabilities remain either:

- a normal object/function target replayed by dotted path
- a flattened target when `flattenNestedPath: true`

Descriptions are declared at mount time with `instructions` and `types`.

## Project Description

`project.describe()` should supersede the current project-only response. It
should return project identity plus a capability inventory:

```ts
type ProjectDescription = {
  capabilities: Array<{
    instructions?: string;
    path: string[];
    providedAtOffset?: number;
    type: "builtin" | "live" | "dynamic-worker" | "mcp" | "openapi";
    types?: string;
  }>;
  name: string;
  projectId: string;
};
```

The inventory should include fixed project built-ins and mounted capabilities.
It should be derived from declared/event metadata only. It should not call live
targets, dynamic workers, MCP servers, or OpenAPI specs to discover metadata at
describe time.

Built-ins to list include:

- `streams`
- `repos`
- `repo`
- `workers`
- `worker`
- `agents`
- `egress`
- `mcp`
- `openapi`

## Routing And Collision Rules

Mounted paths should continue to use the existing built-in collision behavior:
reject a mounted capability whose root segment collides with an existing
project RPC property or reserved segment. No additional reservation system is
needed.

Dynamic dotted path fallback remains the dispatch mechanism for mounted
capabilities.

## Implementation Sequence

1. Rename worker-domain types and files to dynamic-worker terminology.
2. Change `ProvidedCapability` and event schemas from `type: "worker"` /
   `workerRef` to `type: "dynamic-worker"` / `ref`.
3. Add `instructions?: string` and `types?: string` to
   `provideCapability(...)` and the `capability-provided` event.
4. Update `project.describe()` to return project identity plus built-in and
   mounted capability descriptions.
5. Add `project.openapi.connect(...)` and the OpenAPI mounted recipe path.
6. Add OpenAPI end-to-end coverage for both built-in mounted/ad-hoc use and a
   dynamic-worker implementation of equivalent behavior.
7. Add `project.mcp.connect(...)` and the MCP mounted recipe path.
8. Add MCP end-to-end coverage after worker bundling or vendored MCP client
   support is available.

## Test Expectations

Cover these behaviors:

- mounted `dynamic-worker` recipes use `ref`, not `workerRef`
- no old `type: "worker"` mounted capability shape is accepted
- `instructions` and `types` round-trip through `provideCapability(...)`,
  stream events, and `project.describe()`
- built-ins appear in `project.describe()`
- mounted OpenAPI exposes operations by `operationId`
- ad-hoc OpenAPI does not append capability events
- OpenAPI dynamic worker can provide equivalent behavior through ITX
- mounted MCP exposes tools as dotted methods
- ad-hoc MCP does not append capability events
- MCP dynamic worker proof is added once bundling support exists

## Open Questions

- Exact `ProjectDescription` field names can be adjusted during implementation.
- Host matching for OpenAPI `specUrl`, `baseUrl`, and auth headers should be
  decided in the fetch layer, not the adapter API.
- MCP transport variants can be added later when the default remote HTTP shape
  is insufficient.
