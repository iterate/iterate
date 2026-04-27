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
- serialized `rpcMethod`
- `argsMode: "object" | "positional"`
- runtime method-name sanitization
- shared `dispatchCallable({ callable, payload, ctx })` for fetch and RPC

Deferred work:

- Dynamic Worker RPC
- pass-through args / pre-populated call arguments
- method allowlists in the capability policy layer
- richer Cap'n Web lifecycle/disposal tests for returned `RpcTarget`s,
  functions, and stubs
- typed convenience APIs only if real callsites prove the value; the core API
  should stay `dispatchCallable({ callable, payload, ctx })`

References:

- https://blog.cloudflare.com/javascript-native-rpc/
- https://developers.cloudflare.com/workers/runtime-apis/rpc/
- https://github.com/cloudflare/capnweb
