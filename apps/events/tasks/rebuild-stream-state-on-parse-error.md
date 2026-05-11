---
state: todo
priority: medium
size: small
dependsOn:
---

# Rebuild stream state on parse error

If persisted `reduced_state` fails `StreamState` parsing in the stream durable object,
rebuild the state from stored events instead of treating the stream as uninitialized.

This avoids re-running synthetic initialization and hitting duplicate offset writes
against existing local or upgraded data.
