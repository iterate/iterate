# Stream throughput / latency bench

Node-side harnesses for measuring the streams backend and the browser mirror
under load. All of them speak the playground's capnweb WebSocket
(`/api/streams`), so they exercise the same lane the browser client uses.

## Auth

Local dev needs nothing. Deployed environments need an admin bearer:

```bash
export STREAMS_PLAYGROUND_TOKEN=$(doppler run --project streams-example-app --config <env> -- \
  env WORKER_URL=https://<streams host> pnpm exec tsx e2e/auth.ts | tail -1)
```

Tokens expire after 1h — a sudden `WebSocket connection failed.` on connect
usually means re-mint, not outage.

## Scripts

```bash
# single-append RTT distribution (commit + network floor)
pnpm exec tsx scripts/bench/bench-stream.mts rtt wss://<host>/api/streams /bench-rtt 100

# batched append throughput + correctness (acked vs server offset delta)
pnpm exec tsx scripts/bench/bench-stream.mts burst wss://<host>/api/streams /bench-b100 100000 100 64 20

# getEvents paging throughput
pnpm exec tsx scripts/bench/bench-stream.mts read wss://<host>/api/streams /bench-b100 0 100000 500

# paced sustained load with a 1s server-head timeline (for subscriber-lag analysis)
pnpm exec tsx scripts/bench/sustained-load.mts wss://<host>/api/streams /lat-test 5000 200 30

# end-to-end latency pings (pair with the browser sampler below)
pnpm exec tsx scripts/bench/ping-latency.mts wss://<host>/api/streams /lat-test 20 800
```

## Browser-side sampler

For append→mirror latency and replay-progress curves, run this in the stream
page's console (or via browser automation) and correlate timestamps with the
ping/sustained-load output — both sides use the machine's wall clock:

```js
window.__latSamples = [];
window.__lastOff = -1;
window.__latPoll = setInterval(() => {
  const d = globalThis.__streamRuntimeDebug?.();
  const v = d && Object.values(d)[0];
  if (!v) return;
  if (window.__lastOff !== v.lastDeliveredOffset) {
    window.__lastOff = v.lastDeliveredOffset;
    window.__latSamples.push({ offset: v.lastDeliveredOffset, t: Date.now() });
  }
}, 5);
```

`__streamRuntimeDebug()` also exposes `deliveryArrivals` / `totalDeliveredEvents`,
which is how you spot redundant redelivery after connection churn.

## Known sharp edges these scripts measure (see PR notes)

- Unpaced floods of >~1000 in-flight append calls make the Durable Object shed
  load: in-flight calls fail `Network connection lost.`, a few commit without
  acks (retry without idempotency keys ⇒ duplicates).
- The delivery lane dies after ~1000 pushed batches per WebSocket connection
  (worker invocation subrequest budget), so big replays reconnect-thrash and
  redeliver.
- Browser OPFS ingest is far slower than the server's delivery rate and there
  is no backpressure; monster replays balloon memory.
