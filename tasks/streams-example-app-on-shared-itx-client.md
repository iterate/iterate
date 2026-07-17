---
state: todo
priority: medium
size: small
dependsOn: []
tags: [streams-example-app, itx, iterate-package, consolidation]
---

# streams-example-app: drop the hand-rolled dial for the shared itx client

`apps/streams-example-app/src/lib/stream-rpc.ts` (~67 LOC),
`capnweb-stream-browser-client.ts`, and `stream-connection.ts` re-implement
pieces the `iterate` package now owns: `newWebSocketRpcSession` dialing, the
ws/wss protocol swap (`apiWebSocketUrl` in the package), and
connecting/connected/closed/error status plumbing.

Replace with `iterate/client` (or the react hooks where the app is React) so
the example app demonstrates the blessed way to connect — it is example code,
so it should model the pattern we want copied. Its e2e
(`e2e/vitest/stream-capnweb.test.ts`, `stream-processor-node.test.ts`) is the
proof lane.

Context: PR #2063's consolidation-sweep findings.
