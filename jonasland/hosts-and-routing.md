# Hosts and routing

Single front door is Caddy. All inbound HTTP(S) traffic lands there and is routed by host.

## Source of truth split

- Root built-in routes are defined in `jonasland/sandbox/home-skeleton/.iterate/caddy/Caddyfile`.
- Registry writes additive dynamic fragments into `/home/iterate/.iterate/caddy/*.caddy`.
- Built-ins must work before registry starts.
- Optional apps are expected to register routes with registry when they start.

## Canonical forwarding headers

We use Caddy-style `X-Forwarded-*` headers as canonical proxy context:

- `X-Forwarded-For` is canonical client chain (not RFC `Forwarded`).
- `X-Forwarded-Host` carries original external host when upstream proxy rewrites `Host`.
- `X-Forwarded-Proto` carries original scheme.

`Forwarded` (RFC 7239) is not canonical in Jonasland.

## Built-in internal hosts

Current built-ins routed directly by root Caddyfile:

- `pidnap.iterate.localhost` -> `127.0.0.1:17300`
- `registry.iterate.localhost` -> `127.0.0.1:17310`
- `events.iterate.localhost` -> `127.0.0.1:17320`
- `caddy.iterate.localhost` -> `127.0.0.1:2019`
- `caddy-admin.iterate.localhost` -> `127.0.0.1:2019`
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

Ingress worker routes wildcard hosts to the sandbox deployment target.
At Caddy, route selection uses `Host` and `X-Forwarded-Host` patterns:

1. Match `{service}__{id}.(ingress|proxy).iterate.com` from `Host` or `X-Forwarded-Host`.
2. Resolve service to upstream target.
3. Rewrite upstream `Host` to canonical internal host (`<service>.iterate.localhost`).
4. Forward request to the local service.

This keeps service handlers host-stable regardless of ingress form.

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
