---
state: planned
priority: low
size: large
dependsOn: []
---

# Composition and stream replay

Do not add retry, fallback, all, pipe, or timeout until stream replay behavior is
explicit.

Planned scope:

- body strategy for single-use streams
- buffered retry with max bytes
- tee strategy for fanout
- timeout cancellation semantics
- response body cancellation
