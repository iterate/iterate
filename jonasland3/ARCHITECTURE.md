# Jonasland3 Architecture

## Goal

Smallest working single-container homelab stack:

- Nomad dev agent is the main process inside one Docker container.
- Consul runs as a Nomad `raw_exec` system job.
- Caddy runs as a Nomad `raw_exec` system job.
- CPM (Caddy Proxy Manager UI) runs as a Nomad `raw_exec` system job.
- Caddy discovers upstreams through Consul DNS SRV (`dynamic srv`).

No custom Caddy plugins. No Docker socket mount. No sibling containers.

## Runtime flow

1. Container starts `start.sh`.
2. `start.sh` starts Nomad and waits for API readiness.
3. `start.sh` submits `consul.nomad.hcl`.
4. After Consul is healthy, `start.sh` submits `caddy.nomad.hcl`.
5. After Caddy is healthy, `start.sh` submits `cpm.nomad.hcl`.

## Service routing

- Caddy listens on port `80`.
- `Host: nomad.localhost` routes to `nomad.service.consul` using `dynamic srv` with resolver `127.0.0.1:53`.
- Caddy admin API listens on loopback `127.0.0.1:2019`.
- Admin API is API/CLI-only. Browser-style navigations to `/config/` are expected to fail origin checks.
- Admin API is container-internal in this setup (loopback bind); it is intentionally not exposed on a Docker host port.
- CPM UI listens on `:8501`.
- CPM is installed from `ghcr.io/tomaszmek/cpm:3.1.0`.
- In this single-container `raw_exec` model there is no Docker socket, so CPM dashboard status/reload actions that require Docker exec are expected to be degraded.

## E2E scope

`jonasland3/e2e-tests` validates:

- Nomad leader is up.
- Consul is healthy and service-registered.
- Caddy is service-registered and admin API reachable for API clients.
- Caddy rejects browser-style navigation access to admin endpoints.
- Caddy can proxy to Consul via SRV-based discovery.
- CPM UI is reachable on port `8501`.

## Commands

- Build image: `pnpm --filter ./jonasland3/sandbox build`
- Run e2e: `pnpm --filter ./jonasland3/e2e-tests test:e2e`
