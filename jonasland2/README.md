# jonasland2

Minimal local SOA sandbox for oRPC services:

- Nomad (orchestration) on `:4646`
- Consul (service discovery) on `:8500`, DNS on `:53`
- Caddy edge proxy on `:80/:443` (dynamic SRV discovery via Consul)
- OTEL collector on `:4317/:4318` (single exporter fan-out)
- OpenObserve in-container on `:5080`
- `events-service` + `orders-service` via oRPC `OpenAPIHandler` mounted at `/api/*`
- Drizzle ORM + SQLite per service (`/var/lib/jonasland2/*.sqlite`)
- Outerbase Studio database viewer (`outerbase.iterate.localhost`)
- egress proxy service behind Caddy fallback route

## Packages

- `sandbox/`: Debian slim Docker image (`Nomad + Consul + Caddy + OTEL collector + OpenObserve`)
- `e2e/`: smoke tests using Docker SDK fixtures + MSW-backed proxy (HTTP + WS)
- `apps/events-contract/`: oRPC contract package
- `apps/events-service/`: contract implementation package (OpenAPI handler + Scalar docs)
- `apps/orders-contract/`: oRPC contract package
- `apps/orders-service/`: contract implementation package (OpenAPI handler + Scalar docs)
- `apps/orpc-shared/`: shared middleware + OTEL + pino setup
- `tasks/`: jonasland2-local task backlog

## Run

```bash
cd jonasland2
pnpm build
```

## Endpoints

OpenObserve runs in-container and is exposed through Caddy on `openobserve.iterate.localhost`.

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
  - `http://events.iterate.localhost/api/openapi.json`
  - `http://events.iterate.localhost/api/docs` (Scalar)
  - `http://events.iterate.localhost/api/events` (`GET`, `POST`)
  - `http://events.iterate.localhost/api/events/{id}` (`GET`, `PATCH`, `DELETE`)
- Orders service:
  - `http://orders.iterate.localhost/api/openapi.json`
  - `http://orders.iterate.localhost/api/docs` (Scalar)
  - `http://orders.iterate.localhost/api/orders` (`GET`, `POST`)
  - `http://orders.iterate.localhost/api/orders/{id}` (`GET`, `PATCH`, `DELETE`)
  - `http://orders.iterate.localhost/api/orders/ping`
- Consul UI:
  - `http://consul.iterate.localhost/`
- Nomad UI:
  - `http://nomad.iterate.localhost/`
- Outerbase Studio:
  - `http://outerbase.iterate.localhost/`
- OpenObserve UI:
  - `http://openobserve.iterate.localhost/web/`
