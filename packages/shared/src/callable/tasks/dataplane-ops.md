---
state: planned
priority: low
size: large
dependsOn: []
---

# Dataplane operations

Keep Queue, Workflow, AI, Vectorize, D1, KV, and R2 out of v1. They are platform
operation descriptors, not the same core as fetch/RPC invocation.

Add them only when a real consumer needs stored JSON descriptors for these
operations.
