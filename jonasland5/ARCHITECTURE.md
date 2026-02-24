# Jonasland5 Architecture

## Goal

Smallest working single-container homelab stack:

- Pidnap is the main process manager inside one Docker container.
- Caddy runs as a pidnap-managed process.
- Services service runs as a pidnap-managed process (in-memory route table + ORPC API).
- All ingress enters via a single host-mapped URL to Caddy on container port `80`.
- Outbound TCP `:80/:443` is transparently redirected to Caddy with iptables.

No custom Caddy plugins. No Docker socket mount. No sibling containers.

## Runtime flow

1. Container starts `start.sh`.
2. `start.sh` installs `nat OUTPUT` rules redirecting `:80/:443` to local Caddy.
3. `start.sh` starts pidnap (`pidnap.config.ts`).
4. Pidnap starts `caddy` and `services`.

## Service routing

- Caddy listens on port `80`.
- `Host: pidnap.iterate.localhost` routes to `127.0.0.1:9876`.
- `Host: services.iterate.localhost` routes to `127.0.0.1:8777`.
- `Host: caddy-admin.iterate.localhost` routes to Caddy admin `127.0.0.1:2019`.
- Any outbound HTTP(S) from root-owned processes is redirected to Caddy by iptables.
- Caddy admin API listens on `0.0.0.0:2019` inside the container.
- Admin API is reached externally via the single ingress URL + `Host: caddy-admin.iterate.localhost`.
- Services ORPC listens on `0.0.0.0:8777` inside the container.

## E2E scope

`jonasland5/e2e-tests` validates:

- Pidnap RPC is up.
- Caddy is running and typed SDK client access works.
- Services service is running and typed client access works.
- Caddy rejects browser-style navigation access to admin endpoints.
- Caddy can proxy to pidnap via host routing.
- iptables redirect rules are present and outbound HTTP is intercepted by Caddy.
- Pidnap can imperatively add/start/stop/remove runtime processes after baseline health.

## Commands

- Build image: `pnpm --filter ./jonasland5/sandbox build`
- Run e2e: `pnpm --filter ./jonasland5/e2e-tests test:e2e`
