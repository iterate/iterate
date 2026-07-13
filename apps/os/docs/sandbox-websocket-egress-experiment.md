# Sandbox outbound WebSocket egress — P0 experiment

## Question

Can a process **inside** an Iterate sandbox open an outbound `wss://` connection
when HTTPS is MITM'd (`interceptHttps = true`) through ContainerProxy?

## Result (2026-07-13, local containers)

**Yes.** Outbound WebSockets work under the Cloudflare containers Intercept CA.

| Mode                                                             | Target                          | Result                                      |
| ---------------------------------------------------------------- | ------------------------------- | ------------------------------------------- |
| `"direct-fetch"` (bare `fetch` in ContainerProxy, no project DO) | `wss://ws.postman-echo.com/raw` | **OK** — open, send, echo frame             |
| `"project"` (normal project DO egress, no secrets)               | `wss://ws.postman-echo.com/raw` | **OK** — same                               |
| either                                                           | `wss://echo.websocket.events/`  | Flaky / non-101 (host/DNS issues, not MITM) |

TLS peer certificate on the working host:

```text
issuer CN = Cloudflare TLS proxy-everything Intercept CA
subject CN = ws.postman-echo.com
```

Raw curl upgrade also saw:

```http
HTTP/1.1 101 Switching Protocols
Connection: Upgrade
Upgrade: websocket
Sec-WebSocket-Accept: …
```

So the earlier “MITM can’t do WebSockets at all” hypothesis is **false**. The
platform path can complete upgrades. Remaining issues for tools like wrangler
are more likely host-specific, secret-path 501 (fixed here), or approval hold
buffering — not a blanket intercept limitation.

## Product changes on this branch

1. **Secret DO**: removed hard **501** on `Upgrade: websocket`. Upgrades use the
   same substitute-then-`fetch` surface as ordinary secret egress (headers/URL
   only; no frame-level substitution).
2. **Approval hold**: WebSocket upgrades that match a `hold` rule are **denied**
   with a clear message (hold buffers the body and is incompatible with
   upgrades).
3. **`SANDBOX_WEBSOCKET_EGRESS`**: diagnostic switch in
   `cloudflare-sandbox-durable-object.ts`:
   - `"project"` (default) — upgrades through project egress
   - `"direct-fetch"` — bare `fetch(request)` for upgrades only (MITM isolation)

## How to re-run

```bash
# local (containers on)
OS_SANDBOX_CONTAINER_LOCAL_DEV=true pnpm --dir apps/os dev start --detach
pnpm --dir apps/os cli itx run --base-url http://localhost:<port> \
  --file ./scripts/ws-p0-experiment.itx.ts

# deployed e2e
pnpm --dir apps/os exec vitest run e2e/vitest/sandbox-websocket-egress.e2e.test.ts
```

## Background

- CF docs: outbound handlers intercept HTTP/HTTPS; inbound WS to containers is
  documented; outbound WS through intercept was undocumented but works in practice.
- [containers#195](https://github.com/cloudflare/containers/issues/195): intercept
  is not a transparent HTTP/2 tunnel (gRPC still broken) — **orthogonal** to WS
  over HTTP/1.1 upgrade.
- Prior production wrangler failure (`Invalid Upgrade header`) needs a separate
  repro now that generic WSS works.
