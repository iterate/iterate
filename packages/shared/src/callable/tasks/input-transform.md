---
state: done
priority: medium
size: small
dependsOn: []
---

# Input transform

Implemented as top-level `transformInput` for value dispatch.

The callable pipeline vocabulary is:

1. `payload`: the value passed to `dispatchCallable({ payload })`.
2. `input`: the value after `transformInput` runs.
3. operation-specific construction:
   - Fetch builds a `Request` from `input`.
   - Workers RPC passes `input` as the RPC argument by default.
   - Future dataplane callables can build queue messages, workflow events, etc.

Implemented transform forms:

- `transformInput.shallowMerge`: merge the runtime payload into a fixed object.
  This means `{ ...shallowMerge, ...payload }`; runtime payload fields win.
- `transformInput.jsonata`: transform the current input with JSONata.
- If both are present, shallow merge runs first, then JSONata sees the merged
  input.

`transformInput` applies to `dispatchCallable()` only. It is ignored by raw
`dispatchCallableFetch()` because that API already receives a complete `Request`.

JSONata expressions use the transformed input as the root value (`$`). Host-owned
ambient context is available as `$ambient`, not mixed into the payload object.

Future work, if real callers need it:

- conflict policies for shallow merge
- deep merge
- JSON Pointer-style extraction helpers if JSONata is too heavy for simple cases
- limits and policy hooks for expression length, evaluation time, and output size
