---
status: needs-grilling
size: medium
---

# Switch local dev tunnelling from cloudflared to captun

Replace the Cloudflare Tunnel + cloudflared setup that `pnpm dev` uses with captun (../captun, npm `captun`): a captun gateway worker deployed once for `*.iterate-dev-<user>.com`, with `pnpm dev` creating a named tunnel (`os`) at runtime in ~200ms instead of waiting ~8.5s for cloudflared.

**Scope: `.com` only.** Project hostnames on `*.iterate-dev-<user>.app` stay on cloudflared for now — they need catch-all tunnel routing (arbitrary project slugs) and are where the heavier WebSocket usage lives. On `.com` the tunnel names are fixed (`os`, `mcp`, …) so no catch-all feature is needed. Current dashboard live data uses the itx browser connection (`apps/os/src/itx/itx-react.tsx`) over `/api/itx`; if WebSocket passthrough is still missing when this migration lands, dev can bridge that connection to localhost or temporarily degrade it. The iterate CLI/TUI opens no WebSockets; stream events arrive over HTTP streaming, which captun handles.

## Motivation

- cloudflared connect is slow (~8.5s in captun's own benchmarks vs ~188ms for captun; `../captun/docs/benchmarks.md`).
- First-run alchemy Tunnel resource + wildcard DNS provisioning adds more wait.
- captun is already a dependency of apps/os (project egress intercept tunnels, e2e public tunnels), so the team already operates it. As of 2026-06-10 it's on npm `captun@^0.0.3` (previously a stale `pkg.pr.new/captun@14` pre-merge snapshot); any new captun features (reconnect, WS passthrough) would mean a fresh pkg.pr.new pin or a 0.0.4 release.

## Current state (for reference)

- `pnpm dev` → `apps/os` `doppler run -- tsx alchemy.run.ts` → vite on `127.0.0.1:5173`.
- `packages/shared/src/alchemy/iterate-app.ts:134-179` creates a named Cloudflare Tunnel resource (`dev-tunnel-${stage}`, adopted across sessions) + wildcard CNAME records, then `start-cloudflared.ts` spawns `cloudflared` against `localhost:5173`.
- Two domains per dev: `os.iterate-dev-<user>.com` (OS base URL) and `*.iterate-dev-<user>.app` (project hostnames). Hostname-based routing in apps/os means the tunnel must preserve the original Host.
- `force-public-url-vite-plugin.ts` redirects localhost browsing to the tunnel URL, so _all_ dev traffic — page assets and `/api/itx` — flows through the tunnel. Vite HMR stays local.

## Feasibility summary

Feasible. HTTP, streaming bodies, and SSE all work through captun today (capnweb merged ReadableStream + Request/Response serialization in cloudflare/capnweb#132/#135). The remaining gap for full dashboard parity is **WebSocket passthrough**: stock capnweb 0.8.0 explicitly cannot serialize WebSockets, and itx browser connections traverse `/api/itx`. Jonas's fork PR **iterate/capnweb#1** (open, unmerged; upstream interest tracked in cloudflare/capnweb#187; his upstream PRs #188/#189 were self-closed, not rejected) adds exactly this — tunnelling upgrade Responses' `.webSocket` as a capability, validated against the full Autobahn suite. Known caveats: no flow control on tunneled frames, ping/pong not forwarded, base64 framing overhead.

## Required captun changes

- [ ] Reconnect-on-drop loop in the client (`src/cli/bin.ts:505` only retries the initial connect; capnweb has no session resumption so reconnect = fresh session, fine for stateless fetch forwarding). Also handles gateway DO restarts and laptop sleep/wake. This is a general captun gap — its current uses (e2e tests, short-lived egress intercepts) just never run long enough to hit it — so it belongs upstream in captun regardless of this migration.
- [ ] (Later, for `.app` and log-stream parity) WebSocket passthrough: pin capnweb to a build of iterate/capnweb#1 (pkg.pr.new), detect `Upgrade: websocket` in the gateway worker, do `WebSocketPair`, forward via the tunneled upgrade Response; client side delivers a WebSocket-like object to the local forwarder.
- ~~Catch-all tunnel mode for arbitrary `.app` project slugs~~ — _deferred along with `.app` scope._
- ~~Multi-hostname support in one worker~~ — _moot with `.com`-only scope; one worker, one domain._

## Required iterate changes

- [ ] One-time-per-dev captun gateway deploy for `*.iterate-dev-<user>.com`: tiny standalone worker importing `captun/worker` (same embedding pattern apps/os already uses, but standalone so it keeps the ~64-96ms cold start instead of the OS worker's ~1.3s), wildcard route `*.iterate-dev-<user>.com/*`, proxied wildcard AAAA `100::`, `CUSTOM_HOSTNAME` var. First-level wildcard is covered by Universal SSL — no ACM needed. Could stay an alchemy resource (adopted, never deleted) so it remains declarative, or be a `pnpm setup`-style script.
- [ ] Replace the `.com` Tunnel ingress + `startCloudflared` in `packages/shared/src/alchemy/iterate-app.ts` with `createCaptunTunnel({ name: 'os', fetch })` forwarding to `http://localhost:${vitePort}` preserving the original Host (captun forwards the full public URL — verified `../captun/src/server/worker.ts:156-167`).
- [ ] Keep cloudflared for `.app` project hostnames (possibly started lazily, only when project work needs it) and behind a flag for `.com` fallback during transition.
- [ ] Adjust wildcard CNAME provisioning (`ensureDevTunnelWildcardDnsRecord`) — `.com` DNS becomes static, set once at gateway deploy; `.app` keeps the existing flow.
- [ ] Decide what the itx browser connection does in dev until WS passthrough lands: connect `/api/itx` direct to `localhost:5173` when on a dev tunnel host, or show a "not available through captun yet" notice.

## Phases

- [ ] Phase 0 — spike (~half day): standalone captun worker on a scratch wildcard domain, hand-wired fetch-forwarder to a running `pnpm dev` vite. Measure full page load vs cloudflared (all assets cross capnweb RPC as base64 JSON — captun's README flags large streams as slower; need to confirm vite dev page loads are acceptable). Confirm SSE/MCP works; confirm the itx browser connection is the only WS casualty.
- [ ] Phase 1 — captun: reconnect loop, release via pkg.pr.new.
- [ ] Phase 2 — iterate: gateway deploy + swap `startCloudflared` for captun client on `.com`, flag-guarded; cloudflared stays for `.app`.
- [ ] Phase 3 — WebSockets: adopt iterate/capnweb#1 in captun (or push it upstream via cloudflare/capnweb#187), add upgrade passthrough; unlocks log-stream parity and the future `.app` migration (which also needs catch-all tunnel names).

## Open questions (grill me)

1. itx browser connection in dev until WS lands: localhost bridge or degrade with a notice?
2. Should the gateway deploy live in alchemy (adopted resource) or a one-time setup script outside the alchemy graph?
3. Is the base64/no-flow-control throughput profile acceptable for serving the whole vite dev experience, or do we only tunnel "externally-reachable" flows and browse on localhost?
4. When `.app` follows later: catch-all tunnel mode in captun + WS passthrough are the prerequisites — separate task when we get there.
