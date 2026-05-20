# Stream v1 — append-only log with durable subscribers

v1 extends the v0 benchmark stream with **durable stream processors**: separate
Durable Objects that subscribe to a stream and receive committed events over a
WebSocket.

This is a deliberately lightweight sketch of the production pattern in
`packages/shared/src/streams/external-subscriber.ts` and
`packages/shared/src/durable-object-utils/mixins/with-stream-processor.ts`.
There is no Callable dispatch, JSONata, circuit breaker, or lifecycle mixin
stack — just two Durable Object classes and a tiny example processor.

## Two connection modes

1. **Ephemeral pull clients** (same as v0): browser or Node opens a WebSocket on
   the stream DO with `?after=start|offset|end`. The stream stores no cursor for
   that socket beyond the hibernation attachment.

2. **Durable subscribers**: append a `subscription-configured` event. From then
   on the stream DO opens an outbound WebSocket to the named
   `StreamProcessor` DO and pushes `{ type: "event", event }` frames after each
   commit. The stream persists `last_sent_offset` per subscriber key in SQLite.

## Wiring a processor

1. Pick a subscriber key and processor slug. In this benchmark, processor DO
   names are derived as `${streamPath}:${processorSlug}`.

2. Append to the stream:

```json
{
  "type": "subscription-configured",
  "payload": {
    "key": "echo",
    "processorSlug": "echo"
  }
}
```

3. The stream connects to `env.STREAM_PROCESSOR.getByName("${streamPath}:${processorSlug}")`,
   sends catch-up from the stored cursor, then live events.

4. The processor reduces events into local SQLite state and may append derived
   events back with `{ "op": "append", "event": { ... } }` on the same socket.

## Example processor

See `processors/echo.ts` — on `ping` it appends `pong`. The
`StreamProcessor` DO loads that contract/implementation and runs the usual
`reduce` → `afterAppend` loop, similar to agent-chat in shared but without the
full processor framework.

## StreamProcessor DO

`StreamProcessor` only implements `fetch()` for WebSocket upgrade (plus
hibernation handlers). It does **not** expose RPC. Reduced state and
`lastProcessedOffset` live in its own SQLite database.

Cloudflare WebSocket hibernation:
https://developers.cloudflare.com/durable-objects/best-practices/websockets/

## Not in v1 yet

- Alarm-driven reconnect when outbound sockets drop (see `random-requirements.md`)
- `subscription-connected` / `subscription-disconnected` lifecycle events
- Chaos / crash-resume tests

## Proof it works

In-Worker benchmark (local dev):

```bash
pnpm dev
curl http://localhost:8787/benchmark/v1-subscriber
```

Expect `"ok": true` with events `subscription-configured` → `ping` → `pong` (echo
processor appended `pong` with `{ n: 1 }`). Harness:
`findings/harness/v1-subscriber-proof.ts`.
