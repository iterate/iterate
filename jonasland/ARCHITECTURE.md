# Jonasland Architecture

## Goal

Minimal local sandbox for routing all HTTP/HTTPS traffic through vanilla Caddy + Consul service discovery, with Nomad running jobs in `raw_exec` mode and an egress service for observability.

## Components

- `nomad` dev agent (single node, container entrypoint)
- `consul` agent (service registry + KV)
- `caddy` (official upstream binary, no custom modules)
- `egress` Node.js service (logs + forwarding)
- `iptables` OUTPUT redirect (80/443)
- `jonasland/e2e-tests` Vitest suite using Docker HTTP API

## Config Model

- Static files are source of truth in repo.
- Nomad jobs are `.nomad.hcl` files (no inline template blocks).
- Caddy runs from static `jonasland/sandbox/caddy/Caddyfile`.
- Caddy discovers `egress` backends via Consul DNS `A` lookups (`egress.service.consul`).
- Sandbox image copies jobs from `/etc/jonasland/nomad/jobs`.

## Traffic Model

- Caddy catch-all routes forward through `egress` service.
- Upstream discovery uses `dynamic a` with resolver `127.0.0.1` and `refresh 1s`.
- Consul DNS listens on port `53` inside the sandbox container.
- DNS cache refresh is set to `1s` for near-real-time service changes.
- `iptables` redirects outbound TCP 80/443 through Caddy.
- Local service discovery domain is Consul-native (`*.service.consul`).

## Egress Modes

- If `ITERATE_EXTERNAL_EGRESS_PROXY` is set: egress forwards to that endpoint.
- If unset: egress forwards directly to original target from upstream headers.
- Egress logs both request metadata and downstream status to stdout.

## How To Use

1. Build image: `pnpm --filter ./jonasland/sandbox build`
2. Run tests: `pnpm --filter ./jonasland/e2e-tests test:e2e` (runs via `doppler run --`)
3. Inspect runtime with container logs + Nomad/Consul/Caddy APIs.

The image is intentionally minimal (`node:24-bookworm-slim`) and installs pinned `nomad` + `consul` binaries plus the official pinned `caddy` binary.

Smoke tests cover both egress paths:

- `ITERATE_EXTERNAL_EGRESS_PROXY` set (`external-proxy` mode)
- env var unset (`direct` mode fallback to original target)

## Known Limits

- MVP is local-only (no Depot/Fly/Doppler).
- Single-node dev topology.
- Security hardening of Caddy admin API is follow-up.
- Current Caddyfile is egress-first catch-all; automatic per-service host routing is a follow-up.
- For Nomad-in-Docker dev mode, the container must run with host cgroup namespace and `/sys/fs/cgroup` mounted RW.

## Follow-up Tasks

See `jonasland/tasks/`.
