# JonasLand Sandbox PoC

Docker-first parity with Fly deploy/check.

## Prereqs

- `depot`, `docker`, `pnpm`
- for Fly flow: `flyctl`, `FLY_API_TOKEN` (or `flyctl auth login`)

## Build image

```bash
pnpm --filter @iterate-com/jonasland-sandbox build
```

Default tags:

- local: `jonasland-sandbox:sha-<shortsha>[-dirty]`
- fly: `registry.fly.io/jonasland-sandbox:sha-<shortsha>[-dirty]`
- depot: `registry.depot.dev/<depotProjectId>:sha-<shortsha>[-dirty]`

Useful env vars:

- `JONASLAND_SANDBOX_BUILD_PLATFORM` (default `linux/amd64,linux/arm64`)
- `JONASLAND_SANDBOX_SKIP_LOAD=true` (registry-only build)
- `JONASLAND_SANDBOX_PUSH_FLY_REGISTRY=true|false` (auto by `FLY_API_TOKEN` if unset)
- `JONASLAND_FLY_REGISTRY_APP` (default `jonasland-sandbox`)

## Docker PoC (local)

```bash
pnpm --filter @iterate-com/jonasland-sandbox docker:poc
pnpm --filter @iterate-com/jonasland-sandbox docker:poc:check
```

This runs container with `NET_ADMIN`, validates iptables/ip6tables redirects, starts `events` + `orders` via `/_pidnap`, and verifies an `orders/order-placed` event through `/_events`.

## Fly PoC (public internet)

```bash
pnpm --filter @iterate-com/jonasland-sandbox fly:poc
pnpm --filter @iterate-com/jonasland-sandbox fly:poc:check
```

Useful env vars:

- `JONASLAND_FLY_APP` (default `jonasland-sandbox`)
- `JONASLAND_FLY_ORG` (default `iterate`, fallback `FLY_ORG`)
- `JONASLAND_FLY_REGION` (default `ord`)
- `JONASLAND_FLY_VM_CPU_KIND` (default `shared`)
- `JONASLAND_FLY_VM_CPUS` (default `2`)
- `JONASLAND_FLY_VM_MEMORY_MB` (default `2048`)
- `JONASLAND_FLY_IMAGE` (deploy a specific already-pushed image)
- `JONASLAND_SKIP_BUILD=true` (skip build/push in deploy mode)
- `JONASLAND_CF_PROXY_ENABLE=auto|true|false` (default `auto`)
- `JONASLAND_CF_PROXY_RUN_ID=<vitest-id>` (default `<app>-<gitsha>`)
- `JONASLAND_CF_PROXY_TTL_SECONDS=21600` (default 6h)
- `CF_PROXY_WORKER_API_TOKEN` (required if cf proxy enabled)
- `CF_PROXY_WORKER_BASE_URL` (default `https://admin.proxy.iterate.com`)

When cf proxy is enabled, Fly PoC automatically registers exact routes:

- exact routes:
  - `registry__<runId>.proxy.iterate.com`
  - `pidnap__<runId>.proxy.iterate.com`
  - `events__<runId>.proxy.iterate.com`
  - `orders__<runId>.proxy.iterate.com`
  - `docs__<runId>.proxy.iterate.com`
  - `home__<runId>.proxy.iterate.com`
  - `outerbase__<runId>.proxy.iterate.com`

## Public control proof

```bash
BASE_URL=https://jonasland-sandbox.fly.dev

curl -fsS -X POST -H "content-type: application/json" \
  --data '{"json":{"target":"events"}}' \
  "$BASE_URL/_pidnap/rpc/processes/restart"

curl -fsS -X POST -H "content-type: application/json" \
  --data '{"json":{"target":"orders"}}' \
  "$BASE_URL/_pidnap/rpc/processes/restart"

curl -fsS "$BASE_URL/_events/healthz"
curl -fsS "$BASE_URL/_orders/healthz"
```

Caddy public routes:

- `/_pidnap/* -> 127.0.0.1:9876`
- `/_events/* -> 127.0.0.1:19010`
- `/_orders/* -> 127.0.0.1:19020`
- `pidnap__<runId>.proxy.iterate.com -> 127.0.0.1:9876`
- `events__<runId>.proxy.iterate.com -> 127.0.0.1:19010`
- `orders__<runId>.proxy.iterate.com -> 127.0.0.1:19020`
- `registry__<runId>.proxy.iterate.com -> 127.0.0.1:8777`
