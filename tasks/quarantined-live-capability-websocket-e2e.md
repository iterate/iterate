---
state: todo
priority: high
size: large
tags: [ci, e2e, websocket, capnweb, cloudflare, quarantine]
---

# Restore the live-capability WebSocket e2e

The two live-capability WebSocket cases were quarantined on 2026-07-22 while
landing PR #2253. The passing boundary probe catches the known
`Could not serialize object of type "WebSocket"` failure, but the damaged
Cap'n Web session then causes the Cloudflare Workers runtime to cancel the
shared OS isolate. That turns one apparent pass into a synchronized wave of
unrelated `Peer closed WebSocket: 1006` retries across the fully parallel
Vitest suite.

## Evidence

- Canonical Depot run
  [`h95t4wvm5n`](https://depot.dev/orgs/0p91s0lz49/workflows/vsm4b78r2d?job=gtxq2vksbg&attempt=ppp78dt78z)
  passed functionally in 312 seconds but absorbed 19 Vitest retries. Every
  first attempt started in the same 277-millisecond launch wave and failed
  because its OS WebSocket closed with code 1006; every retry passed.
- Cloudflare account `376ef7ed81b0573f93524de763666c15`, service
  `os-preview-16`, version `84f6e838-5bc1-47f4-9f60-0ae1476da3fa`, trace
  `d160e356f5fbb1c964364b552d9bd028` identifies the causal session. It created
  `live-ws-pin-6baafa0d`, caught the expected live-capability `Function.call`
  error at `2026-07-22T11:24:05.339Z`, then the runtime canceled the root
  `GET /api` span 110 milliseconds later because the Worker had hung and
  would never generate a response.
- Three isolated invocations all appeared green in 9–10 seconds with no test
  retry, but all three emitted the same hidden runtime cancellation. Their
  unique projects were `live-ws-pin-94a63f00`, `live-ws-pin-41239ac2`, and
  `live-ws-pin-ba08c636`; the cancellations landed at 11:39:53.756Z,
  11:40:04.743Z, and 11:40:15.211Z respectively.
- The `DESIRED` case was a `test.fails`, so any exception counted as success.
  An isolated invocation stopped at its stale router-template anchor before
  attempting the WebSocket dispatch. It therefore provided no active coverage
  while still provisioning a complete project.

## Quarantined behavior

- CI no longer exercises a Node-provided live capability returning an
  upgrading WebSocket `Response` through the internal Worker mesh.
- Ordinary live capabilities, HTTP `Request`/`Response` capability dispatch,
  project-app WebSockets, Cap'n Web transport coverage, and every other OS
  Vitest file remain active and fully parallel.
- Both preserved cases are explicit `test.skip` calls in
  `apps/os/e2e/vitest/live-capability-websocket.e2e.test.ts`; no discovery or
  title filter hides them.

## Work

- Minimize the failure in the Cap'n Web WebSocket-stream bridge and identify
  which serialized socket resource, reverse RPC target, or disposal promise
  remains live after workerd rejects the internal RPC hop.
- Make the unsupported response fail in a bounded way that closes every
  stream/stub and cannot cancel the serving isolate or sibling sessions.
- Update the seeded router patch in the desired-behavior case and replace
  `test.fails` with an assertion that can only pass for the intended outcome.
- Implement the actual socket-carrying mesh behavior, or permanently model the
  unsupported boundary without invoking a runtime-fatal path.

## Exit criteria

- The boundary case runs repeatedly against a real preview with no Worker
  runtime cancellation, unexplained error log, leaked RPC stub, or sibling
  WebSocket disconnect.
- The desired case reaches the project app host and passes as an ordinary test
  only when bidirectional frames survive the complete mesh.
- Both explicit skips are removed.
- At least 25 consecutive canonical, fully parallel preview runs complete with
  zero absorbed retries and no correlated WebSocket-close wave.
