---
state: planned
priority: medium
size: large
dependsOn: ["rpc.md"]
---

# Event subscriptions

Now that the callable kernel can dispatch both fetch and Workers RPC callables,
add subscription records as a consumer of that kernel. Prefer capability-first
subscriptions for internal Workers: pass callback stubs and return disposable
subscription objects where possible. Custom WebSocket frames remain useful at
public edges, but should not be the only model.

Planned scope:

- event envelope
- delivery guarantees
- ack/retry/dead-letter semantics
- bounded fanout
- WebSocket frame and ack protocol
- reconnect and backpressure policy
- Cap'n Web / Workers RPC subscription handles
