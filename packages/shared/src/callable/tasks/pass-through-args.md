---
state: done
priority: medium
size: small
dependsOn: []
---

# Pass-through args

Implemented as top-level `passthroughArgs` for value dispatch.

- object-only JSON args
- shallow merge only
- runtime payload wins
- applies to fetch value dispatch and RPC object mode
- rejected for RPC positional mode
- ignored by raw `dispatchCallableFetch()` because the `Request` already exists

Request templating, JSON Pointer extraction, deep merge, and body/query/header
composition remain future work in the request-templating task.

Future merge policy, if real callers need it:

- `passthroughArgsPolicy: { merge: "payload-wins" }` for the current default
- `passthroughArgsPolicy: { merge: "reject-conflicts" }`
- `passthroughArgsPolicy: { merge: "passthrough-wins" }`
- `passthroughArgsPolicy: { merge: "under-key", key: "context" }`

Do not implement these until the shallow default is insufficient in a real
callsite.
