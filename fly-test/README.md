# fly-test

Shared integration proof for HTTPS egress interception.

One scenario, three providers:

- `docker`
- `fly`
- `daytona`

Both run the same assertions.

## Contract

Scenario does:

1. sandbox fetch to allowed URL (`https://example.com/` by default)
2. verify response includes proof prefix in body (`__ITERATE_MITM_PROOF__`)
3. verify egress log includes MITM + transform markers
4. sandbox fetch to blocked URL (`https://iterate.com/`)
5. verify policy-block signal

## Run

Docker:

```bash
pnpm --filter fly-test e2e:docker
```

Manual Docker stack with host URLs:

```bash
APP=fly-test-manual
SANDBOX_HOST_PORT=38080 EGRESS_VIEWER_HOST_PORT=38081 TARGET_URL=https://example.com/ \
  docker compose -f fly-test/docker-compose.local.yml -p "$APP" up -d --build
```

- sandbox URL: `http://127.0.0.1:38080`
- egress URL: `http://127.0.0.1:38081`

WebSocket POC:

1. Open sandbox UI at `http://127.0.0.1:38080`.
2. In `Sandbox WebSocket Client`, keep target `wss://ws.ifelse.io`.
3. Set `Drop Contains=OFFENDING`, `Rewrite Server From=server-secret`, `Rewrite Server To=REDACTED`.
4. Click `Connect`.
5. Send `OFFENDING should be dropped` then send `normal hello`.
6. Confirm sandbox WS events show drop marker and rewritten server messages (`REDACTED: ...`).

Tail logs:

```bash
docker compose -f fly-test/docker-compose.local.yml -p "$APP" logs -f sandbox-ui
docker compose -f fly-test/docker-compose.local.yml -p "$APP" logs -f egress-proxy
```

Shutdown:

```bash
docker compose -f fly-test/docker-compose.local.yml -p "$APP" down -v
```

Fly:

```bash
doppler run --config dev -- pnpm --filter fly-test build:fly-images
doppler run --config dev -- pnpm --filter fly-test e2e:fly
```

Manual Fly stack (no auto-cleanup):

```bash
doppler run --config dev -- sh -lc 'APP_NAME=fly-test-manual E2E_CLEANUP_ON_EXIT=0 pnpm --filter fly-test e2e:fly'
```

Local URLs via fly proxy:

```bash
doppler run --config dev -- sh -lc 'export FLY_API_TOKEN="$FLY_API_KEY"; flyctl proxy 38080:8080 -a fly-test-manual'
doppler run --config dev -- sh -lc 'export FLY_API_TOKEN="$FLY_API_KEY"; flyctl proxy 38081:18081 -a fly-test-manual'
```

- sandbox URL: `http://127.0.0.1:38080`
- egress URL: `http://127.0.0.1:38081`

Tail logs:

```bash
doppler run --config dev -- sh -lc 'export FLY_API_TOKEN="$FLY_API_KEY"; flyctl machine list -a fly-test-manual --json | jq -r ".[] | .name + \" \" + .id"'
# use the ids from the previous command
doppler run --config dev -- sh -lc 'export FLY_API_TOKEN="$FLY_API_KEY"; flyctl machine exec <sandbox-id> "tail -n 200 -f /tmp/sandbox-ui.log" -a fly-test-manual'
doppler run --config dev -- sh -lc 'export FLY_API_TOKEN="$FLY_API_KEY"; flyctl machine exec <egress-id> "tail -n 200 -f /tmp/egress-proxy.log" -a fly-test-manual'
```

Destroy:

```bash
doppler run --config dev -- sh -lc 'export FLY_API_TOKEN="$FLY_API_KEY"; flyctl apps destroy fly-test-manual -y'
```

Daytona:

```bash
pnpm --filter fly-test e2e:daytona
```

Optional if your local Daytona session is not already logged in:

```bash
DAYTONA_API_KEY=... pnpm --filter fly-test e2e:daytona
```

Run with Daytona VPN-backed MITM path:

```bash
DAYTONA_TAILSCALE_AUTH_KEY=... pnpm --filter fly-test e2e:daytona
```

Manual Daytona stack (no auto-cleanup):

```bash
APP_NAME=fly-test-manual E2E_CLEANUP_ON_EXIT=0 pnpm --filter fly-test e2e:daytona
```

Daytona backend notes:

- Uses two Daytona sandboxes (`sandbox-ui`, `egress-proxy`) only.
- Default (`preview-direct`): uses signed preview URLs for sandbox->egress HTTP/WS calls.
- Optional (`tailscale-mitm`): set `DAYTONA_TAILSCALE_AUTH_KEY` to join both sandboxes to the same tailnet, then sandbox uses egress MITM port directly over private tailnet IP (full CA trust + proxy env bootstrap path).
- Uses `wss://ws.ifelse.io` as default WS upstream.
- Prints preview URLs to `summary.txt` artifact.

## Providers

- `fly-test/e2e/providers/docker.ts`
- `fly-test/e2e/providers/fly.ts`
- `fly-test/e2e/providers/daytona.ts`

Provider responsibilities: boot, sandbox fetch transport, log retrieval, teardown.

Scenario logic lives only in `fly-test/e2e/scenario.ts`.

## Images

Only two Dockerfiles:

- `fly-test/docker/egress.Dockerfile`
- `fly-test/docker/sandbox.Dockerfile`

## Artifacts

`fly-test/proof-logs/<app>/` contains:

- `summary.txt`
- `allowed-fetch-response.json`
- `blocked-fetch-response.json`
- `sandbox-ui.log`
- `egress-proxy.log`
