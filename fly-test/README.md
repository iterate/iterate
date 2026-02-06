# fly-test

Playground for proving HTTPS MITM on egress.

Supports two backends:

- `fly` (Fly Machines)
- `docker` (local Docker gateway + MITM interception modes)

## Layout

- `fly-test/e2e/run-observability.ts`: canonical runner (`E2E_BACKEND=fly|docker`)
- `fly-test/e2e/run-observability-docker.ts`: Docker backend runner
- `fly-test/e2e/run-observability.docker.test.ts`: Vitest Docker e2e
- `fly-test/mitm-go/go-mitm/main.go`: Go `goproxy` MITM daemon
- `fly-test/mitm-go/start.sh`: minimal Go MITM runtime command
- `fly-test/mitm-dump/start.sh`: minimal mitmdump runtime command (no Python addons)
- `fly-test/egress-proxy/server.ts`: Bun viewer + transform service
- `fly-test/public-http/server.mjs`: local deterministic upstream service
- `fly-test/sandbox/server.ts`: sandbox API/UI trigger
- `fly-test/docker-compose.local.yml`: local sandbox/gateway/egress topology
- `fly-test/docker/*.Dockerfile`: Docker images (sandbox/egress/gateway/public-http)
- `fly-test/docker/*-entrypoint.sh`: runtime setup scripts for Docker services

## MITM Setup Differences

Two side-by-side folders:

- `fly-test/mitm-go`
- `fly-test/mitm-dump`

What differs, where it applies:

| Area                     | `mitm-go`                                                     | `mitm-dump`                                                                               | Where it comes into play        |
| ------------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------- |
| Binary/runtime           | `fly-mitm` (custom Go binary)                                 | `mitmdump` (mitmproxy CLI)                                                                | image build + startup command   |
| Main config surface      | Go flags: `--listen --transform-url --ca-cert --ca-key --log` | CLI flags + mitmproxy confdir                                                             | process bootstrap               |
| CA material              | reads `ca.crt` + `ca.key` directly                            | expects mitmproxy CA files; `start.sh` maps same `ca.crt`/`ca.key` into mitmproxy confdir | TLS signing setup               |
| Node forwarding          | sends to `http://127.0.0.1:18081/transform`                   | reverse mode forwards decrypted traffic to Node listener                                  | request/response transform path |
| Custom logic location    | compiled Go code                                              | mostly runtime flags (no addon Python file)                                               | operational complexity          |
| Observable failure shape | Go process errors + health endpoint behavior                  | mitmdump startup/runtime errors, mode/flag mistakes                                       | incident/debug workflow         |

Setup-time split:

- Build-time: Go needs compile stage; dump needs mitmproxy runtime install.
- Boot-time: Go starts with fixed flags; dump needs CA file mapping into mitmproxy confdir first.
- Traffic-time: both terminate TLS and pass through Node transform path, but transport mode wiring differs.
- Debug-time: Go debugging is code-level; dump debugging is mostly CLI/mode/cert wiring.

## Fly Run

```bash
doppler run --config dev -- bash fly-test/scripts/build-runtime-image.sh
doppler run --config dev -- pnpm --filter fly-test e2e
```

## Docker Run

```bash
pnpm --filter fly-test e2e:docker
MITM_IMPL=go pnpm --filter fly-test e2e:docker
MITM_IMPL=dump pnpm --filter fly-test e2e:docker
```

This stack runs:

- `public-http` (local upstream test target)
- `sandbox-ui`
- `egress-proxy` (MITM + transform + viewer)
- `egress-gateway` (default route gateway + DNS logging + traffic metadata logging)
- `sandbox-tunnel`, `egress-tunnel` (Cloudflare tunnels)

Traffic model:

- sandbox default route points to `egress-gateway`
- Go path (`MITM_IMPL=go`): sandbox uses explicit proxy env `http://<gateway>:18080`
- Dump path (`MITM_IMPL=dump`): sandbox omits proxy env; gateway DNAT on TCP `80/443` captures traffic
- gateway DNATs sandbox TCP `18080` to egress MITM `:18080` (Go compatibility path)
- gateway logs DNS + TCP/UDP metadata

Local pages:

- sandbox: published dynamically by compose
- egress viewer + logs: published dynamically by compose
- local upstream test service: published dynamically by compose

Discover published host ports for a running project:

```bash
docker compose -f fly-test/docker-compose.local.yml -p <project> port sandbox-ui 8080
docker compose -f fly-test/docker-compose.local.yml -p <project> port egress-proxy 18081
docker compose -f fly-test/docker-compose.local.yml -p <project> port public-http 18090
```

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
