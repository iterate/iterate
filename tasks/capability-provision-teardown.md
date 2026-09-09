---
state: todo
priority: high
size: small
tags: [os, itx, capability, websocket, cloudflare, lifecycle]
---

# Classify canceled live-capability provisioning during transport teardown

Production already had a canceled `StreamDurableObject.provideCapability` and
later owned-disposal failure before Docs PR #2608. The historic trace ran on
production worker `os-prd`, deployed version
`cfe45d56-af66-4c9b-aebb-4b2d9ae1b36b`, at 2026-09-08 22:13:42 UTC:
[`c4b5d244105d22557293cc59d207bb5b`](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/c4b5d244105d22557293cc59d207bb5b).
It records a canceled provision after its `ProcessorFacet.provideCapability`
child succeeded, then `capability provision dispose failed` at 22:18:17 UTC.
The pre-#2608 source base `d4240ea2b4035f28c1fac564eee6afb7114eaed7` already
contains the same `CapabilityProvisionRpcTarget[Symbol.dispose]` path.

The final Docs preview also had a canceled `provideCapability` beneath a
`waitUntil()` cancellation, but the trace does not expose a promise identity.
The historical trace has no literal `waitUntil()` warning, so it establishes a
pre-existing lifecycle defect class, not the exact cause of that preview
warning.

## Current coverage

`clients-connect.e2e.test.ts` terminates a real `/api` WebSocket after a live
capability has connected, waits for the durable client catalog to say
`connected: false`, then reconnects the same path and invokes its new
capability. This proves the normal abrupt-after-connect recovery contract.
It deliberately does not claim to reproduce cancellation while
`provideCapability` is still in flight.

## Exit criteria

- Find a deterministic public-worker sequence that tears down the transport
  while capability provisioning is in flight, or record why workerd does not
  expose such a boundary.
- If it leaves durable presence, owned disposal, or recovery broken, add the
  smallest runtime repair and a non-quarantined regression.
- Classify every remaining cancellation in trace telemetry without suppressing
  an error signal.
