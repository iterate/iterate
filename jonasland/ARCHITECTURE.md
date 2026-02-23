# Jonasland Architecture

## Goal

Minimal local sandbox for routing all HTTP/HTTPS traffic through Caddy + Consul service discovery, with Nomad running jobs in `raw_exec` mode and an egress service for observability.

## Components

- `nomad` dev agent (single node, container entrypoint)
- `consul` agent (service registry + KV)
- `caddy-with-consul` (custom caddy build with `github.com/Inpher/caddy-consul`)
- `egress` Node.js service (logs + forwarding)
- `iptables` OUTPUT redirect (80/443)
- `jonasland/e2e-tests` Vitest suite using Docker HTTP API

## Config Model

- Static files are source of truth in repo.
- Nomad jobs are `.nomad.hcl` files (no inline template blocks).
- Caddy bootstrap config is a static Caddyfile.
- Dynamic global config lives in Consul KV key `caddy/global`.
- Sandbox image copies jobs from `/etc/jonasland/nomad/jobs`.

## Traffic Model

- Tagged Consul services (`tags=["caddy"]`) get ingress routing.
- Catch-all routes forward through `egress` service.
- `iptables` redirects outbound TCP 80/443 through Caddy.
- Local hostnames use `*.iterate.localhost`.

## Egress Modes

- If `ITERATE_EXTERNAL_EGRESS_PROXY` is set: egress forwards to that endpoint.
- If unset: egress forwards directly to original target from upstream headers.
- Egress logs both request metadata and downstream status to stdout.

## How To Use

1. Build image: `pnpm --filter ./jonasland/sandbox build`
2. Run tests: `pnpm --filter ./jonasland/e2e-tests test:e2e`
3. Inspect runtime with container logs + Nomad/Consul/Caddy APIs.

The image is intentionally minimal (`node:24-alpine`) and installs pinned `nomad` + `consul` binaries plus a custom `caddy-with-consul` binary built with `xcaddy`.

Smoke tests cover both egress paths:

- `ITERATE_EXTERNAL_EGRESS_PROXY` set (`external-proxy` mode)
- env var unset (`direct` mode fallback to original target)

## Known Limits

- MVP is local-only (no Depot/Fly/Doppler).
- Single-node dev topology.
- Security hardening of Caddy admin API is follow-up.

## Follow-up Tasks

See `jonasland/tasks/`.
