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
