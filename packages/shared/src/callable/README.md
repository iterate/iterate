# Callable

`Callable` is a small JSON invocation shape for Cloudflare Workers code. It
lets us store or transmit "call this thing" without storing live capabilities
such as Worker service bindings, Durable Object stubs, Worker Loader bindings,
`ctx.exports` loopback bindings, or public `fetch`.

The main API is `dispatchCallable({ callable, payload, ctx })`. In normal
product code, callers should not need to know whether a callable is backed by a
remote URL, `env.SERVICE.fetch()`, Workers RPC, a Durable Object stub, a Dynamic
Worker, or a loopback binding.

```ts
import { dispatchCallable } from "@iterate-com/shared/callable/runtime.ts";

const result = await dispatchCallable({
  callable,
  payload: { userId: "usr_123" },
  ctx: { env, exports: ctx.exports, fetch },
});
```

Use `dispatchCallableFetch({ callable, request, ctx })` only when the caller
needs the raw Fetch API surface: streaming request bodies, streaming responses,
SSE, or WebSocket upgrade responses.

```ts
import { dispatchCallableFetch } from "@iterate-com/shared/callable/runtime.ts";

const response = await dispatchCallableFetch({ callable, request, ctx });
```

Only the runtime and type modules are exported from the package:

```ts
import { dispatchCallable } from "@iterate-com/shared/callable/runtime.ts";
import type { Callable } from "@iterate-com/shared/callable/types.ts";
```

## Schema

The schema marker is optional; omitted schema is interpreted as v1:

```ts
schema?: "https://schemas.iterate.com/callable/v1";
```

Add it when a persisted record needs to be self-describing. Omit it for ordinary
in-repo callsites. `validateCallable()` accepts both the explicit marker and
the omitted form; it does not write the default marker back into the object.

## Mental Model

A callable has two parts:

- `target`: where the authority comes from.
- `call`: what to do with the resolved target.

There are three target families:

```ts
type CallableTarget =
  | { type: "url"; url: string }
  | { type: "env-binding"; bindingType: string; bindingName: string }
  | { type: "loopback-binding"; bindingType: string; exportName: string };
```

This tracks Cloudflare terminology directly:

- Cloudflare calls `env` values "bindings", and describes a binding as "a
  permission and an API in one piece":
  https://developers.cloudflare.com/workers/runtime-apis/bindings/
- Cloudflare calls `ctx.exports` values "loopback bindings":
  https://developers.cloudflare.com/workers/runtime-apis/context/#exports
- Service bindings expose both `fetch()` and Workers RPC:
  https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/
- Durable Object namespace bindings resolve Durable Object stubs by name or ID:
  https://developers.cloudflare.com/durable-objects/api/namespace/
- Worker Loader bindings load Dynamic Workers:
  https://developers.cloudflare.com/dynamic-workers/api-reference/

Omitted `call` means `{ type: "fetch" }` for fetch-capable targets. RPC always
needs an explicit `call` because the RPC method is part of the serialized
invocation.

## Target Examples

Fetch a public URL. `ctx.fetch` is required because public egress is a
capability, not something this shared helper reads from `globalThis`.

```ts
const callable = {
  target: { type: "url", url: "https://api.example.com/tools?fixed=true" },
};

await dispatchCallable({
  callable,
  payload: { title: "Bug" },
  ctx: { fetch },
});
```

Fetch a configured service binding. This maps to `env.USERS.fetch(request)`.

```ts
const callable = {
  target: {
    type: "env-binding",
    bindingType: "service",
    bindingName: "USERS",
  },
};
```

Call Workers RPC on a configured service binding. This maps to
`env.TOOLS.callTool(payload)`.

```ts
const callable = {
  target: {
    type: "env-binding",
    bindingType: "service",
    bindingName: "TOOLS",
  },
  call: { type: "rpc", method: "callTool" },
};
```

Call a Durable Object by stable name. This resolves
`env.TOOL_REGISTRY.getByName("global")` when the runtime exposes
`getByName()`, otherwise it falls back to `idFromName()` plus `get()`.

```ts
const callable = {
  target: {
    type: "env-binding",
    bindingType: "durable-object-namespace",
    bindingName: "TOOL_REGISTRY",
    durableObject: { name: "global" },
  },
  call: { type: "rpc", method: "listTools" },
};
```

Call a Durable Object by a previously persisted Durable Object ID string. There
is no `newUniqueId` callable selector; allocation belongs in provisioning code.

```ts
const callable = {
  target: {
    type: "env-binding",
    bindingType: "durable-object-namespace",
    bindingName: "TOOL_REGISTRY",
    durableObject: { id: "<durable-object-id-string>" },
  },
  call: { type: "fetch" },
};
```

Load a Dynamic Worker through a Worker Loader binding. The target resolves the
loader first, then treats the selected Dynamic Worker entrypoint like the same
fetch/RPC target shape used by service bindings and Durable Object stubs.

```ts
const callable = {
  target: {
    type: "env-binding",
    bindingType: "dynamic-worker-loader",
    bindingName: "LOADER",
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

Select a named Dynamic Worker entrypoint and pass `ctx.props` to it.

```ts
const callable = {
  target: {
    type: "env-binding",
    bindingType: "dynamic-worker-loader",
    bindingName: "LOADER",
    workerCode,
    entrypoint: {
      name: "Agent",
      props: { tenantId: "tenant_123" },
    },
  },
  call: { type: "rpc", method: "run" },
};
```

Use Worker Loader `get(id, callback)` instead of `load(code)` when the ID names
this exact code version. Omit `load` for `load(code)`.

```ts
const callable = {
  target: {
    type: "env-binding",
    bindingType: "dynamic-worker-loader",
    bindingName: "LOADER",
    workerCode,
    load: { type: "get", id: "sha256:..." },
  },
};
```

Use a loopback service binding from `ctx.exports`. This is how a Worker can call
one of its own top-level `WorkerEntrypoint` exports, optionally with dynamic
props. Cloudflare documents this as a capability that regular env service
bindings do not have.

```ts
const callable = {
  target: {
    type: "loopback-binding",
    bindingType: "service",
    exportName: "Streams",
    props: { tenantId: "tenant_123" },
  },
  call: { type: "rpc", method: "write" },
};

await dispatchCallable({
  callable,
  payload: { stream: "events", value: { ok: true } },
  ctx: { exports: ctx.exports },
});
```

The default export is also just an export name when the runtime exposes it as a
loopback service binding:

```ts
const callable = {
  target: {
    type: "loopback-binding",
    bindingType: "service",
    exportName: "default",
  },
};
```

Loopback Durable Object namespace bindings are part of the schema because the
Cloudflare docs say `ctx.exports` includes Durable Object namespace bindings for
migrated Durable Object exports. The current Workers Vitest fixture does not
expose that namespace shape for this package's test DO, so the runtime branch is
implemented and documented but not treated as the primary tested path yet.

```ts
const callable = {
  target: {
    type: "loopback-binding",
    bindingType: "durable-object-namespace",
    exportName: "TenantObject",
    durableObject: { name: "tenant_123" },
  },
  call: { type: "rpc", method: "run" },
};
```

## Value Dispatch

`dispatchCallable()` turns fetch callables into ordinary value calls by building
a request, dispatching it, rejecting non-2xx responses, and parsing the body.
The default request template is deliberately boring:

- `POST`
- `content-type: application/json`
- body is `JSON.stringify(payload ?? null)`

If `call.request` is present, it is a partial override. Adding headers or query
parameters does not drop the default JSON body. `GET` and `HEAD` value calls do
not send a body.

If the response has a JSON content type, the result is parsed JSON. Otherwise,
it is returned as text. Non-2xx responses throw `CallableError` with code
`REMOTE_ERROR`, and `error.details.body` contains the response body.

Use `call.passthroughArgs` to pre-populate descriptor-owned fields into the
value payload. It behaves like shallow default object fields: runtime payload
fields override descriptor fields, and nested objects are replaced rather than
merged.

```ts
const callable = {
  target: { type: "url", url: "https://api.example.com/tools" },
  call: {
    type: "fetch",
    passthroughArgs: { provider: "github", dryRun: true },
  },
};

await dispatchCallable({
  callable,
  payload: { name: "createIssue", dryRun: false },
  ctx: { fetch },
});

// POST body:
// {"provider":"github","dryRun":false,"name":"createIssue"}
```

`passthroughArgs` also works for RPC object mode:

```ts
await dispatchCallable({
  callable: {
    target: {
      type: "env-binding",
      bindingType: "service",
      bindingName: "TOOLS",
    },
    call: {
      type: "rpc",
      method: "callTool",
      passthroughArgs: { provider: "github" },
    },
  },
  payload: { name: "createIssue", args: { title: "Bug" } },
  ctx: { env },
});
```

It is not available for `argsMode: "positional"`, and it is not applied by
`dispatchCallableFetch()`. The lower-level fetch API receives a complete
`Request`, so there is no JSON payload assembly step where args can be merged.

## RPC

RPC results are returned raw. Workers RPC can return structured-clone values,
functions, streams, `Request`, `Response`, `RpcTarget` instances, and objects
containing RPC stubs. `dispatchCallable()` does not clone, serialize, or
auto-dispose RPC results because that would destroy the Cap'n Web
object-capability behavior this abstraction is meant to preserve.

`argsMode` defaults to `object`, so the payload is passed as one argument:

```ts
await dispatchCallable({
  callable: {
    target: { type: "env-binding", bindingType: "service", bindingName: "TOOLS" },
    call: { type: "rpc", method: "callTool" },
  },
  payload: { name: "createIssue", args: { title: "Bug" } },
  ctx: { env },
});
```

Use `argsMode: "positional"` when the payload is an array and should be spread:

```ts
await dispatchCallable({
  callable: {
    target: { type: "env-binding", bindingType: "service", bindingName: "MATH" },
    call: { type: "rpc", method: "add", argsMode: "positional" },
  },
  payload: [1, 2],
  ctx: { env },
});
```

`call.method` must be one direct JavaScript identifier, not a dotted path. Names
such as `fetch`, `connect`, `call`, `alarm`, `then`, `constructor`, `prototype`,
and `__proto__` are rejected because they collide with Fetch semantics,
Promise-like behavior, JavaScript prototype behavior, or Cloudflare RPC
reserved names.

Cloudflare RPC docs:

- https://developers.cloudflare.com/workers/runtime-apis/rpc/
- https://developers.cloudflare.com/workers/runtime-apis/rpc/reserved-methods/
- https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
- https://blog.cloudflare.com/javascript-native-rpc/

## Fetch Dispatch

`dispatchCallableFetch()` is the streaming-preserving path. It never reads the
incoming request body and returns the raw `Response`.

```ts
const response = await dispatchCallableFetch({
  callable: {
    target: {
      type: "env-binding",
      bindingType: "durable-object-namespace",
      bindingName: "ROOMS",
      durableObject: { name: "room-1" },
    },
    call: { type: "fetch", path: { base: "/events" } },
  },
  request,
  ctx: { env },
});
```

This is also the API used by `connectCallableWebSocket()`: WebSocket is fetch
with upgrade headers, not a separate callable kind.

`connectCallableWebSocket()` accepts:

- `url`: path or absolute URL for the upgrade request; omitted means `/`.
  `ws:` and `wss:` are converted to `http:` and `https:` because the helper uses
  fetch-with-upgrade under the hood.
- `protocols`: written as `Sec-WebSocket-Protocol`.
- `headers`: additional upgrade request headers.
- `binaryType` and `accept`: applied before the returned Worker WebSocket is
  accepted.

Cloudflare WebSocket docs:

- https://developers.cloudflare.com/workers/examples/websockets/
- https://developers.cloudflare.com/workers/runtime-apis/response/#websocket

## Fetch Paths

Public URL targets use `url`, and the URL may include a query string:

```ts
{ target: { type: "url", url: "https://api.example.com/v1?fixed=true" } }
```

Env and loopback binding targets do not have public URLs. The resolved binding
or stub is the authority, and the URL visible to the callee's `fetch(request)`
handler is synthetic and chosen by this runtime:

```ts
{
  target: {
    type: "env-binding",
    bindingType: "service",
    bindingName: "USERS"
  }
}
```

Fetch path options live under `call.path` because they are part of building a
`Request`, not part of target identity:

```ts
// Default call: omitted means { type: "fetch" }
{
  target: { type: "url", url: "https://api.example.com/v1" }
}
// Incoming /users?active=true
// Outbound https://api.example.com/v1/users?active=true
```

```ts
// Replace
{
  target: { type: "url", url: "https://api.example.com/status" },
  call: { type: "fetch", path: { mode: "replace" } }
}
// Incoming /users?active=true
// Outbound https://api.example.com/status?active=true
```

```ts
// Service binding with a synthetic path base
{
  target: {
    type: "env-binding",
    bindingType: "service",
    bindingName: "USERS"
  },
  call: { type: "fetch", path: { base: "/internal", mode: "prefix" } }
}
// Incoming /users?active=true
// Callee sees https://service.local/internal/users?active=true
```

In `prefix` mode, non-root incoming paths are joined with exactly one separator.
A root incoming path preserves the target or base path exactly, including a
trailing slash: `https://api.example.com/v1/` plus incoming `/` stays
`https://api.example.com/v1/`.

Query handling is deliberately simple in v1: there is no merge. In proxy mode,
the incoming request query is used. In value mode, `dispatchCallable()` creates
that incoming request; if `call.request.query` is omitted, a URL target's query
is preserved, and if `call.request.query` is present, it replaces the target
query wholesale. Use `query: {}` to clear the target query.

Advanced rewrite behavior is future work. The task notes track the prior art we
discussed: Caddy `reverse_proxy` plus `rewrite`/`uri`, Envoy `prefix_rewrite`,
and NGINX `proxy_pass` URI behavior.

## Dynamic Workers

V1 supports a strict subset of Cloudflare `WorkerCode`:

- `workerCode.compatibilityDate` is required.
- `workerCode.compatibilityFlags` is an optional string array.
- `workerCode.mainModule` must exist in `workerCode.modules`.
- every module name must end in `.js`.
- module bodies are strings.

Named entrypoints and entrypoint props are supported:

```ts
const callable = {
  target: {
    type: "env-binding",
    bindingType: "dynamic-worker-loader",
    bindingName: "LOADER",
    workerCode,
    entrypoint: {
      name: "Agent",
      props: { tenantId: "tenant_123" },
    },
  },
  call: { type: "rpc", method: "run" },
};
```

V1 does not support typed module objects, Python, `allowExperimental`,
Dynamic Worker `env`, `globalOutbound`, tails, source refs, or Durable Object
facets. Those are real Cloudflare features, but they require a policy story and
are parked in `tasks/`.

V1 does not set `WorkerCode.globalOutbound`, so Dynamic Workers get
Cloudflare's default outbound behavior. Do not dispatch tenant-authored,
user-authored, LLM-authored, or otherwise untrusted Dynamic Worker callables
until code provenance, source-size limits, and outbound policy land.

Dynamic Worker docs:

- https://developers.cloudflare.com/dynamic-workers/api-reference/
- https://developers.cloudflare.com/dynamic-workers/usage/bindings/
- https://blog.cloudflare.com/dynamic-workers/

## Security

Treat Callables like untrusted code. If you pass a full Worker `env` to a
Callable, you are allowing the JSON to choose any `env-binding.bindingName` it
contains. For Durable Object namespace bindings, it can also choose any stable
name or ID inside that namespace.

V1 keeps that resolver simple so the kernel stays small. Do not pass
tenant-authored, LLM-authored, or user-authored callables a sensitive `env`,
`ctx.exports`, or `fetch` capability until `tasks/capability-policy.md` is
implemented.

This warning is the same object-capability boundary Cloudflare describes for
Workers RPC: holding a binding or stub is authority. A Callable is not itself a
safe capability; it is JSON asking this runtime to resolve one.

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
