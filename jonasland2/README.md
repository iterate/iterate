# jonasland2

Minimal local SOA sandbox for oRPC services:

- Nomad (orchestration) on `:4646`
- Consul (service discovery) on `:8500`, DNS on `:53`
- Caddy edge proxy on `:80/:443` (dynamic SRV discovery via Consul)
- OTEL collector on `:15317/:15318` (fan-out to OpenObserve + ClickStack)
- OpenObserve in-container on `:5080`
- ClickStack in-container (`clickstack-local`) on `:19050/:19051`
- `events-service` + `orders-service` via oRPC `OpenAPIHandler` (`/api/*`) + RPC (`/orpc/*`, `/orpc/ws`)
- `events-service` + `orders-service` are `tsx` apps with embedded Vite + React frontends
- Drizzle ORM + SQLite per service (`/var/lib/jonasland2/*.sqlite`)
- Outerbase Studio embed bridge (`outerbase.iterate.localhost`) with multi-SQLite `ATTACH`
- egress proxy service behind Caddy fallback route

## Packages

- `sandbox/`: Debian slim Docker image (`Nomad + Consul + Caddy + OTEL collector + OpenObserve + ClickStack`)
- `e2e/`: smoke tests using Docker SDK fixtures + MSW-backed proxy (HTTP + WS)
- `apps/events-contract/`: oRPC contract package
- `apps/events-service/`: contract implementation package (OpenAPI handler + Scalar docs + Vite/React UI)
- `apps/orders-contract/`: oRPC contract package
- `apps/orders-service/`: contract implementation package (OpenAPI handler + Scalar docs + Vite/React UI)
- `packages/shared/`: shared OTEL + evlog setup + oRPC client/context helpers
- `apps/orpc-shared/`: compatibility re-export for `@jonasland2/shared`
- `tasks/`: jonasland2-local task backlog

## Run

```bash
cd jonasland2
pnpm build
```

## Outerbase sqlite attach

`outerbase-studio` now runs a lightweight iframe bridge (`sandbox/outerbase-iframe-service.ts`) instead of building the full `outerbase/studio` app in-image.

Runtime env:

- `OUTERBASE_SERVICE_PORT`: HTTP port (default `19040`)
- `OUTERBASE_SQLITE_PATHS`: comma/newline-separated list of sqlite paths; first path is primary DB, rest are `ATTACH`ed
- `OUTERBASE_SQLITE_MAIN_PATH`: optional explicit primary DB path (all paths from `OUTERBASE_SQLITE_PATHS` are then attached)
- `OUTERBASE_STUDIO_EMBED_URL`: optional embed URL (default `https://studio.outerbase.com/embed/sqlite`)
- `OUTERBASE_STUDIO_NAME`: optional embed connection name query param
- `OUTERBASE_BASIC_AUTH_USER`/`OUTERBASE_BASIC_AUTH_PASS`: optional basic auth for bridge routes

Example local launch:

```bash
cd jonasland2/sandbox
OUTERBASE_SERVICE_PORT=19040 \
OUTERBASE_SQLITE_PATHS="/tmp/events.sqlite,/tmp/orders.sqlite,/tmp/audit.sqlite" \
pnpm exec tsx outerbase-iframe-service.ts
```

## Endpoints

OpenObserve runs in-container and is exposed through Caddy on `openobserve.iterate.localhost`.
ClickStack runs in-container and is exposed through Caddy on `clickstack.iterate.localhost`.

Default OpenObserve credentials:

- email: `root@example.com`
- password: `Complexpass#123`

Run container (Nomad client needs writable host cgroup namespace):

```bash
docker run -d --name jonasland2-live \
  --privileged \
  --cgroupns host \
  --add-host host.docker.internal:host-gateway \
  -p 80:80 -p 443:443 -p 2019:2019 -p 4646:4646 -p 8500:8500 \
  jonasland2-sandbox:local
```

Why `node:24-trixie-slim` and not `bookworm`:

- OpenObserve binary in `public.ecr.aws/zinclabs/openobserve:latest` currently requires newer glibc symbols than bookworm provides (`GLIBC_2.38`, `GLIBC_2.39`).

Then hit:

- Caddy health: `http://127.0.0.1/healthz`
- Caddy admin: `http://127.0.0.1:2019/config/`
- Nomad UI: `http://127.0.0.1:4646`
- Consul UI: `http://127.0.0.1:8500`
- Events service:
  - `http://events.iterate.localhost/` (Vite/React UI)
  - `http://events.iterate.localhost/api/openapi.json`
  - `http://events.iterate.localhost/api/docs` (Scalar)
  - `http://events.iterate.localhost/api/events` (`GET`, `POST`)
  - `http://events.iterate.localhost/api/events/{id}` (`GET`, `PATCH`, `DELETE`)
  - `http://events.iterate.localhost/orpc/*` (oRPC over HTTP)
  - `ws://events.iterate.localhost/orpc/ws` (oRPC over WebSocket)
- Orders service:
  - `http://orders.iterate.localhost/` (Vite/React UI)
  - `http://orders.iterate.localhost/api/openapi.json`
  - `http://orders.iterate.localhost/api/docs` (Scalar)
  - `http://orders.iterate.localhost/api/orders` (`GET`, `POST`)
  - `http://orders.iterate.localhost/api/orders/{id}` (`GET`, `PATCH`, `DELETE`)
  - `http://orders.iterate.localhost/api/orders/ping`
  - `http://orders.iterate.localhost/orpc/*` (oRPC over HTTP)
  - `ws://orders.iterate.localhost/orpc/ws` (oRPC over WebSocket)
- Consul UI:
  - `http://consul.iterate.localhost/`
- Nomad UI:
  - `http://nomad.iterate.localhost/`
- Outerbase Studio:
  - `http://outerbase.iterate.localhost/`
- OpenObserve UI:
  - `http://openobserve.iterate.localhost/web/`
- ClickStack UI:
  - `http://clickstack.iterate.localhost/`

## ClickStack job

Run this Nomad job:

```bash
nomad job run /etc/jonasland2/nomad/jobs/clickstack.nomad.hcl
```
