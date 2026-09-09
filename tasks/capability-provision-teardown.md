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

A canceled RPC span does not imply its method was still executing. In production
trace `48971bf9e8432c8fcb6d8fc9c8fc9117`, the processor completed registration at
07:51:12.030 UTC, but the Stream RPC remained alive until the browser closed at
07:53:53.851 UTC. Its enclosing subrequest ended 29.969 seconds later with the
native `waitUntil()` cancellation warning. Revocation succeeded in that trace.

Workers adds a hidden disposer to every object returned over native RPC. The
Stream forwards the processor's result, including that disposer. Workerd treats
it as a returned application disposer and retains the Stream call until its
caller disposes the result. The relay copied the coordinates and dropped the
result without disposal, so a completed registration retained its RPC context
for the lifetime of the browser session.

The relay now scopes that result with `using`. The live provider and its Pager
remain owned by the mount; only the completed registration result is released.
No new timeout, retry, queue, or public API is needed.

## Evidence and coverage

- The relay regression failed before the repair (result disposer called zero
  times), then passed with the live provision still active and normal revoke
  intact. All 124 capability-host unit tests passed.
- A native Miniflare/workerd experiment confirmed callback arguments are
  automatically disposed. A three-hop caller/Stream/facet experiment confirmed
  forwarding a disposable result retains the return pipeline until the caller
  disposes it; copying and disposing releases it before the outer call returns.
- The runtime mechanism is documented in [Workers RPC lifecycle](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/)
  and implemented in [workerd return-value deserialization](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/worker-rpc.c++#L149).
- `clients-connect.e2e.test.ts` terminates a real `/api` WebSocket after
  registration, verifies durable disconnection, reconnects the same path, and
  invokes the replacement capability. It passed on the unmodified local server;
  it protects recovery but does not itself detect the retained RPC context.

## Remaining validation

Run the repaired public-worker lifecycle against preview and inspect its native
RPC durations and teardown telemetry. Registration must finish while the client
is still connected, with no unexplained cancellation or disposal errors.
