---
state: planned
priority: medium
size: medium
dependsOn: []
---

# Durable Object selectors

V1 supports Cloudflare's native stable selectors:

- `durableObject: { name }`
- `durableObject: { id }`

The default answer should stay boring: if a Durable Object's identity is derived
from init params, compose a stable name from those params and store
`durableObject: { name }` in the callable. That keeps the callable descriptor
native to Cloudflare's Durable Object namespace API and avoids adding lookup
machinery that may never be needed.

Keep this task only as a parking lot for cases where name composition is not
enough. The durable-object-utils mixins make that possible:
`withLifecycleHooks()` gives named Durable Objects persistent `initParams`,
`getOrInitializeDoStub()` initializes named stubs before use, and
`withD1ObjectCatalog()` mirrors initialized object metadata and secondary
indexes into D1. If we later add indexed selectors, callable should resolve the
selector to a normal Durable Object stub first, then enter the existing fetch/RPC
dispatch path.

Possible future scope:

- document name-composition conventions for common init-param shapes
- indexed init-param selectors backed by `withD1ObjectCatalog()` or another
  registry, only if a real caller cannot use deterministic names
- named initialization helpers that call `getOrInitializeDoStub()` before
  creating or invoking a callable when the target object follows the lifecycle
  mixin contract
- allocation/provisioning helpers that call `newUniqueId()` and persist the ID
  before creating a callable
- tests proving non-native selectors resolve to a Durable Object stub before
  entering the existing fetch/RPC dispatch paths

References:

- https://developers.cloudflare.com/durable-objects/api/namespace/
