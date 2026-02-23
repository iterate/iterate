---
state: todo
priority: medium
size: m
dependsOn: [events-service.md, agents-service.md]
---

Add a dedicated docs service that discovers Consul services tagged `openapi`,
crawls each `/api/openapi.json`, merges into one spec, and serves Scalar UI.
