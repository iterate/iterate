# Test quarantine

Tests parked here depend on LEGACY stream-engine features
(`apps/os/src/domains/streams/engine/**`) that have no equivalent on the next
engine (`apps/os/src/next/**`) the example app now runs on. They are excluded
from `tsconfig.json` and from the vitest include glob (`e2e/vitest/**`).

## stream-reduce-rpc.test.ts

The legacy `StreamRpc` surface exposed the stream reducer as a public RPC
method (`stream.reduce({ event })`), which this test exercised end to end. The
next engine's public `Stream` capability deliberately has no reducer RPC — core
reduction is Stream-Durable-Object-internal and `runtimeState()` only exposes
the reduced state as `unknown`.

Path back: if the next engine ever grows a public "dry-run reduce" or state
introspection RPC, port this test to that surface and move it back to
`e2e/vitest/`. Otherwise delete it together with the legacy engine.
