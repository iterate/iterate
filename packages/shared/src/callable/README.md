# Callable

`Callable` is a small JSON invocation shape for Workers code. It lets a caller
store or transmit "call this thing" without storing the live Worker binding,
Durable Object stub, or public `fetch` function.

The main API is `dispatchCallable({ callable, payload, ctx })`. In the general
case, callers should not need to know whether the callable is backed by public
HTTP, a service binding `fetch()`, Durable Object `fetch()`, service RPC, or
Durable Object RPC.

```ts
const result = await dispatchCallable({
  callable,
  payload: { userId: "usr_123" },
  ctx: { env },
});
```

Use `dispatchCallableFetch({ callable, request, ctx })` only when you need the
raw Fetch API surface: streaming request bodies, streaming responses, SSE, or
WebSocket upgrade responses.

## Shape

The schema marker is optional and defaults to v1:

```ts
schema?: "https://schemas.iterate.com/callable/v1";
```

Add it when a persisted record needs to be self-describing. Omit it for normal
in-repo callsites. There is no `schemaVersion` compatibility layer in this
prototype.

Fetch callable:

```ts
const callable = {
  kind: "fetch",
  target: {
    type: "service",
    binding: { $binding: "USERS" },
    pathPrefix: "/internal",
  },
};
```

RPC callable:

```ts
const callable = {
  kind: "rpc",
  target: {
    type: "durable-object",
    binding: { $binding: "USER_REGISTRY" },
    address: { type: "name", name: "global" },
  },
  rpcMethod: "findUser",
};
```

`rpcMethod` is baked into the JSON. It must be one direct JavaScript identifier,
not a dotted path. Names such as `fetch`, `then`, `constructor`, `prototype`,
and `__proto__` are rejected because they collide with Fetch semantics,
Promise-like behavior, JavaScript prototype behavior, or Cloudflare RPC
reserved names.

## Dispatching Values

`dispatchCallable()` turns fetch callables into ordinary value calls by building
a request, dispatching it, rejecting non-2xx responses, and parsing the body.
The default request template is:

- `POST`
- `content-type: application/json`
- body is `JSON.stringify(payload ?? null)`

```ts
const callable = {
  kind: "fetch",
  target: { type: "http", url: "https://api.example.com/tools" },
};

const result = await dispatchCallable({
  callable,
  payload: { title: "Bug" },
  ctx: { fetcher: fetch },
});
```

If the response has a JSON content type, the result is parsed JSON. Otherwise it
is returned as text. Non-2xx responses throw `CallableError` with code
`REMOTE_ERROR`, and the error details include the response status and body.

RPC callables dispatch to a service binding or Durable Object stub and call the
named method. `argsMode` defaults to `object`, so the payload is passed as one
argument:

```ts
await dispatchCallable({
  callable: {
    kind: "rpc",
    target: { type: "service", binding: { $binding: "TOOLS" } },
    rpcMethod: "callTool",
  },
  payload: { name: "createIssue", args: { title: "Bug" } },
  ctx: { env },
});
```

Use `argsMode: "positional"` when the payload is an array and should be spread:

```ts
await dispatchCallable({
  callable: {
    kind: "rpc",
    target: { type: "service", binding: { $binding: "MATH" } },
    rpcMethod: "add",
    argsMode: "positional",
  },
  payload: [1, 2],
  ctx: { env },
});
```

Cloudflare RPC stubs appear to expose every possible method name. That means
this library can sanitize the method string, but it cannot prove a real remote
method exists before calling it. Missing remote methods surface as remote RPC
errors from the platform.

## Dispatching Fetch

`dispatchCallableFetch()` is the streaming-preserving path. It never reads the
incoming request body and returns the raw `Response`.

```ts
const response = await dispatchCallableFetch({
  callable: {
    kind: "fetch",
    target: {
      type: "durable-object",
      binding: { $binding: "ROOMS" },
      address: { type: "name", name: "room-1" },
      pathPrefix: "/events",
    },
  },
  request,
  ctx: { env },
});
```

This is also the API used by `connectCallableWebSocket()`: WebSocket is fetch
with upgrade headers, not a separate callable kind.

## Fetch Targets And Paths

V1 supports:

- `http`: public HTTP via `ctx.fetcher` or `globalThis.fetch`
- `service`: a Worker service binding with `fetch(request)`
- `durable-object`: a Durable Object namespace, addressed by stable name or id

Public HTTP targets use `url`:

```ts
{ kind: "fetch", target: { type: "http", url: "https://api.example.com/v1" } }
```

Service and Durable Object targets use `pathPrefix` because the binding object
is the authority; the URL visible to the callee's `fetch(request)` handler is
synthetic and chosen by this runtime:

```ts
{
  kind: "fetch",
  target: {
    type: "service",
    binding: { $binding: "USERS" },
    pathPrefix: "/internal"
  }
}
```

`pathMode` lives on the fetch callable and controls what happens to the incoming
path:

```ts
// Default: prefix
{
  kind: "fetch",
  target: { type: "http", url: "https://api.example.com/v1" }
}
// Incoming /users?active=true
// Outbound https://api.example.com/v1/users?active=true
```

```ts
// Replace
{
  kind: "fetch",
  pathMode: "replace",
  target: { type: "http", url: "https://api.example.com/status" }
}
// Incoming /users?active=true
// Outbound https://api.example.com/status?active=true
```

Advanced rewrite behavior is intentionally future work. The task notes track
the prior art we discussed: Caddy `reverse_proxy` plus `rewrite`/`uri`, Envoy
`prefix_rewrite`, and NGINX `proxy_pass` URI behavior.

## Durable Object Addresses

Durable Object addresses are deliberately stable:

```ts
{ type: "name", name: "room-1" }
{ type: "id", id: "..." }
```

There is no `newUniqueId` address. Creating a fresh Durable Object id is
allocation/provisioning work, not a stable invocation descriptor.

## Security

Treat Callables like untrusted code. If you pass a full Worker `env` to a
Callable, you are allowing the JSON to choose any binding name it contains.

V1 keeps that resolver simple on purpose so the kernel stays small. Do not pass
tenant-authored, LLM-authored, or user-authored callables a sensitive `env`
object until `tasks/capability-policy.md` is implemented.

`ctx.fetcher` is only used for public HTTP targets. If omitted, public HTTP
callables use `globalThis.fetch`, which grants ambient public egress to trusted
Worker-boundary code. Untrusted descriptors need an explicit policy layer.

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
