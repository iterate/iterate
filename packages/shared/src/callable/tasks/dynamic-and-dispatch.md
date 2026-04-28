---
state: in-progress
priority: low
size: large
dependsOn: []
---

# Dynamic Workers and dispatch namespaces

Dynamic Worker fetch/RPC is implemented for the default entrypoint with inline
JavaScript source. The remaining scope is dispatch namespace support and the
larger Dynamic Worker capability surface.

Implemented:

- Dynamic Worker fetch
- Dynamic Worker RPC
- optional `load: { type: "get", id }` for Worker Loader `get()`
- strict inline JS-only code shape: compatibility date, main module, modules
- shared dispatch path after resolving the Dynamic Worker entrypoint
- named Dynamic Worker entrypoint selection
- Dynamic Worker entrypoint `props`

Deferred:

- dispatch namespace fetch
- source refs / CIDs / content hashes instead of inline source
- egress/globalOutbound policy
- derive or validate `load.id` from a canonical WorkerCode hash
- `env`, tails, typed module objects, Python modules
- Dynamic Worker WebSocket-specific test coverage, if we find a clean way to
  avoid additional workerd teardown noise

References:

- https://developers.cloudflare.com/dynamic-workers/api-reference/
