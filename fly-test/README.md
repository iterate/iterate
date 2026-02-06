# fly-test

Playground for proving HTTPS MITM on egress.

Supports two backends:

- `fly` (Fly Machines)
- `docker` (local Docker gateway + explicit proxy mode)

## Layout

- `fly-test/e2e/run-observability.ts`: canonical runner (`E2E_BACKEND=fly|docker`)
- `fly-test/e2e/run-observability-docker.ts`: Docker backend runner
- `fly-test/e2e/run-observability.docker.test.ts`: Vitest Docker e2e
- `fly-test/egress-proxy/go-mitm/main.go`: Go `goproxy` MITM daemon
- `fly-test/egress-proxy/server.ts`: Bun viewer + transform service
- `fly-test/public-http/server.mjs`: local deterministic upstream service
- `fly-test/sandbox/server.ts`: sandbox API/UI trigger
- `fly-test/docker-compose.local.yml`: local sandbox/gateway/egress topology
- `fly-test/docker/*.Dockerfile`: Docker images (sandbox/egress/gateway/public-http)
- `fly-test/docker/*-entrypoint.sh`: runtime setup scripts for Docker services

## Fly Run

```bash
doppler run --config dev -- bash fly-test/scripts/build-runtime-image.sh
doppler run --config dev -- pnpm --filter fly-test e2e
```

## Docker Run

```bash
pnpm --filter fly-test e2e:docker
```

This stack runs:

- `public-http` (local upstream test target)
- `sandbox-ui`
- `egress-proxy` (MITM + transform + viewer)
- `egress-gateway` (default route gateway + DNS logging + traffic metadata logging)
- `sandbox-tunnel`, `egress-tunnel` (Cloudflare tunnels)

Traffic model:

- sandbox default route points to `egress-gateway`
- sandbox uses explicit proxy env to gateway `http://<gateway>:18080`
- gateway DNATs sandbox TCP `18080` to egress MITM `:18080`
- gateway still has fallback DNAT for sandbox TCP `80/443`
- gateway logs DNS + TCP/UDP metadata

Local pages:

- sandbox: `http://localhost:38080`
- egress viewer + logs: `http://localhost:38081`
- local upstream test service: `http://localhost:38090`

## Introspection Demo

Trigger from sandbox through MITM to local upstream:

```bash
curl --data 'url=http://public-http:18090/' http://127.0.0.1:38080/api/fetch
curl --data 'url=http://public-http:18090/text' http://127.0.0.1:38080/api/fetch
curl --data 'url=http://public-http:18090/html' http://127.0.0.1:38080/api/fetch
curl --data 'url=http://public-http:18090/slow?ms=9000' http://127.0.0.1:38080/api/fetch
curl --data 'url=https://iterate.com/' http://127.0.0.1:38080/api/fetch
```

Read introspection logs:

```bash
curl 'http://127.0.0.1:38081/api/tail?lines=120'
```

Look for:

- `INSPECT_REQUEST` (request headers/body preview)
- `INSPECT_RESPONSE` (response headers/body preview)
- `TRANSFORM_OK` / `TRANSFORM_TIMEOUT` / `TRANSFORM_ERROR`

Response mutation markers:

- `x-iterate-mitm-proof: 1`
- `x-iterate-mitm-request-id: <id>`
- `x-iterate-mitm-body-modified: html-comment-prefix|text-prefix|none`

Policy deny example:

- destination `https://iterate.com/` (and `*.iterate.com`) is blocked in egress transform
- returns status `451` with error page containing `policy violation`
- log line: `POLICY_BLOCK ... rule="deny-iterate.com"`

## Browser Demo

1. Open `http://localhost:38080` (sandbox) and `http://localhost:38081` (egress viewer) side by side.
2. In sandbox, click:
   - local Docker mode: `GET JSON /`, `GET Text /text (mutated)`, `GET HTML /html (mutated)`, `POST Echo /echo`, `GET Slow /slow?ms=9000 (timeout demo)`, `GET Blocked iterate.com (policy)`
   - Fly mode: `GET example.com (allowed)`, `GET Blocked iterate.com (policy)`
3. In egress viewer, set filter to:
   - `INSPECT only` for request/response introspection
   - `TRANSFORM only` for transform lifecycle
   - `Errors only` for timeout/error paths

## Docker Vitest Proof

```bash
pnpm --filter fly-test test:e2e:docker
```

## Useful Commands

```bash
pnpm --filter fly-test typecheck
pnpm --filter fly-test test
pnpm --filter fly-test docker:up
pnpm --filter fly-test docker:down
pnpm --filter fly-test docker:build
doppler run --config dev -- pnpm --filter fly-test cleanup:all-machines
```
