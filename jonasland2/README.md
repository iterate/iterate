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

## ClickStack low-memory profile

`sandbox/clickstack-launcher.sh` enforces a low-memory profile at startup by writing:

- `/etc/clickhouse-server/config.d/zz-jonasland2-memory.xml`
- `/etc/clickhouse-server/users.d/zz-jonasland2-memory.xml`

Applied defaults:

- `max_server_memory_usage=2147483648` (2 GiB server cap)
- `max_server_memory_usage_to_ram_ratio=0.5`
- `max_memory_usage=1073741824` (1 GiB/query)
- `max_memory_usage_for_user=2147483648`
- `max_memory_usage_for_all_queries=3221225472`
- `max_bytes_before_external_group_by=268435456` (spill at 256 MiB)
- `max_bytes_before_external_sort=268435456` (spill at 256 MiB)
- `max_bytes_in_join=134217728`
- `max_rows_in_join=1000000`
- `join_algorithm=auto`
- `max_threads=4`
- `max_insert_threads=2`
- `use_uncompressed_cache=0`

`sandbox/nomad/jobs/clickstack.nomad.hcl` also sets:

- `NODE_OPTIONS=--max-old-space-size=256` for HyperDX node processes
- Nomad task memory reservation `3072`

Verify active settings:

```bash
docker exec jonasland2-live sh -lc "
chroot /opt/clickstack-root clickhouse-client --query \"
SELECT name, value
FROM system.server_settings
WHERE name IN ('max_server_memory_usage','max_server_memory_usage_to_ram_ratio')
ORDER BY name
\";
chroot /opt/clickstack-root clickhouse-client --query \"
SELECT name, value
FROM system.settings
WHERE name IN (
  'max_memory_usage',
  'max_memory_usage_for_user',
  'max_memory_usage_for_all_queries',
  'max_bytes_before_external_group_by',
  'max_bytes_before_external_sort',
  'max_bytes_in_join',
  'max_rows_in_join',
  'join_algorithm',
  'max_threads',
  'max_insert_threads'
)
ORDER BY name
\"
"
```

Find top memory-heavy queries:

```bash
docker exec jonasland2-live sh -lc "
chroot /opt/clickstack-root clickhouse-client --query \"
SELECT
  event_time,
  formatReadableSize(memory_usage) AS memory,
  normalizedQueryHash(query) AS query_hash,
  query
FROM system.query_log
WHERE type = 'QueryFinish'
ORDER BY memory_usage DESC
LIMIT 20
\"
"
```
