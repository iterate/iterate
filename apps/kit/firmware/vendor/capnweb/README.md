# Bounded C99 Cap'n Web peer

This directory contains a small, allocator-independent Cap'n Web peer for
embedded systems. The application supplies every table and scratch buffer at
session initialization; table exhaustion is reported as `CAPNWEB_E_LIMIT`.

The implementation is deliberately a compatibility profile, not a second full
runtime:

- Supported messages: `push`, `pull`, `resolve`, `reject`, `release`, and
  `abort`.
- Supported expressions: JSON nulls, booleans, signed 64-bit integers, strings,
  arrays, objects, exported capabilities, pipeline calls to resolved
  capabilities, and the bounded `bytes` representation.
- Explicitly unsupported: `stream`, `pipe`/Blob streaming, imported
  expressions in inbound calls, calls queued on unresolved results, and
  property evaluation on returned plain values.
- The typed known-failure ledger is
  [`../__tests__/c-interop-known-failures.ts`](../__tests__/c-interop-known-failures.ts).
  Those cases run and must produce their declared terminal protocol status or
  RPC rejection; they are not skipped.

## Build and verify

```sh
pnpm --dir apps/kit firmware:test:capnweb
```

The script builds this directory independently with ASan/UBSan, runs the
native session tests, then runs
[`../__tests__/c-interop.test.ts`](../__tests__/c-interop.test.ts) against the
compiled C stdio peer using the installed `@iterate-com/capnweb` runtime.
`capnweb-resource-profile` reports table/scratch sizes and elapsed host CPU
time when tools are enabled. `libraryHeapPolicy: "no allocator dependency"`
describes the library contract; it is intentionally not a fabricated count of
allocations made by the host C runtime.

## Ownership

- The main capability remains application-owned and is never disposed by the
  session.
- A successful `capnweb_reply_set_capability()` or
  `capnweb_responder_set_capability()` transfers one capability owner to the
  session. The session disposes it exactly once after both the pending reply and
  all remote wire references are gone, or when the session closes.
- A successful `capnweb_session_export_capability()` transfers one capability
  owner to the session and returns a session-bound local handle. Releasing the
  local handle drops only the application's hold; each serialized occurrence
  of that handle creates a remote wire hold.
- Failed export or reply setters do not take ownership.
- Borrowed expression and byte payloads remain valid until their release
  callback runs. The callback runs once after serialization, cancellation, or
  session close.
- Exporting the same application object twice creates two independent exports.
  The library deliberately does not infer object identity from context
  pointers.

## Callback and transport rules

The session is single-threaded. A dispatch or completion callback may make an
outbound call; this is required for bidirectional RPC. A `send_text` or dispose
callback must not call back into the session. In particular, inbound receive is
rejected with `CAPNWEB_E_STATE` while a text message is being emitted.

`send_text` is synchronous. It receives one `BEGIN`, zero or more `DATA`
fragments, and one `END`; it must consume each borrowed `DATA` fragment before
returning. A transport failure after `BEGIN` is terminal because the partial
message cannot be repaired.

Outbound `push` and `pull` IDs follow Cap'n Web's implicit ordered tables: every
outbound `push` allocates the next local import ID and the peer allocates the
matching incoming export ID. A transport must preserve complete-message order.
