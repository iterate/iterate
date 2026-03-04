# Hosts and routing

Single front door is Caddy. All inbound HTTP(S) traffic lands there and is routed by host.

## Source of truth split

- Root built-in routes are defined in `jonasland/sandbox/home-skeleton/.iterate/caddy/Caddyfile`.
- Registry writes additive dynamic fragments into `/home/iterate/.iterate/caddy/*.caddy`.
- Built-ins must work before registry starts.
- Optional apps are expected to register routes with registry when they start.

## Forwarding headers and Host rewrite

Proxies (ingress worker, Fly, Cloudflare Tunnel, e2e test harness) set
`X-Forwarded-Host` to indicate which service they want. The actual `Host`
header is whatever the TCP destination is (e.g. `127.0.0.1:{port}`).

Caddy's first directive in each catch-all block rewrites Host from
X-Forwarded-Host via `request_header`. After that, all downstream matchers
(built-in vhosts, dynamic .caddy fragments, FRP) just match on Host.

- `X-Forwarded-Host` -> rewritten to `Host` by Caddy (our config, not automatic).
- `X-Forwarded-For` -> client IP (handled natively by Caddy `trusted_proxies` + `client_ip_headers`).
- `X-Forwarded-Proto` -> scheme (handled natively by Caddy `trusted_proxies`).
- `Forwarded` (RFC 7239) is not used.

## Built-in internal hosts

Current built-ins routed directly by root Caddyfile:

- `pidnap.iterate.localhost` -> `127.0.0.1:17300`
- `registry.iterate.localhost` -> `127.0.0.1:17310`
- `events.iterate.localhost` -> `127.0.0.1:17320`
- `caddy.iterate.localhost` -> `127.0.0.1:2019`
- `openobserve.iterate.localhost` -> `127.0.0.1:5080`
- `otel-collector.iterate.localhost` -> `127.0.0.1:15333`
- `frp.iterate.localhost` -> `127.0.0.1:27000`

Public exposure for admin/observability hosts is currently open by design.
Auth hardening is a separate follow-up.

## External host formats

Supported ingress forms:

- `{service}__{identifier}.ingress.iterate.com`
- `{service}__{identifier}.proxy.iterate.com`
- `{identifier}.ingress.iterate.com` (root fallback host)
- `frp__{identifier}.ingress.iterate.com`

## `cf-ingress-worker-proxy` forwarding model

Ingress worker routes wildcard hosts to the sandbox. It sets
`X-Forwarded-Host: events__abc.ingress.iterate.com` (or similar).

Inside Caddy:

1. XFH->Host rewrite runs first (`request_header Host {X-Forwarded-Host}`).
2. External ingress snippet extracts service token from Host pattern.
3. `reverse_proxy` rewrites upstream `Host` to canonical `<service>.iterate.localhost`.
4. Service handler sees stable internal host.

## Registry dynamic route flow

Registry owns two things:

1. Resolve public URL from internal URL (`getPublicURL`).
2. Emit dynamic Caddy fragments for registered routes.

High-level lifecycle:

1. Deployment starts (built-ins already routed by root Caddyfile).
2. Optional services start and register `host -> target` route entries in registry.
3. Registry renders fragments for dynamic routes only.
4. Registry stages + validates a temporary config view.
5. Registry promotes fragment changes and reloads Caddy.

## Fallback behavior

Caddy keeps unmatched fallback to `127.0.0.1:19000`.
This is required for machine-level egress behavior where outbound traffic is intentionally redirected into Caddy first.
