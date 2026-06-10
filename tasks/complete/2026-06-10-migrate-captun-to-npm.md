# Migrate captun dependency to published npm release

Move apps/os off the stale `https://pkg.pr.new/captun@14` pin (a pre-merge snapshot of
iterate/captun#14, merged 2026-05-23) onto the published `captun@^0.0.3` npm release,
adapting to the API changes that landed between that snapshot and the release
(captun PRs #16–#24: hosted captun.sh, safety controls, runtime adapters).

Groundwork for [switching local dev tunnelling to captun](../switch-dev-tunnels-to-captun.md):
any new captun features (client reconnect loop, WebSocket passthrough) will now diff
against a real release instead of a stale PR build.

- [x] Swap `captun` dependency to `^0.0.3` _(apps/os/package.json)_
- [x] `acceptCaptunTunnel` → `acceptFetcherCapability`, return shape `{response, tunnel}` → `{response, fetcher}` _(project-durable-object.ts)_
- [x] `CAPTUN_SECRET` → `CAPTUN_TOKEN` worker env key — 0.0.3 throws a descriptive error on the old key _(worker.ts `handleCaptunTunnelFetch`)_
- [x] Client options `url`/`headers` → `gateway`/`name`/`token` — captun moved auth to a `captun-token` query param because browser WebSockets can't set headers _(e2e create-test-project.ts, benchmark script)_
- [x] Accept the `captun-token` query param as admin auth on the egress-intercept endpoint, falling back from the `Authorization` header _(project-durable-object.ts `acceptProjectEgressInterceptTunnel`)_
- [x] Send the `ready({url})` handshake after accepting an egress-intercept tunnel — 0.0.3 clients block on it with a 5s timeout _(project-durable-object.ts)_

## Implementation notes

- Verified with apps/os typecheck, repo lint, and `pnpm test:project-ingress` (6/6,
  covers the egress-intercept tunnel accept path including the 401 case).
- `CONNECT_TOKEN_QUERY_PARAM` exists in captun 0.0.3 internally but isn't re-exported
  from the package root until later commits on captun main, so `"captun-token"` is
  inlined with a comment; a captun 0.0.4 release would let us import the constant.
- Not verified locally: the e2e helpers (`createPublicTunnel`,
  `createProjectEgressInterceptTunnel`) need a deployed environment — worth one
  e2e pass or a run of `benchmark:intercept-tunnel` against a dev/preview env.
- History: this work originally landed as `1a0401fc4` on `stream-tui-iterate-cli`,
  was reverted there (`22d53e2c5`), and cherry-picked here onto main.
