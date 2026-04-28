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

Planned scope:

- init-param selectors, for example `durableObject: { initParam: { key, value } }`
- indexed init-param selectors backed by D1/SQLite or another registry
- allocation/provisioning helpers that call `newUniqueId()` and persist the ID
  before creating a callable
- tests proving non-native selectors resolve to a Durable Object stub before
  entering the existing fetch/RPC dispatch paths

References:

- https://developers.cloudflare.com/durable-objects/api/namespace/
