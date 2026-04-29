---
state: todo
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
- DO name: derived from init params by `getOrInitializeDoStub`
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
`getOrInitializeDoStub()`.

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
