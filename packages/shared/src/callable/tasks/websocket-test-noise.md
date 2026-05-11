---
state: planned
priority: low
size: small
dependsOn: []
---

# WebSocket test runtime noise

`pnpm --dir packages/shared test:callable` passes, but workerd currently prints:

```text
exception = workerd/api/web-socket.c++:821: disconnected: WebSocket peer disconnected
```

The test now closes the socket cleanly from the fixture path, but the runtime
still logs the disconnect. Before broadening WebSocket coverage, either find the
Workers Vitest/miniflare pattern that avoids this noise or isolate the assertion
so CI logs remain easy to scan.
