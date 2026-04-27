# Callable

`Callable` is a small JSON invocation shape for Workers code.

V1 is intentionally narrow: it only implements fetch-shaped callables. The point
is to prove the kernel before adding RPC, event subscriptions, tool providers,
Dynamic Workers, dispatch namespaces, queues, workflows, AI, KV, R2, or retry
composition.

## Contract

A `Callable` is JSON data. It is not a live capability.

```ts
const callable = {
  schemaVersion: "callable/v1",
  kind: "fetch",
  target: {
    type: "service",
    binding: { $binding: "USERS" },
    pathPrefix: "/internal",
  },
};
```

The runtime resolves `{ $binding: "USERS" }` against `ctx.env` only when you
dispatch it:

```ts
await dispatchCallableFetch({
  callable,
  request,
  ctx: { env },
});
```

This is why the docs sometimes call a `Callable` a descriptor: it describes a
call, but it does not grant one.

Treat Callables like untrusted code. If you pass a full Worker `env` to a
Callable, you are allowing the JSON to choose any binding name it contains. V1
keeps that resolver simple on purpose; `tasks/capability-policy.md` tracks the
policy layer for untrusted tenants, LLM-generated descriptors, and stored user
configuration.

## Fetch Targets

V1 supports:

- `http`: public HTTP via `ctx.fetcher` or `globalThis.fetch`
- `service`: a Worker service-like binding with `fetch(request)`
- `durable-object`: a Durable Object namespace, addressed by name or id

Durable Object addresses are deliberately stable:

```ts
{ type: "name", name: "room-1" }
{ type: "id", id: "..." }
```

There is no `newUniqueId` address. Creating a fresh Durable Object id is
allocation/provisioning work, not a stable invocation descriptor.

## Upstream And Path Modes

`target.upstream` is only for public HTTP targets. Service and Durable Object
targets use `pathPrefix` because the binding object is the actual authority; the
URL visible to the callee's `fetch(request)` handler is synthetic and chosen by
the runtime.

`pathMode` controls how the incoming request path is applied:

```ts
// Default: prefix
{
  target: { type: "http", upstream: "https://api.example.com/v1" }
}
// Incoming /users?active=true
// Outbound https://api.example.com/v1/users?active=true
```

```ts
// Replace
{
  target: {
    type: "http",
    upstream: "https://api.example.com/status",
    pathMode: "replace"
  }
}
// Incoming /users?active=true
// Outbound https://api.example.com/status?active=true
```

For service and Durable Object targets, the same modes apply to `pathPrefix`:

```ts
{
  target: {
    type: "service",
    binding: { $binding: "USERS" },
    pathPrefix: "/internal"
  }
}
// Incoming /users
// Callee sees https://service.local/internal/users
```

Advanced proxy rewrite behavior is intentionally future work. The task notes
track the prior art we discussed: Caddy `reverse_proxy` plus `rewrite`/`uri`,
Envoy `prefix_rewrite`, and NGINX `proxy_pass` URI behavior.

## WebSockets

WebSocket is not a separate callable kind. It is fetch with upgrade headers:

```ts
const ws = await connectCallableWebSocket({
  callable,
  ctx: { env },
});
```

Workers also support `new WebSocket(url)` for public URL endpoints, but this
folder uses fetch-with-upgrade because it works for non-URL targets like service
bindings and Durable Object stubs. Cloudflare documents the Workers
`response.webSocket` extension here:
https://developers.cloudflare.com/workers/runtime-apis/response/#websocket

## Request Templates

`buildCallableRequest` supports a tiny payload-to-request bridge:

```ts
const request = buildCallableRequest({
  callable: {
    schemaVersion: "callable/v1",
    kind: "fetch",
    target: { type: "http", upstream: "https://api.example.com/tools" },
    requestTemplate: {
      method: "POST",
      headers: { "x-tool": "create-issue" },
      query: { dryRun: true },
      body: { type: "json", from: "payload" },
    },
  },
  payload: { title: "Bug" },
});
```

No RFC 6570, JSON-e, JSON Pointer, or pass-through args yet. Those are parked in
`tasks/` until real callers force the shape.

## Tests

Run:

```bash
pnpm --dir packages/shared test:callable
```

The config lives in this folder on purpose:

- `vitest.config.ts`
- `wrangler.vitest.jsonc`
- `entry.workerd.vitest.ts`
- `runtime.test.ts`

It uses Cloudflare's Workers Vitest pool:
https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/

## Future Work

Each broad feature has a task file in `tasks/`. Do not quietly grow v1; add the
next slice with tests and an updated README section when a task becomes real.
