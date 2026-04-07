# Deployed Processor

Tiny Cloudflare Worker example.

- `pnpm dev` runs `vite dev` on `http://127.0.0.1:8788`
- `pnpm wrangler deploy` deploys the worker
- route: `GET /after-event-handler?streamPath=/some/path` websocket upgrade

The worker parses the incoming event with the shared Zod `Event` schema, keeps a
per-stream in-memory processor instance, catches up from stream history when
needed, then runs `reduce()` and `onEvent()` for websocket-delivered events.
