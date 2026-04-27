---
state: planned
priority: medium
size: small
dependsOn: []
---

# Pass-through args

Add a way to pre-populate part of the payload or request template while still
passing runtime values through at invocation time.

This should stay explicit. Avoid broad fallback merging rules that make it hard
to tell which data reached the callee.
