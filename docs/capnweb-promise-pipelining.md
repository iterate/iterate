# ITX getter and Workers RPC promise pipelining

## Conclusion

Yes: the natural API can be:

```ts
await this.itx.agents.get("/agents/onboarding").create();
```

`env.ITX.get()` is a Workers RPC call. At runtime such a call returns a
special, lazily-pipelined thenable/stub rather than a native JavaScript
`Promise`. It can receive property reads and method calls before it resolves.
Cloudflare documents the same shape as `await promiseForCounter.increment()`
and also shows nested property traversal before resolution.

- [Cloudflare Workers RPC: promise pipelining](https://developers.cloudflare.com/workers/runtime-apis/rpc/#promise-pipelining)
- [Cloudflare Workerd `JsRpcPromise` implementation at the pinned workerd tag](https://github.com/cloudflare/workerd/blob/v1.20260701.1/src/workerd/api/worker-rpc.h#L168-L225)

This branch pins `workerd` to `1.20260701.1` and Cap'n Web to
`@iterate-com/capnweb@0.10.0` (the upstream `capnweb@0.10.0` release).

## Implementation

The server side is an ordinary `WorkerEntrypoint` RPC method:

```ts
export class ItxEntrypoint extends WorkerEntrypoint {
  async get() {
    return itxForScope(/* … */);
  }
}
```

Therefore the _raw_ caller-side result of `env.ITX.get()` is the native
Workers RPC custom thenable. The SDK preserves that exact object:

```ts
protected get itx(): PipelinedProject {
  return (this.#itx ??= this.env.ITX.get());
}
```

Cap'n Web makes the same distinction explicitly: an `RpcPromise` is a
thenable that is also a proxy for its eventual result, and property access
creates another pipelined promise.

- [Cap'n Web v0.10.0 README: `RpcPromise`](https://github.com/cloudflare/capnweb/blob/capnweb%400.10.0/README.md#rpcpromiset)
- [Cap'n Web v0.10.0 proxy implementation](https://github.com/cloudflare/capnweb/blob/capnweb%400.10.0/src/core.ts#L360-L399)

## Design implication

This does **not** need a new generic record-and-replay proxy. Keep the raw
Workers RPC result as the cached value and type it as a Workers-RPC pipelined
project result. That preserves both lazy acquisition and one-round-trip
chaining. Cap'n Web's `RpcPromise<Project>` is structurally close, but is a
slightly broader promise to users because Cap'n Web also exposes `.map()` and
`onRpcBroken()`, which native Workers RPC does not currently match. A small
local intersection such as `Project & Promise<Project>` can
describe the behavior this SDK actually exposes without claiming those extra
methods.

There is no SDK proxy around the project or environment. The only special case
is explicit at its call site:

```ts
const denied = await this.fetchProjectAuth(request, { policy: "project-member" });
```

That helper sends a fresh bodyless `Request` containing the URL, method, and
headers for paths auth may decline, so a `null` result leaves the app's request
body untouched. The auth callback POST belongs to auth and receives the
complete request. Direct `itx.auth` calls are otherwise ordinary native RPC
calls.

This was checked with the repository's pinned `workerd@1.20260701.1`. An outer
JavaScript proxy needed receiver-binding ceremony for `then`, `catch`,
`finally`, and disposal. Keeping the native object removes that entire failure
mode and preserves pipelined nested calls directly.

Do not solve this by an `async` wrapper around `get()`: any such wrapper
necessarily turns the native RPC thenable into a native Promise and destroys
the pipeline.
