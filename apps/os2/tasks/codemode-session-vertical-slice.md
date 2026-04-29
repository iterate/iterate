---
state: in_progress
priority: high
size: large
dependsOn: []
---

# Codemode Session Vertical Slice

Build the first real `CodemodeSession` Durable Object as a tiny dedicated
worker.

## Shape

- tiny worker: `codemode-session-do`
- Durable Object class: `CodemodeSession`
- main OS2 worker binding: `CODEMODE_SESSION`
- init params: `{ name: string; streamPath: StreamPath }`
- public identity: `streamPath`
- DO name: derived from `{ streamPath }` using the lifecycle mixin helper
- D1 catalog: existing OS2 D1 bound as `DO_CATALOG`
- event app access: call events service directly for now

## Mixin Stack

Use the shared durable object utils:

- `withDurableObjectCore`
- `withLifecycleHooks<CodemodeSessionInitParams>`
- `withD1ObjectCatalog<CodemodeSessionInitParams, { DO_CATALOG: D1Database }>`
- `withOuterbase`
- `withKvInspector`

## First API

- `getStreamPath()`
- `append(input: EventInput)`
- `registerToolProvider(descriptor: ToolProviderDescriptor)`
- `executeScript({ code })`
- `callToolFunction({ path, payload, scriptExecutionRequestedOffset })`
- `getScopedRpcTarget()`

Inherited lifecycle API is not domain API. Callers should use
`deriveDurableObjectNameFromInitParams()` and `initialize()` until the typed
helper stops tripping deep TypeScript instantiation in OS2.

## Current Slice

- [x] Create `codemode-session-do` tiny worker.
- [x] Bind `CODEMODE_SESSION` into the main OS2 worker.
- [x] Add `CodemodeSession` with lifecycle, D1 catalog, KV inspector, and
      Outerbase mixins.
- [x] Store the Tool Provider registry on the session.
- [x] Append codemode events directly to the events app.
- [x] Route one-shot oRPC execution through the session and immediately return
      the committed `script-execution-requested` event.
- [x] Add a shared `createCodemodeContext()` proxy helper.
- [x] Start a Dynamic Worker with a scoped `CodemodeSessionCapability`.
- [x] Prove provider-to-provider Tool Function Calls end-to-end through the session worker.
- [x] Add event-stream-native command/read oRPC methods.
- [x] Move the Codemode page from the compatibility iterator to event-stream-native consumption.
- [ ] Generalize cross-worker self-callable bindings beyond the OpenAPI bridge
      proof path.

## Acceptance Tests

- same `streamPath` resolves to same initialized DO
- catalog row is written to existing OS2 D1
- `registerToolProvider()` appends a registry event and updates local registry
- `executeScript()` immediately returns the appended requested event
- dynamic worker builds `ctx` from `CodemodeSessionCapability`
- provider A can call provider B through the same capability
- `ctx.codemode.append()` appends directly without creating Tool Function events

## Open Questions

See `apps/os2/tmp/codemode-session-exploration/README.md`.
