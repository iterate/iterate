---
status: done
size: small
---

# Migrate captun to the published npm package

apps/os pinned `captun` to `https://pkg.pr.new/captun@14` — a pre-merge snapshot of iterate/captun#14 from May 22. That PR merged and captun 0.0.3 was published to npm, with API renames in between. Move to the published package so future captun work (reconnect-on-drop, WebSocket passthrough for the dev-tunnel plan in `tasks/switch-dev-tunnels-to-captun.md`) diffs against a real release instead of a stale PR build.

- [x] Replace `pkg.pr.new/captun@14` with `captun@^0.0.3` _in apps/os/package.json_
- [x] `acceptCaptunTunnel` → `acceptFetcherCapability`, returns `{response, fetcher}` instead of `{response, tunnel}` _one callsite in project-durable-object.ts_
- [x] `CAPTUN_SECRET` → `CAPTUN_TOKEN` worker env key _in worker.ts handleCaptunTunnelFetch; 0.0.3 throws a descriptive error on the old key_
- [x] Client options: `url`/`headers` → `gateway`/`name`/`token` (browser WebSockets can't set headers, so captun moved auth out of headers) _e2e create-test-project.ts helpers + benchmark script_
- [x] ~~Project DO egress-intercept endpoint accepts the `captun-token` query param as a bearer fallback~~ _superseded: the query param leaked the admin secret into URL logs (flagged by Jonas on the PR); iterate/captun#26 moved the token into `Sec-WebSocket-Protocol`, and the DO now reads it via captun's `connectTokenFromRequest`_
- [x] Send the `ready({url})` RPC after accepting a tunnel — 0.0.3 clients block on it with a 5s timeout _project-durable-object.ts; the captun gateway worker does this itself, but our custom DO accept path didn't_
- [x] Adopt the `Sec-WebSocket-Protocol` Connect Token transport from iterate/captun#26 _pin `pkg.pr.new/captun@26`; DO passes `request` to `acceptFetcherCapability` so the 101 echoes the negotiated subprotocol (strict clients abort the handshake otherwise), and auths via `connectTokenFromRequest` (subprotocol → probe header → legacy query param)_

## Implementation notes

- Verified: apps/os typecheck, repo lint, and `pnpm test:project-ingress` (6/6, covers the egress-intercept tunnel including the 401 auth case). captun#26's own suite covers the real WebSocket handshake (subprotocol echo, wrong-token 401 diagnostics, query-param back-compat).
- Not verified locally: the e2e helpers (`createPublicTunnel`, `createProjectEgressInterceptTunnel`) need a deployed environment — CI e2e or a benchmark-script run against a dev/preview env is the remaining check.
- The `pkg.pr.new/captun@26` pin is temporary: once iterate/captun#26 merges and 0.0.4 ships, swap to `captun@^0.0.4`.
- Follow-up worth its own task: stop using `adminApiSecret` as the tunnel-admission token entirely — mint a scoped tunnel secret so a leak grants "can connect tunnels", not "can administer iterate".
