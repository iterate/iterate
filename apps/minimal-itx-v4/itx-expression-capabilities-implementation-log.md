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

## Decisions

- Removed separate durable `dynamic-worker`, `mcp`, and `openapi` capability
  record types. Durable built-ins now mount through `itx-expression` only, for
  example `["workers", ["get", ref]]` or `["mcp", ["connect", input]]`.
- Added `__describe()` to MCP/OpenAPI connected targets. This is a reserved
  built-in convention for derived `{ instructions, types }`; generic expression
  targets are not required to implement it.
- Reserved `__describe` in dynamic path fallback so missing metadata methods do
  not accidentally become dynamic tool calls.
- Passed a `ProjectRpcTarget` into `ItxProcessor` as a dependency. The
  processor does not reach for `env.ITX`.
- Expression evaluation uses the current ITX host path for dynamic fallback
  routing. Built-ins such as `streams` and `workers` remain project-scoped, but
  expression aliases to other mounted capabilities resolve against the same
  project/agent capability host that owns the durable record.
- Snapshot expression metadata at provide time when available. Invocation still
  replays the expression every time, so durable records do not persist live RPC
  stubs or connected targets.
- Live `provideCapability` accepts `capability` and `flattenNestedPaths`.
  Expression results are where an own `capability` field is treated as a
  provider package.
- Added a tiny `/__itx_e2e/*` fixture surface to the minimal worker so deployed
  e2e can verify OpenAPI/MCP/egress behavior without asking Cloudflare to fetch
  a local `127.0.0.1` test server. The deployed OpenAPI and MCP fixtures enforce
  the expected Authorization header, so the test still proves project egress
  secret substitution.

## Implemented Call Shapes

```ts
await project.mcp.connect(input).__describe();
await project.mcp.connect(input).search_docs({ query: "Workers" });

await project.openapi.connect(input).__describe();
await project.openapi.connect(input).findPetsByStatus({ status: "available" });

await project.provideCapability({
  path: ["pets"],
  type: "itx-expression",
  expression: ["openapi", ["connect", input]],
});
await project.pets.findPetsByStatus({ status: "available" });

await project.provideCapability({
  path: ["workerTool"],
  type: "itx-expression",
  expression: ["workers", ["get", ref]],
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
- `__describe()` cannot be probed on arbitrary targets. A fallback proxy could
  turn a missing method into a real dynamic capability call. Automatic metadata
  extraction is therefore limited to known MCP/OpenAPI connect expressions.
- Live function metadata through function own-properties is possible in Workers
  RPC, but this implementation does not rely on it. Provider packages are more
  explicit and less surprising.

## Documented Edge Cases

- Stateful worker expressions that return nested packages are still the sharp
  edge. The safe rule is to keep the final replay inside
  `StatefulWorkerDurableObject`. This PR does not add a special stateful
  expression runner; it keeps the simpler behavior and documents the caveat.
- The old flattened `dynamic-worker` mount branch is gone. Worker expressions
  dispatch normal RPC member paths through `workers.get(ref)`. A worker that
  wants flattened-path behavior should return an explicit provider package with
  `{ capability, flattenNestedPaths: true }`.
- Durable expression arguments should stay durable/serializable. Passing live
  RPC stubs as expression arguments is not a restartable recipe.
- `__describe` is reserved. A remote MCP tool or OpenAPI operation with that
  exact name needs a flattened/escaped call path rather than dot syntax.
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
