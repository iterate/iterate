---
state: done
priority: high
size: m
dependsOn: [events-service.md]
---

Add `/orpc` (HTTP RPC) + `/orpc/ws` handlers to `events-service` and `orders-service`,
move shared oRPC middleware/logging/OTEL setup into `packages/shared`, and add e2e typed
manifest-based fixture that starts Nomad jobs, waits for Consul passing via blocking query,
then returns a typed oRPC client.
