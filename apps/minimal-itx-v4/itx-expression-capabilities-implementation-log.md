# ITX Expression Capabilities Implementation Log

Date: 2026-07-01

## Goal

Simplify durable capability recipes by adding one replayable ITX expression form:

```ts
await project.provideCapability({
  path: ["docs"],
  type: "itx-expression",
  expression: ["mcp", ["connect", { url }]],
});
```

The durable record stores the expression, not a connected object. On invocation,
ITX evaluates the expression against a project-like ITX surface whose dynamic
fallback is scoped to the owning ITX host, normalizes the result as a provider
value, then invokes the remaining path.

Metadata is separate from the connected capability value. `instructions`,
`types`, and `flattenNestedPaths` are only taken from the
`provideCapability(...)` input and the resulting `capability-provided` event.
ITX does not inspect the returned capability for metadata.

## Decisions

- Removed separate durable `dynamic-worker`, `mcp`, and `openapi` capability
  record types. Durable built-ins now mount through `itx-expression` only, for
  example `["workers", ["get", ref]]` or `["mcp", ["connect", input]]`.
- Passed a `ProjectRpcTarget` into `ItxProcessor` as a dependency. The
  processor does not reach for `env.ITX`.
- Expression evaluation uses the current ITX host path for dynamic fallback
  routing. Built-ins such as `streams` and `workers` remain project-scoped, but
  expression aliases to other mounted capabilities resolve against the same
  project/agent capability host that owns the durable record.
- Expression records do not evaluate at provide time. The stream event commits
  the durable recipe plus caller-supplied metadata; invocation replays the
  expression every time.
- Live `provideCapability` accepts `capability` and `flattenNestedPaths`.
  `itx-expression` accepts `expression` and optional `flattenNestedPaths`.
  Expression results are literal capabilities: a returned object with a
  `capability` property remains that object, not a package.
- Added a tiny `/__itx_e2e/*` fixture surface to the minimal worker so deployed
  e2e can verify OpenAPI/MCP/egress behavior without asking Cloudflare to fetch
  a local `127.0.0.1` test server. The deployed OpenAPI and MCP fixtures enforce
  the expected Authorization header, so the test still proves project egress
  secret substitution.

## Implemented Call Shapes

```ts
await project.mcp.connect(input).search_docs({ query: "Workers" });

await project.openapi.connect(input).findPetsByStatus({ status: "available" });

await project.provideCapability({
  path: ["pets"],
  type: "itx-expression",
  expression: ["openapi", ["connect", input]],
  instructions: "Call petstore operations by operationId.",
  types:
    "export type Capability = { findPetsByStatus(input: { status: string }): Promise<unknown> };",
});
await project.pets.findPetsByStatus({ status: "available" });

await project.provideCapability({
  path: ["workerTool"],
  type: "itx-expression",
  expression: ["workers", ["get", ref]],
  instructions: "Echoes its input.",
  types: "export type Capability = { echo(input: unknown): Promise<unknown> };",
});
await project.workerTool.echo({ ok: true });

await project.provideCapability({
  path: ["mySpecialStream"],
  type: "itx-expression",
  expression: ["streams", ["get", "/my/special/stream"]],
});
await project.mySpecialStream.append(event);

await project.provideCapability({
  path: ["someMethod"],
  type: "itx-expression",
  expression: ["some", "deeper", "path", "someMethod"],
});
await project.someMethod("ok");
```

## Difficulties

- Receiver preservation matters for aliases to methods. The expression evaluator
  carries the receiver for final getter steps so local replay can behave like
  `project.some.method(...)`, not like a detached function. The e2e suite avoids
  relying on `this` inside remote plain-object function stubs, because those
  functions have already crossed an RPC boundary.
- Metadata discovery on arbitrary RPC targets is not reliable with dynamic
  fallback proxies: asking for a missing metadata method can itself become a
  remote dynamic call. This PR avoids that ambiguity by making metadata an
  event field only.
- Function own-properties are not part of the capability contract. A bare
  function can be mounted as a live value or expression result, but its
  `instructions`/`types` must still be supplied to `provideCapability(...)`.

## Documented Edge Cases

- Stateful worker expressions that return nested RPC objects are still the sharp
  edge. The safe rule is to keep the final replay inside
  `StatefulWorkerDurableObject`. This PR does not add a special stateful
  expression runner; it keeps the simpler behavior and documents the caveat.
- The old flattened `dynamic-worker` mount branch is gone. Worker expressions
  dispatch normal RPC member paths through `workers.get(ref)`. A durable mount
  that wants flattened-path behavior must set `flattenNestedPaths: true` on
  `provideCapability(...)`.
- Durable expression arguments should stay durable/serializable. Passing live
  RPC stubs as expression arguments is not a restartable recipe.
- Expression provision can now succeed even when the expression would fail at
  invocation time, because provision no longer connects to or validates the
  target. That is intentional: append is the durable recipe commit point, not a
  health check.
- Stream cross-post e2e waits now replay from offset `0`. On deployed Workers
  the cross-post can commit before the live `waitForEvent()` subscription is
  fully open, while Miniflare often schedules the other way around. Replaying
  matches the test's intent: assert the copied event exists with source
  provenance, not prove a no-replay live subscription timing edge.

## Verification

- `pnpm --dir apps/minimal-itx-v4 typecheck`
- `pnpm --dir apps/minimal-itx-v4 exec vitest run itx-expression-capabilities.e2e.test.ts --reporter=dot`
- `pnpm --dir apps/minimal-itx-v4 verify:miniflare`
- `ITX_BASE=https://minimal-itx-v4.iterate-dev-preview.workers.dev pnpm --dir apps/minimal-itx-v4 verify:deployed`
