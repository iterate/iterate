# Callable

`Callable` is a small JSON invocation shape for Workers code. It lets a caller
store or transmit "call this thing" without storing the live Worker binding,
Durable Object stub, or public `fetch` function.

The main API is `dispatchCallable({ callable, payload, ctx })`. In the general
case, callers should not need to know whether the callable is backed by public
HTTP, a service binding `fetch()`, Durable Object `fetch()`, service RPC, or
Durable Object RPC.

```ts
import { dispatchCallable } from "@iterate-com/shared/callable/runtime.ts";

const result = await dispatchCallable({
  callable,
  payload: { userId: "usr_123" },
  ctx: { env },
});
```

Use `dispatchCallableFetch({ callable, request, ctx })` only when you need the
raw Fetch API surface: streaming request bodies, streaming responses, SSE, or
WebSocket upgrade responses.

Only the runtime and type modules are exported from the package:

```ts
import { dispatchCallable } from "@iterate-com/shared/callable/runtime.ts";
import type { Callable } from "@iterate-com/shared/callable/types.ts";
```

## Shape

The schema marker is optional and defaults to v1:

```ts
schema?: "https://schemas.iterate.com/callable/v1";
```

Add it when a persisted record needs to be self-describing. Omit it for normal
in-repo callsites.

The shape is `target` plus optional `call`:

- `target` identifies the capability to resolve: a public URL, Worker binding,
  Durable Object address, or Worker Loader plus code. For HTTP targets,
  `target.url` is also the default fetch base URL.
- `call` describes the operation performed after resolution: fetch request
  shaping or RPC method invocation.
- omitted `call` means `{ type: "fetch" }` for fetch-capable targets.

The small case is intentionally tiny:

```ts
const callable = {
  target: { type: "http", url: "https://api.example.com/tools?fixed=true" },
};
```

That means "fetch this URL". `dispatchCallable()` will POST the JSON payload to
that URL and preserve its query string.

Service binding fetch is similarly terse:

```ts
const callable = {
  target: {
    type: "service",
    binding: { $binding: "USERS" },
  },
};
```

Add `call` when fetch needs options:

```ts
const callable = {
  target: {
    type: "service",
    binding: { $binding: "USERS" },
  },
  call: {
    type: "fetch",
    path: { base: "/internal", mode: "prefix" },
  },
};
```

RPC always needs an explicit call because the method is part of the invocation:

```ts
const callable = {
  target: {
    type: "durable-object",
    binding: { $binding: "USER_REGISTRY" },
    address: { type: "name", name: "global" },
  },
  call: { type: "rpc", method: "findUser" },
};
```

RPC `call.method` is baked into the JSON. It must be one direct JavaScript
identifier, not a dotted path. Names such as `fetch`, `then`, `constructor`,
`prototype`, and `__proto__` are rejected because they collide with Fetch
semantics, Promise-like behavior, JavaScript prototype behavior, or Cloudflare
RPC reserved names.

## Dispatching Values

`dispatchCallable()` turns fetch callables into ordinary value calls by building
a request, dispatching it, rejecting non-2xx responses, and parsing the body.
The default request template is:

- `POST`
- `content-type: application/json`
- body is `JSON.stringify(payload ?? null)`

If a fetch `call.request` is present, it is a partial override of that default:
adding headers or query parameters does not drop the JSON body. `GET` and
`HEAD` value calls do not send a body.

```ts
const callable = {
  target: { type: "http", url: "https://api.example.com/tools" },
};

const result = await dispatchCallable({
  callable,
  payload: { title: "Bug" },
  ctx: { fetcher: fetch },
});
```

Use `call.passthroughArgs` to pre-fill part of the value payload in the
descriptor. This is deliberately shallow and object-only: runtime payload fields
override descriptor fields, and nested objects are replaced rather than merged.

```ts
const callable = {
  target: { type: "http", url: "https://api.example.com/tools" },
  call: {
    type: "fetch",
    passthroughArgs: { provider: "github", dryRun: true },
  },
};

await dispatchCallable({
  callable,
  payload: { name: "createIssue", dryRun: false },
  ctx: { fetcher: fetch },
});

// POST body:
// {"provider":"github","dryRun":false,"name":"createIssue"}
```

`passthroughArgs` also works for RPC object mode:

```ts
await dispatchCallable({
  callable: {
    target: { type: "service", binding: { $binding: "TOOLS" } },
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

If the response has a JSON content type, the result is parsed JSON. Otherwise it
is returned as text. Non-2xx responses throw `CallableError` with code
`REMOTE_ERROR`, and the error details include the response status and body.

RPC callables dispatch to a service binding or Durable Object stub and call the
named method. `argsMode` defaults to `object`, so the payload is passed as one
argument:

```ts
await dispatchCallable({
  callable: {
    target: { type: "service", binding: { $binding: "TOOLS" } },
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
    target: { type: "service", binding: { $binding: "MATH" } },
    call: { type: "rpc", method: "add", argsMode: "positional" },
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
    target: {
      type: "durable-object",
      binding: { $binding: "ROOMS" },
      address: { type: "name", name: "room-1" },
    },
    call: { type: "fetch", path: { base: "/events" } },
  },
  request,
  ctx: { env },
});
```

This is also the API used by `connectCallableWebSocket()`: WebSocket is fetch
with upgrade headers, not a separate callable kind.

`connectCallableWebSocket()` accepts `binaryType` and `accept` options so callers
can set Worker WebSocket behavior before the socket is accepted.

## Fetch Targets And Paths

V1 supports:

- `http`: public HTTP via the explicit `ctx.fetcher` capability
- `service`: a Worker service binding with `fetch(request)`
- `durable-object`: a Durable Object namespace, addressed by stable name or id
- `dynamic-worker`: a Worker loaded through a Worker Loader binding

Public HTTP targets use `url`, and the URL may include a query string:

```ts
{ target: { type: "http", url: "https://api.example.com/v1?fixed=true" } }
```

Service and Durable Object targets do not have public URLs. The binding or DO
stub is the authority, and the URL visible to the callee's `fetch(request)`
handler is synthetic and chosen by this runtime:

```ts
{
  target: {
    type: "service",
    binding: { $binding: "USERS" }
  }
}
```

Fetch path options live under `call.path` because they are part of building a
`Request`, not part of target identity:

```ts
// Default call: omitted means { type: "fetch" }
{
  target: { type: "http", url: "https://api.example.com/v1" }
}
// Incoming /users?active=true
// Outbound https://api.example.com/v1/users?active=true
```

```ts
// Replace
{
  target: { type: "http", url: "https://api.example.com/status" },
  call: { type: "fetch", path: { mode: "replace" } }
}
// Incoming /users?active=true
// Outbound https://api.example.com/status?active=true
```

```ts
// Service binding with a synthetic path base
{
  target: { type: "service", binding: { $binding: "USERS" } },
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
that incoming request; if `call.request.query` is omitted, an HTTP target's
query is preserved, and if `call.request.query` is present, it replaces the
target query wholesale. Use `query: {}` to clear the target query.

```ts
// Proxy mode drops target query params when the incoming request has no query.
{ target: { type: "http", url: "https://api.example.com/v1?fixed=true" } }
// Incoming /users
// Outbound https://api.example.com/v1/users
```

```ts
// Proxy mode uses the incoming query wholesale.
{ target: { type: "http", url: "https://api.example.com/v1?fixed=true" } }
// Incoming /users?active=true
// Outbound https://api.example.com/v1/users?active=true
```

Advanced rewrite behavior is intentionally future work. The task notes track
the prior art we discussed: Caddy `reverse_proxy` plus `rewrite`/`uri`, Envoy
`prefix_rewrite`, and NGINX `proxy_pass` URI behavior.

## Dynamic Worker Targets

Dynamic Workers behave like binding-backed targets once resolved. The only
Dynamic Worker-specific work is resolving the Worker Loader binding, loading the
inline code, and taking the default entrypoint. After that, fetch and RPC use
the same dispatch paths as service bindings and Durable Object stubs.

Omitted `call` means fetch:

```ts
const callable = {
  target: {
    type: "dynamic-worker",
    loader: { $binding: "LOADER" },
    code: {
      compatibilityDate: "2026-04-27",
      mainModule: "worker.js",
      modules: {
        "worker.js": "export default { fetch() { return Response.json({ ok: true }) } }",
      },
    },
  },
};
```

RPC uses the same `call.method` and `argsMode` rules as service/DO RPC:

```ts
const callable = {
  target: {
    type: "dynamic-worker",
    loader: { $binding: "LOADER" },
    code,
  },
  call: { type: "rpc", method: "run" },
};
```

By default the runtime calls `loader.load(code)`, which creates a fresh Dynamic
Worker. If a Worker Loader binding only exposes the older `get(null, getCode)`
shape, the runtime uses that as the same one-off load operation. Add `cache`
only when the ID names this exact code version:

```ts
const callable = {
  target: {
    type: "dynamic-worker",
    loader: { $binding: "LOADER" },
    code,
    cache: { mode: "get", id: "sha256:..." },
  },
};
```

`cache` is loader identity, not application state affinity. The callable
runtime does not memoize Worker stubs; it calls `loader.get(id, ...)` for each
dispatch. Cloudflare may reuse a warm isolate for the same ID, but the callback
must return the same code for that ID and callers must not rely on two requests
hitting the same isolate. If the code changes, use a new ID. Content hashes or
explicit version strings are good cache IDs.

V1 supports only inline JavaScript modules:

- `code.compatibilityDate` is required.
- `code.compatibilityFlags` is an optional string array.
- `code.mainModule` must exist in `code.modules`.
- every module name must end in `.js`.
- named entrypoints, entrypoint props, typed module objects, Python,
  `allowExperimental`, `env`, `globalOutbound`, tails, streaming tails, and
  source refs are future work.

Dynamic Worker targets execute the supplied module source. V1 does not set
`WorkerCode.globalOutbound`, so dynamic code inherits the parent Worker's
outbound network access. Do not dispatch tenant-authored, user-authored,
LLM-authored, or otherwise untrusted Dynamic Worker callables until egress
policy and `globalOutbound` support land.

Cloudflare Dynamic Workers docs:

https://developers.cloudflare.com/dynamic-workers/api-reference/

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

`ctx.fetcher` is only used for public HTTP targets and is required for them.
Worker-boundary code that wants normal runtime fetch should pass
`ctx: { fetcher: fetch }` explicitly. The library does not fall back to
`globalThis.fetch`, because public egress is a capability and should not be
created by a shared helper reading ambient globals.

Dynamic Worker callables are especially sensitive: the descriptor contains
executable source code, and this prototype does not sandbox its outbound
network access.

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
