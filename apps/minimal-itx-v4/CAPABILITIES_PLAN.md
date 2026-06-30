# Minimal ITX v4 Capability Plan

This plan captures the current design direction for first-party and dynamic
capabilities in `apps/minimal-itx-v4`. It is intentionally a plan, not a claim
that every API described here exists today.

## Goals

- Keep `Project` as the capability host. `AgentItx` extends `Project`, so
  project capability behavior should be designed once and inherited by agents.
- Preserve v4's current direct dotted capability surface: mounted capabilities
  are accessed as `project.some.path(...)`, not under `project.capabilities`.
- Make MCP and OpenAPI first-party conveniences because they are common, while
  keeping equivalent behavior implementable in dynamic workers.
- Keep remote network behavior in project egress. MCP/OpenAPI adapters name
  remote services and issue fetches; egress resolves secrets, enforces the
  current secret egress rules, and performs requests.
- Keep mounted capabilities durable and event-sourced. Remote first-party
  recipes validate and describe before append; dynamic workers stay lazy.
- Avoid runtime probing of live capabilities for metadata.

## Non-Goals

- Do not add `itx.mount(...)` or a separate capability manager.
- Do not introduce the generalized `apps/os` dialer abstraction in v4 yet.
- Do not expose built-in WorkerEntrypoint mechanics as part of the minimal v4
  public model.
- Do not preserve backward compatibility for the current `type: "worker"` /
  `workerRef` mounted capability recipe.
- Do not add capability description update events or runtime target shape
  requirements.
- Do not implement a full project type composer yet. Generated `types` strings
  should make that possible later.

## Current Reference Points

`apps/os` proves the broad pattern:

- MCP and OpenAPI are ordinary first-party clients, not special router magic.
- MCP and OpenAPI clients fetch through project egress.
- The OpenAPI client dispatches by flat `operationId`.
- The MCP client exposes tools as invokable capability methods.
- `apps/os/src/itx/capabilities/openapi-types.ts` derives TypeScript-ish
  declarations from OpenAPI specs.
- `packages/shared/src/type-tree/json-schema-types.ts` has direct precedent,
  adapted from Cloudflare `@cloudflare/codemode`, for turning MCP-style JSON
  Schema tool descriptors into TypeScript-ish declarations.

Minimal v4 should take those useful pieces without copying the OS dialer model.
MCP and OpenAPI helpers should be normal project built-ins, wired from
`ProjectRpcTarget` in `src/rpc-targets.ts`, with implementation classes under
`src/domains/itx`.

## Existing V4 Shape To Preserve

`ProjectRpcTarget` and `AgentRpcTarget` already return
`withInvokeCapabilityFallback(this)`. Built-ins are explicit methods/getters,
and unknown properties are routed through `invokeCapability({ path, args })`.

That is the model:

```ts
project.streams; // built-in
project.worker; // built-in
project.pets.findPetsByStatus(...); // mounted capability
project.github.issues.create(...); // mounted nested path
```

Mounted paths continue to use longest-prefix resolution in the ITX processor.
The router should grow new recipe branches for `dynamic-worker`, `openapi`, and
`mcp`; it should not gain a new namespace model.

## Public Surfaces

There are two surfaces.

### Durable Mounted Capabilities

Mounted capabilities are installed explicitly with a flat
`provideCapability(...)` input:

```ts
await project.provideCapability({
  path: ["pets"],
  type: "openapi",
  specUrl: "https://example.com/openapi.json",
  baseUrl: "https://api.example.com",
  headers: {
    Authorization: 'Bearer getSecret({ path: "/secrets/pets-api-token" })',
  },
  instructions: "Use this for pet inventory and adoption workflows.",
});
```

`provideCapability(...)` appends one `capability-provided` event if it
successfully mounts. If validation or remote discovery fails for a first-party
remote recipe, the call rejects and appends no event. Any existing capability at
that path remains unchanged.

### Ad-Hoc Clients

Ad-hoc clients are temporary connected RPC targets for scripts and RPC sessions:

```ts
const docs = await project.mcp.connect({
  url: "https://docs.example.com/mcp",
  headers: {
    Authorization: 'Bearer getSecret({ path: "/secrets/docs-mcp-token" })',
  },
});

await docs.describe();
await docs.search_cloudflare_documentation({ query: "Workers RPC" });
```

```ts
const pets = await project.openapi.connect({
  specUrl: "https://example.com/openapi.json",
  baseUrl: "https://api.example.com",
  headers: {
    Authorization: 'Bearer getSecret({ path: "/secrets/pets-api-token" })',
  },
});

await pets.describe();
await pets.findPetsByStatus({ status: "available" });
```

`connect(...)` actually connects/discovers. If it resolves, the returned RPC
target can answer `describe()` without a first-use discovery call.

## Flat Capability Recipes

The mounted input and event payload should move toward one flat discriminated
union:

```ts
type ProvideCapabilityInput =
  | {
      flattenNestedPath?: boolean;
      instructions?: string;
      path: string[];
      target: unknown;
      type: "live";
      types?: string;
    }
  | {
      flattenNestedPath?: boolean;
      instructions?: string;
      path: string[];
      ref: DynamicWorkerRef;
      type: "dynamic-worker";
      types?: string;
    }
  | {
      headers?: Record<string, string>;
      instructions?: string;
      path: string[];
      timeoutMs?: number;
      type: "mcp";
      types?: string;
      url: string;
    }
  | {
      baseUrl?: string;
      headers?: Record<string, string>;
      instructions?: string;
      path: string[];
      specUrl: string;
      type: "openapi";
      types?: string;
    };
```

The `capability-provided` event stores the same flat shape minus ephemeral
fields such as a live `target`. `instructions` and `types` are plain optional
strings on the event row.

`path` stays `string[]` for now. Do not add dot-string path sugar.

## Dynamic Worker Recipe

Rename the durable worker capability recipe:

```ts
{
  path: ["db"],
  type: "dynamic-worker",
  ref: DynamicWorkerRef,
  flattenNestedPath: true,
}
```

Remove the old shape:

```ts
{
  type: "worker",
  workerRef: WorkerRef,
}
```

No compatibility aliases are required in minimal v4.

The dynamic worker domain should be consistently named:

- source folder: `src/domains/dynamic-workers/`
- event namespace / processor slug: `dynamic-worker`
- code names: `DynamicWorkerRef`, `StatelessDynamicWorkerRef`,
  `StatefulDynamicWorkerRef`, `DynamicWorkerRunner`,
  `DynamicWorkerCollection`

Keep ergonomic public project names:

- `project.workers`
- `project.worker`
- `itx.workers` where applicable

Dynamic-worker mounts validate the ref shape at provide time, but do not load
source, touch Worker Loader, or allocate stateful facets until invocation.

## OpenAPI RPC Targets

OpenAPI implementation classes should live under `src/domains/itx`:

```ts
OpenApiCollectionRpcTarget; // project.openapi
OpenApiRpcTarget; // returned by project.openapi.connect(...)
```

`OpenApiCollectionRpcTarget.connect(input)` calls the same static connection
path used by durable provide and mounted invocation:

```ts
OpenApiRpcTarget.connect(input, { egress, projectId });
```

OpenAPI config:

```ts
{
  specUrl: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}
```

`connect(...)` fetches and parses the spec through `egress.fetch`, builds the
operation map, and returns an `OpenApiRpcTarget`. The target exposes only:

```ts
describe(): Promise<{ instructions: string; types: string }>;
```

Every other property/method is fallback-dispatched as an OpenAPI operation by
flat `operationId`.

No public `listOperations()` method for now. Raw operation discovery should be
represented in `describe().instructions` and `describe().types`.

Mounted OpenAPI provide uses the same connection path:

```ts
const adapter = await OpenApiRpcTarget.connect(config, { egress, projectId });
const derived = await adapter.describe();
```

Then it appends the event with:

```ts
instructions: input.instructions ?? derived.instructions;
types: input.types ?? derived.types;
```

This is overwrite, not merge. Caller-provided metadata wins.

Mounted OpenAPI invocation can reconnect/refetch through the same connection
path for simplicity. No cache is required for the first pass.

## MCP Client RPC Targets

MCP implementation classes should live under `src/domains/itx`:

```ts
McpClientCollectionRpcTarget; // project.mcp
McpClientRpcTarget; // returned by project.mcp.connect(...)
```

`McpClientCollectionRpcTarget.connect(input)` calls the same static connection
path used by durable provide and mounted invocation:

```ts
McpClientRpcTarget.connect(input, { egress, projectId });
```

MCP config should stay close to common `mcp.json` remote server entries, but
flattened for this API:

```ts
{
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}
```

Do not nest this under `server`. Do not add an explicit transport field yet.
Remote streamable HTTP is the default.

MCP should be stateless like the current OS client:

- `connect(...)` connects, lists tools, closes the MCP client, and returns an
  `McpClientRpcTarget` holding discovered tool metadata.
- `describe()` uses the stored tool metadata.
- Each fallback tool invocation connects, calls the tool, and closes.

The target exposes only:

```ts
describe(): Promise<{ instructions: string; types: string }>;
```

Every other property/method is fallback-dispatched as an MCP tool name.

No public `listTools()` method for now. Tool discovery should be represented in
`describe().instructions` and `describe().types`.

Mounted MCP provide uses the same connection path, derives metadata from
`describe()`, and stores caller-provided metadata when supplied:

```ts
instructions: input.instructions ?? derived.instructions;
types: input.types ?? derived.types;
```

Mounted MCP invocation can reconnect/list/call/close through the same simple
stateless path. No connection cache is required.

## Types String Convention

`types` should be a valid TypeScript source string that exports
`type Capability`.

Generated OpenAPI/MCP types should look like:

```ts
export type Capability = {
  describe(): Promise<{ instructions: string; types: string }>;

  /** Find pets by status */
  findPetsByStatus(input: { status: string }): Promise<unknown>;
};
```

Manual `types` should follow the same convention, but v4 should not validate
this yet. No TypeScript parser is needed during provide.

This convention is enough for a future composer to parse each capability's
`types`, extract `Capability`, and mount it under the durable path. Do not build
that composer in this pass.

## Instructions Convention

Generated `instructions` should briefly explain how to call the capability and
should mention that `describe()` exists.

Example OpenAPI guidance:

```txt
Call operations directly by operationId with one input object containing path
params, query params, and body fields. Call describe() for this capability's
instructions and TypeScript declarations.
```

Example MCP guidance:

```txt
Call tools directly by tool name with one input object matching the tool schema.
Call describe() for this capability's instructions and TypeScript declarations.
```

## Fetch, Egress, And Secrets

MCP and OpenAPI adapters should not own secret lookup or egress policy. They
receive an `egress: Fetcher` and issue requests with `egress.fetch(request)`.

`ItxProcessor` should receive the existing project egress fetcher directly:

```ts
new ItxProcessor({
  ...deps,
  egress: projectEgressFetcher(this.ctx.exports, this.#name.projectId),
  path: this.#name.path,
  projectId: this.#name.projectId,
  workerRunner,
});
```

`ProjectRpcTarget` ad-hoc helpers should use the same helper:

```ts
OpenApiRpcTarget.connect(input, {
  egress: projectEgressFetcher(this.props.ctx.exports, this.props.projectId),
  projectId: this.props.projectId,
});
```

The secrets domain now supports path-addressed secret references in headers:

```ts
getSecret({ path: "/secrets/pets-api-token" });
```

Secret material is not publicly readable. `project.secrets.get(path).update(...)`
stores material and allowed egress URLs. Project egress routes requests with a
single secret reference through the matching Secret Durable Object, which
substitutes material only when the request origin is allowed and records usage
audit events.

That means MCP/OpenAPI integration tests can use real project secrets:

```ts
const secret = project.secrets.get("/secrets/pets-api-token");
await secret.update({
  material: "actual-token",
  egress: { urls: [mockApiBaseUrl] },
});

await project.provideCapability({
  path: ["pets"],
  type: "openapi",
  specUrl: `${mockApiBaseUrl}/openapi.json`,
  headers: {
    Authorization: 'Bearer getSecret({ path: "/secrets/pets-api-token" })',
  },
});
```

The adapter sees only the header placeholder. Egress owns substitution and
policy. If a spec fetch or MCP handshake needs auth, the secret must allow that
remote origin.

## Built-Ins Versus Dynamic Workers

MCP and OpenAPI are first-party because they are common, not because they need
special routing semantics. Equivalent behavior must remain possible in dynamic
workers through ITX and project egress.

OpenAPI dynamic-worker parity should be tested first because it can be done
without npm module bundling. MCP dynamic-worker parity can follow once worker
bundling or vendored MCP SDK support exists.

## Live Capabilities

Do not force live capabilities into an object with `run()` and `describe()`.
Cap'n Web / Workers RPC does not give a reliable generic way to distinguish a
bare function stub from an RPC target stub after crossing the boundary. Runtime
shape probing should not be part of the design.

Live capabilities remain either:

- a normal object/function target replayed by dotted path
- a flattened target when `flattenNestedPath: true`

Live capability descriptions are caller-declared with `instructions` and
`types` on `provideCapability(...)`.

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
targets, dynamic workers, MCP servers, or OpenAPI specs at project describe
time.

Built-ins to list include:

- `streams`
- `repos`
- `repo`
- `workers`
- `worker`
- `agents`
- `egress`
- `secrets`
- `mcp`
- `openapi`

## Routing And Collision Rules

Mounted paths should continue to use the existing built-in collision behavior:
reject a mounted capability whose root segment collides with an existing
project RPC property or reserved segment. No additional reservation system is
needed.

Explicit methods on an adapter win over fallback dispatch. If a remote
operation/tool conflicts with `describe`, we can solve that later.

Dynamic dotted path fallback remains the dispatch mechanism for mounted
capabilities.

## Implementation Sequence

1. Flatten `provideCapability(...)` and event payloads.
2. Rename mounted worker recipes to `type: "dynamic-worker"` / `ref` and remove
   `type: "worker"` / `workerRef`.
3. Add `instructions?: string` and `types?: string` to
   `provideCapability(...)`, `capability-provided`, and capability records.
4. Update `project.describe()` to return project identity plus built-in and
   mounted capability descriptions.
5. Add OpenAPI type derivation under `src/domains/itx`, generating
   `export type Capability = ...`.
6. Add `OpenApiCollectionRpcTarget` and `OpenApiRpcTarget` under
   `src/domains/itx`, and expose `project.openapi`.
7. Add OpenAPI mounted provide/invoke support in the ITX processor.
8. Add OpenAPI end-to-end coverage for ad-hoc connect, mounted provide/invoke,
   `describe()`, generated `types`, and real secret-backed egress.
9. Add MCP JSON Schema tool type derivation under `src/domains/itx`, generating
   `export type Capability = ...`.
10. Add `McpClientCollectionRpcTarget` and `McpClientRpcTarget` under
    `src/domains/itx`, and expose `project.mcp`.
11. Add MCP mounted provide/invoke support in the ITX processor.
12. Add MCP end-to-end coverage for ad-hoc connect, mounted provide/invoke,
    `describe()`, generated `types`, and real secret-backed egress.
13. Add OpenAPI dynamic-worker parity coverage.
14. Add MCP dynamic-worker parity coverage after worker bundling or vendored
    MCP client support is available.

## Test Expectations

Cover these behaviors:

- `provideCapability(...)` is flat; no nested `capability` property.
- mounted `dynamic-worker` recipes use `ref`, not `workerRef`.
- no old `type: "worker"` mounted capability shape is accepted.
- `instructions` and `types` round-trip through `provideCapability(...)`,
  stream events, and `project.describe()`.
- generated remote `types` are valid source strings with
  `export type Capability = ...`.
- manual `types` are accepted as strings without validation.
- built-ins, including `secrets`, `mcp`, and `openapi`, appear in
  `project.describe()`.
- OpenAPI `connect()` fails if the spec cannot be fetched or parsed.
- OpenAPI `connect()` returns an RPC target with `describe()` and fallback
  operation dispatch.
- OpenAPI mounted provide connects/describes before append and appends no event
  on failure.
- OpenAPI invocation dispatches by flat `operationId`.
- OpenAPI ad-hoc connect does not append capability events.
- OpenAPI e2e tests use `project.secrets` and egress URL allowlists for auth.
- MCP `connect()` connects, lists tools, closes, and returns an RPC target with
  `describe()` and fallback tool dispatch.
- MCP mounted provide connects/describes before append and appends no event on
  failure.
- MCP tool invocation connects/calls/closes statelessly.
- MCP ad-hoc connect does not append capability events.
- MCP e2e tests use `project.secrets` and egress URL allowlists for auth.
- OpenAPI dynamic worker can provide equivalent behavior through ITX.
- MCP dynamic worker proof is added once bundling support exists.

## Open Questions

- Exact `ProjectDescription` field names can be adjusted during implementation.
- Host matching for OpenAPI `specUrl`, `baseUrl`, and auth headers is currently
  handled by egress/secret policy. The adapter API should stay simple unless
  tests reveal a real leak or usability problem.
- MCP transport variants can be added later when the default remote HTTP shape
  is insufficient.
