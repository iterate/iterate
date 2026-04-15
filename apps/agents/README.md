## `apps/agents`

TanStack Start app + Cloudflare Worker; Agents SDK routes `/agents/<agent-class-kebab>/<instance>` WebSockets to Durable Object agent classes (e.g. `IterateAgent` → `iterate-agent`).

### Manual WebSocket debugging (IterateAgent)

**URL:** `ws://127.0.0.1:<PORT>/agents/iterate-agent/<instanceName>` (local dev) or `wss://<host>/agents/iterate-agent/<instanceName>` (deployed / tunneled). `<PORT>` comes from `pnpm dev` / Alchemy output (often `5173` or `$PORT`). Instance name is arbitrary per connection.

**Inbound frames** use the events stream socket protocol (`StreamSocketFrame` in `@iterate-com/events-contract`): wrap stream events as `{ "type": "event", "event": { ... } }`. For codemode, `IterateAgent` accepts inner events shaped like `codemode-block-added` with `{ "script": "<async arrow body>" }`.

**CLI tools**

- **`websocat`** — best for piping a single JSON line (install: [websocat](https://github.com/vi/websocat) via `brew install websocat` or `cargo install websocat`). Example (local dev):

```bash
printf '%s\n' '{"type":"event","event":{"type":"codemode-block-added","payload":{"script":"async () => ({ ok: true })"}}}' \
  | websocat ws://127.0.0.1:5173/agents/iterate-agent/manual-test
```

- **`wscat`** — interactive REPL for typing frames (no global install: `npx wscat -c "ws://127.0.0.1:5173/agents/iterate-agent/manual-test"`). After connect, paste one line of JSON and Enter.

On connect, the Agents SDK sends its own protocol messages first (`cf_agent_identity`, `cf_agent_state` if any, `cf_agent_mcp_servers`, etc.) before your handler runs; that is expected.

**Scripting without extra CLIs:** Node 22+ exposes `globalThis.WebSocket` — use `addEventListener("open", …)` and `send()` the same JSON string as above.

### Production / tunnel callbacks

`events.iterate.com` opens an **outbound** WebSocket to your **public** `wss://…/agents/iterate-agent/…` callback and sends the same `{ type: "event", event: <Event> }` frames. Local probing uses `ws://`; Semaphore / Cloudflare tunnel URLs use `wss://` with the same path.

### Codemode + HTTP

Codemode runs in a nested worker; outbound HTTP uses `globalOutbound` → `CodemodeOutboundFetch` → host `fetch` (including `APP_CONFIG_EXTERNAL_EGRESS_PROXY`). Scripts use normal **`async () => { ... }`** and global **`fetch(...)`** (same as the nested worker’s outbound).

### Manual probe script

With `pnpm dev` running:

`npx tsx scripts/poke-iterate-ws.mts http://127.0.0.1:5173`

Waits ~2.5s after connect (so events OpenAPI can preload), then sends a minimal `codemode-block-added` that uses `fetch("https://example.com/")`.

### E2E: Semaphore tunnel + local dev server

Order is fixed: **tunnel lease → local port from that lease → `pnpm dev` on that port → `cloudflared`**.

1. `useCloudflareTunnelLease` — Semaphore lease; includes `localPort` from the lease `service` URL (where the tunnel will forward).
2. `useDevServer({ port: tunnelLease.localPort, command: "pnpm", args: ["dev"], ... })` — sets `PORT` so Vite/Alchemy listens on the same port.
3. `useCloudflareTunnel({ token, publicUrl })` — run `cloudflared` so the public URL hits that listener.

See `e2e/vitest/forwarded-events.e2e.test.ts` and `iterate-agent.e2e.test.ts`.

### Inbound frames (strict vs loose)

Production events append full `Event` objects; `StreamSocketFrame` in the contract requires those fields. For local one-line JSON, `IterateAgent` also accepts a minimal `{ "type":"event","event":{ "type":"codemode-block-added","payload":{ "script":"..." } } }`.
