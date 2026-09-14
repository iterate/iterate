---
state: todo
priority: high
size: small
tags: [os, itx, capability, websocket, cloudflare, lifecycle]
---

# Release completed capability registration RPCs

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

## Cause and repair

Two native resources outlived a completed client registration:

1. The processor returns fresh coordinates, but Workers RPC adds a hidden
   disposer. The Stream forwarded that result unchanged, so workerd treated
   its disposer as an application disposer and retained the Stream invocation
   until the client released it. The Stream now uses `using` and returns fresh
   coordinates, covering both live and non-live registrations.
2. The Stream's hibernatable `webSocketClose` handler never reciprocated the
   close frame. The Pager disappeared from the DO's socket inventory while
   the relay's socket read loop could remain open. The handler now calls
   `ws.close()` before journaling departure.

No new timeout, retry, queue, or public API is needed. Providers remain owned
by their durable mounts; registration returns only the mount coordinates.

## Evidence and coverage

- Production trace `48971bf9e8432c8fcb6d8fc9c8fc9117`: the processor completed
  registration at 07:51:12.030 UTC, but the Stream RPC remained alive until the
  browser closed at 07:53:53.851 UTC. A native waitUntil cancellation followed
  29.969 seconds later. Revocation succeeded.
- An initial preview fix at the relay released the registration RPC promptly,
  but close-correlated trace `c0913e3d6ef42e1a038abb9fc0791bd0` still showed the
  native warning 30.046 seconds after transport termination, even though
  revocation completed within 76ms. That prompted the socket-handshake repro.
- Native Miniflare/workerd, compatibility date `2026-07-01`: an empty DO close
  handler left the peer waiting after 250ms; adding only `ws.close()` delivered
  the peer's close event. Both versions reported zero DO sockets, demonstrating
  why durable presence/socket inventory alone did not detect the leak.
- `stream-capability-lifecycle.test.ts` exercises the real Stream DO. Both
  regressions failed before their fixes: no result disposal, and no reciprocal
  socket close. The registration test also checks no disposer escapes.
- `clients-connect.e2e.test.ts` terminates a real `/api` WebSocket, verifies
  durable disconnection, reconnects the same path, and invokes its replacement
  capability. The initial fixed preview and an additional held-open fixture
  passed; final proof must also inspect teardown telemetry.
- Native ownership semantics: [Workers RPC lifecycle](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/)
  and [workerd return-value deserialization](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/worker-rpc.c++#L149).

## Remaining validation

Deploy both repairs, hold a uniquely identified client connection open after
registration, then terminate it. Confirm registration ends before transport
close, durable recovery succeeds, and the identified request has no native
waitUntil cancellation or disposal error after the teardown window.
