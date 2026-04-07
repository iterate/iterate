# Deployed Processor

Tiny Cloudflare Worker example.

- `pnpm dev` runs `vite dev` on `http://localhost:8788`
- `pnpm wrangler deploy` deploys the worker
- `GET /` prints usage instructions plus concrete `stream/subscription/configured` events to append
- `GET /after-event-handler?streamPath=/some/path` accepts websocket delivery for one stream
- `POST /after-event-handler?streamPath=/some/path` accepts webhook delivery for one stream

The worker uses the same `defineProcessor()` contract as the other workshop
examples. The shared push runtime keeps per-stream state in memory, catches up
from stream history when a delivery arrives, runs `reduce()`, then calls
`afterAppend()` with the canonical `append({ event, path? })` helper.

Streams opt in by appending their own
`https://events.iterate.com/events/stream/subscription/configured` event whose
`callbackUrl` points at this worker. `GET /` shows ready-to-paste websocket and
webhook examples for the current deployment config.
