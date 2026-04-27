---
state: done
priority: medium
size: small
dependsOn: []
---

# Pass-through args

Implemented as `call.passthroughArgs` for value dispatch.

- object-only JSON args
- shallow merge only
- runtime payload wins
- applies to fetch value dispatch and RPC object mode
- rejected for RPC positional mode
- ignored by raw `dispatchCallableFetch()` because the `Request` already exists

Request templating, JSON Pointer extraction, deep merge, and body/query/header
composition remain future work in the request-templating task.
