---
state: planned
priority: medium
size: medium
dependsOn: []
---

# RPC callable support

Add RPC support after the fetch kernel has proven binding resolution and runtime
validation. Native Workers RPC / Cap'n Web should be the center of this design:
resolve live service or Durable Object RPC stubs and call typed methods on those
stubs, preserving structured-clone values, functions, `RpcTarget`s, and disposal
semantics.

Planned scope:

- service RPC
- Durable Object RPC
- typed service and Durable Object RPC stubs
- Cap'n Web compatibility for browser/server edges
- method-string invocation only as an adapter for untyped tool manifests, not
  the core RPC model
- error mapping
- lifecycle/disposal tests for RPC-returned values

References:

- https://blog.cloudflare.com/javascript-native-rpc/
- https://developers.cloudflare.com/workers/runtime-apis/rpc/
- https://github.com/cloudflare/capnweb
