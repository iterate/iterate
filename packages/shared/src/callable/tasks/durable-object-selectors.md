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

The nested `durableObject` object exists so future selectors can be added
without flattening more mutually exclusive fields onto `via`.

The durable-object-utils mixins merged after callable v1 make this less
speculative. `withLifecycleHooks()` gives named Durable Objects persistent
`initParams`, `getOrInitializeDoStub()` initializes named stubs before use, and
`withD1ObjectCatalog()` mirrors initialized object metadata and secondary
indexes into D1. Callable should not depend on those mixins in v1, but future
selector helpers can use that catalog/provisioning layer to resolve a selector
to a normal Durable Object stub before dispatch enters the existing fetch/RPC
code path.

Planned scope:

- init-param selectors, for example `durableObject: { initParam: { key, value } }`
- indexed init-param selectors backed by `withD1ObjectCatalog()` or another
  registry
- named initialization helpers that call `getOrInitializeDoStub()` before
  creating or invoking a callable when the target object follows the lifecycle
  mixin contract
- allocation/provisioning helpers that call `newUniqueId()` and persist the ID
  before creating a callable
- tests proving non-native selectors resolve to a Durable Object stub before
  entering the existing fetch/RPC dispatch paths

References:

- https://developers.cloudflare.com/durable-objects/api/namespace/
