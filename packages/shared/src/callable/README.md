# Callable

`Callable` is a small JSON shape for saying "invoke this thing" in Cloudflare
Workers code without serializing live capabilities. The JSON can live in a
database, queue message, config file, tool-provider record, or stream
subscription. The live authority still comes from the caller's context: `env`
bindings, `ctx.exports` loopback bindings, public `fetch`, Durable Object
namespaces, or a Worker Loader binding.

The main API is:

```ts
import { dispatchCallable } from "@iterate-com/shared/callable/runtime.ts";

const value = await dispatchCallable({
  callable,
  payload: { userId: "usr_123" },
  ctx: { env, exports: ctx.exports, fetch },
});
```

In normal product code, callers should not need to know whether dispatch uses
Fetch or Workers RPC, or whether the live capability comes from a public URL,
service binding, Durable Object namespace/stub, Worker Loader / Dynamic Worker
entrypoint, or `ctx.exports` loopback binding. Use `dispatchCallableFetch(...)`
only when the caller needs the raw Fetch API surface: streaming request bodies,
streaming responses, SSE, or WebSocket upgrade responses.

Only the runtime and type modules are exported:

```ts
import { dispatchCallable } from "@iterate-com/shared/callable/runtime.ts";
import type { Callable } from "@iterate-com/shared/callable/types.ts";
```

## Shape

The schema marker is optional; omitted schema means v1:

```ts
schema?: "https://schemas.iterate.com/callable/v1";
```

A callable is operation-rooted:

```ts
type Callable =
  | {
      schema?: "https://schemas.iterate.com/callable/v1";
      type: "fetch";
      via: FetchVia;
      transformInput?: TransformInput;
      fetchRequest?: FetchRequest;
    }
  | {
      schema?: "https://schemas.iterate.com/callable/v1";
      type: "workers-rpc";
      via: WorkersRpcVia;
      rpcMethod: string;
      argsMode?: "object" | "positional";
      transformInput?: TransformInput;
    };
```

`type` names the invocation surface. `via` names how the live capability is
resolved. This is constrained composition, not full orthogonality: URL callables
can only be `fetch`; service bindings, Durable Object stubs, Dynamic Worker
entrypoints, and loopback bindings can expose Fetch and/or Workers RPC depending
on the platform object that resolves at runtime.

Cloudflare terminology references:

- Bindings: https://developers.cloudflare.com/workers/runtime-apis/bindings/
- Service bindings: https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/
- `ctx.exports` loopback bindings: https://developers.cloudflare.com/workers/runtime-apis/context/#exports
- Durable Object namespaces: https://developers.cloudflare.com/durable-objects/api/namespace/
- Worker Loader / Dynamic Workers: https://developers.cloudflare.com/dynamic-workers/api-reference/
- Workers RPC: https://developers.cloudflare.com/workers/runtime-apis/rpc/

## Payload To Input

The value-dispatch pipeline has three names:

1. `payload` is the value passed to `dispatchCallable({ payload })`.
2. `input` is the value after optional `transformInput` runs.
3. The callable type decides how to use `input`.

For Workers RPC, `input` is passed as the single RPC argument by default. For
Fetch, `input` is used to build a `Request`: by default `POST` with JSON body,
or with `fetchRequest` overrides for method, headers, query, path, and JSONata
body construction.

```ts
const callable = {
  type: "workers-rpc",
  via: { type: "env-binding", bindingType: "service", bindingName: "TOOLS" },
  rpcMethod: "callTool",
  transformInput: {
    shallowMerge: { provider: "github" },
    jsonata: '{ "provider": provider, "tool": name, "args": args }',
  },
};
```

`transformInput.shallowMerge` means the runtime payload is merged into the fixed
object:

```ts
input = { ...shallowMerge, ...payload };
```

If both `shallowMerge` and `jsonata` are present, shallow merge runs first and
JSONata receives the merged value as its root (`$`). Host-owned context is
available to JSONata as `$ambient` via `ctx.ambient`.

## Fetch

Public URL fetch. `ctx.fetch` is required because public egress is a capability,
not something this helper reads from `globalThis`.

```ts
const callable = {
  type: "fetch",
  via: { type: "url", url: "https://api.example.com/tools?fixed=true" },
};

await dispatchCallable({
  callable,
  payload: { title: "Bug" },
  ctx: { fetch },
});
```

Service binding fetch. This resolves `ctx.env.USERS` and calls
`env.USERS.fetch(request)`.

```ts
const callable = {
  type: "fetch",
  via: {
    type: "env-binding",
    bindingType: "service",
    bindingName: "USERS",
  },
};
```

Durable Object fetch by stable name:

```ts
const callable = {
  type: "fetch",
  via: {
    type: "env-binding",
    bindingType: "durable-object-namespace",
    bindingName: "ROOMS",
    durableObject: { name: "room-1" },
  },
  fetchRequest: { path: { base: "/events" } },
};
```

`dispatchCallable()` turns a fetch callable into a value call by creating a
synthetic Request and then delegating to `dispatchCallableFetch()`. The default
value-mode Request is deliberately boring:

- `POST`
- `content-type: application/json`
- body is `JSON.stringify(input ?? null)`

`fetchRequest` configures the Fetch API `Request`. In value mode, method,
headers, query, and JSONata body construction are part of building the
synthetic Request from `input`; path handling runs when that Request is
dispatched. In raw fetch mode, the caller already supplies a complete
`Request`, so the runtime ignores `transformInput`, rejects `fetchRequest.body`,
and applies only request-to-request fields without reading the body.

```ts
const callable = {
  type: "fetch",
  via: { type: "url", url: "https://api.example.com/tools?fixed=true" },
  fetchRequest: {
    method: "POST",
    headers: { "x-tool": "create-issue" },
    query: { dryRun: true },
    body: { jsonata: '{ "title": title, "tenant": $ambient.tenantId }' },
  },
};
```

Path handling is simple:

```ts
{
  type: "fetch",
  via: { type: "url", url: "https://api.example.com/v1" }
}
// incoming /users?active=true
// outbound https://api.example.com/v1/users?active=true
```

```ts
{
  type: "fetch",
  via: { type: "url", url: "https://api.example.com/status" },
  fetchRequest: { path: { mode: "replace" } }
}
// incoming /users?active=true
// outbound https://api.example.com/status?active=true
```

```ts
{
  type: "fetch",
  via: {
    type: "env-binding",
    bindingType: "service",
    bindingName: "USERS"
  },
  fetchRequest: { path: { base: "/internal", mode: "prefix" } }
}
// incoming /users?active=true
// callee sees https://service.local/internal/users?active=true
```

In `prefix` mode, non-root incoming paths are joined with exactly one separator.
A root incoming path preserves the base path exactly, including a trailing
slash.

Query handling is also simple in v1. In raw fetch mode, the incoming Request
query is used unless `fetchRequest.query` is present. In value mode, the query
in `via.url` is preserved unless `fetchRequest.query` is present. Use
`query: {}` to clear it.

## Workers RPC

Workers RPC callables use Cloudflare Workers RPC / Cap'n Web semantics. The
method name is baked into the serialized callable as `rpcMethod`.

```ts
const callable = {
  type: "workers-rpc",
  via: {
    type: "env-binding",
    bindingType: "service",
    bindingName: "TOOLS",
  },
  rpcMethod: "callTool",
};

await dispatchCallable({
  callable,
  payload: { name: "createIssue", args: { title: "Bug" } },
  ctx: { env },
});
```

Durable Object RPC by stable name:

```ts
const callable = {
  type: "workers-rpc",
  via: {
    type: "env-binding",
    bindingType: "durable-object-namespace",
    bindingName: "TOOL_REGISTRY",
    durableObject: { name: "global" },
  },
  rpcMethod: "listTools",
};
```

Durable Object RPC by previously persisted Durable Object ID:

```ts
const callable = {
  type: "workers-rpc",
  via: {
    type: "env-binding",
    bindingType: "durable-object-namespace",
    bindingName: "TOOL_REGISTRY",
    durableObject: { id: "<durable-object-id-string>" },
  },
  rpcMethod: "listTools",
};
```

There is no `newUniqueId` selector. Allocation belongs in provisioning code
that persists the generated ID before creating a callable.

`argsMode` defaults to `object`, so `input` is passed as one argument. Use
`argsMode: "positional"` when `input` is an array and should be spread.

```ts
const callable = {
  type: "workers-rpc",
  via: { type: "env-binding", bindingType: "service", bindingName: "MATH" },
  rpcMethod: "add",
  argsMode: "positional",
};
```

`rpcMethod` must be one direct JavaScript identifier, not a dotted path.
Cloudflare-reserved names such as `fetch`, `connect`, `alarm`, and
`constructor` are rejected. Callable also rejects local JavaScript footguns such
as `then`, `call`, `prototype`, and `__proto__` so a serialized RPC method name
cannot accidentally become Promise-like, walk prototypes, or invoke reflective
function behavior.

RPC results are returned raw. `dispatchCallable()` does not clone, serialize, or
auto-dispose RPC results because that would destroy the Cap'n Web
object-capability behavior this abstraction is meant to preserve.

## Dynamic Workers

Dynamic Worker callables resolve a Worker Loader binding, load inline
`workerCode`, select an entrypoint, then invoke that entrypoint with the same
Fetch or Workers RPC paths as service bindings.

```ts
const callable = {
  type: "fetch",
  via: {
    type: "env-binding",
    bindingType: "dynamic-worker",
    // Optional; omitted means "LOADER".
    workerLoaderBindingName: "LOADER",
    workerCode: {
      compatibilityDate: "2026-04-27",
      mainModule: "worker.js",
      modules: {
        "worker.js": "export default { fetch() { return Response.json({ ok: true }) } }",
      },
    },
  },
};
```

Named entrypoint RPC with props:

```ts
const callable = {
  type: "workers-rpc",
  via: {
    type: "env-binding",
    bindingType: "dynamic-worker",
    workerCode,
    entrypoint: {
      name: "Agent",
      props: { tenantId: "tenant_123" },
    },
  },
  rpcMethod: "run",
};
```

Use Worker Loader `get(id, callback)` when the ID names this exact code version.
Omit `loader` for `load(workerCode)`.

```ts
const callable = {
  type: "fetch",
  via: {
    type: "env-binding",
    bindingType: "dynamic-worker",
    workerCode,
    loader: { type: "get", id: "sha256:..." },
  },
};
```

V1 supports a strict subset of Cloudflare `WorkerCode`:

- `compatibilityDate` is required
- `compatibilityFlags` is optional
- `mainModule` must exist in `modules`
- module names must end in `.js`
- module bodies are strings

V1 does not support typed module objects, Python, Dynamic Worker `env`,
`globalOutbound`, tails, source refs, or Durable Object facets. Those are real
Cloudflare features, but they require a policy story and are parked in `tasks/`.
V1 does not set `WorkerCode.globalOutbound`, so Dynamic Workers get
Cloudflare's default outbound behavior. Do not dispatch tenant-authored,
user-authored, LLM-authored, or otherwise untrusted Dynamic Worker callables
until code provenance, source-size limits, and outbound policy land.

## Loopback Bindings

Loopback bindings resolve from `ctx.exports`, not `env`. Cloudflare requires
the `enable_ctx_exports` compatibility flag for this API, and exposes the same
loopback binding idea from Durable Object state as `this.ctx.exports`.

```ts
const callable = {
  type: "workers-rpc",
  via: {
    type: "loopback-binding",
    bindingType: "service",
    exportName: "Streams",
    props: { tenantId: "tenant_123" },
  },
  rpcMethod: "write",
};
```

The default export is just another export name when the runtime exposes it as a
loopback service binding:

```ts
const callable = {
  type: "fetch",
  via: {
    type: "loopback-binding",
    bindingType: "service",
    exportName: "default",
  },
};
```

Loopback Durable Object namespace bindings are in the schema because Cloudflare
documents `ctx.exports` as including Durable Object namespace bindings for
migrated Durable Object exports. Workers Vitest does not expose that namespace
shape for this package's fixture DO, so the branch is implemented but not the
primary tested path yet.

## WebSockets

`connectCallableWebSocket()` is a small helper over `dispatchCallableFetch()`.
WebSocket is Fetch with upgrade headers, not a separate callable kind.

```ts
const ws = await connectCallableWebSocket({
  callable: {
    type: "fetch",
    via: {
      type: "env-binding",
      bindingType: "durable-object-namespace",
      bindingName: "ROOMS",
      durableObject: { name: "room-1" },
    },
    fetchRequest: { path: { base: "/socket", mode: "replace" } },
  },
  ctx: { env },
});
```

Supported options are `url`, `protocols`, `headers`, `binaryType`, and
`accept`. The helper constructs the upgrade `Request`, validates the 101
response, accepts `response.webSocket`, and returns it.

Cloudflare WebSocket docs:

- https://developers.cloudflare.com/workers/examples/websockets/
- https://developers.cloudflare.com/workers/runtime-apis/response/#websocket

## Security

Treat Callables like untrusted code. If you pass a full Worker `env` to a
Callable, you are allowing the JSON to choose any allowed `env-binding`
`bindingName` or Dynamic Worker `workerLoaderBindingName` present in that env.
If you pass `ctx.exports`, the JSON can name loopback exports. If you pass
`fetch`, URL callables can make public egress requests.

V1 keeps the resolver simple so the kernel stays small. Do not pass
tenant-authored, LLM-authored, or user-authored callables a sensitive `env`,
`ctx.exports`, or `fetch` capability until `tasks/capability-policy.md` is
implemented. A Callable is not itself a safe capability; it is JSON asking this
runtime to resolve one.

Security references:

- https://developers.cloudflare.com/workers/runtime-apis/rpc/visibility/#security-model
- https://blog.cloudflare.com/javascript-native-rpc/
- https://github.com/cloudflare/capnweb

## Tests

Run:

```bash
pnpm --dir packages/shared test:callable
```

The config lives in this folder on purpose:

- `vitest.config.ts`
- `wrangler.vitest.jsonc`
- `entry.workerd.vitest.ts`
- `service.workerd.vitest.js`
- `runtime.test.ts`

The test harness uses Cloudflare's Workers Vitest pool and an auxiliary Worker
fixture so service binding fetch and service binding RPC are both exercised
against real Workers runtime objects:

https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/

## Future Work

Each broad feature has a task file in `tasks/`. Do not quietly grow v1; add the
next slice with tests and an updated README section when a task becomes real.
