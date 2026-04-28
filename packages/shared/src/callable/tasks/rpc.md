---
state: completed
priority: medium
size: medium
dependsOn: []
---

# RPC callable support

Implemented in the second callable slice:

- service RPC
- Durable Object RPC by stable name or id
- Dynamic Worker RPC
- loopback service binding RPC through `ctx.exports`
- serialized `call: { type: "rpc", method }`
- `call.argsMode: "object" | "positional"`
- runtime method-name sanitization
- shared `dispatchCallable({ callable, payload, ctx })` for fetch and RPC

Known contract:

- `dispatchCallable()` returns raw RPC results. If Cloudflare attaches a
  disposer to returned stubs / objects, the caller owns that lifecycle and
  should use `using` or manual disposal.

Deferred work:

- lifecycle/disposal coverage for Dynamic Worker RPC return values, if real
  callsites need it
- method allowlists in the capability policy layer
- richer Cap'n Web lifecycle/disposal tests for returned `RpcTarget`s,
  functions, and stubs
- typed convenience APIs only if real callsites prove the value; the core API
  should stay `dispatchCallable({ callable, payload, ctx })`

References:

- https://blog.cloudflare.com/javascript-native-rpc/
- https://developers.cloudflare.com/workers/runtime-apis/rpc/
- https://github.com/cloudflare/capnweb
