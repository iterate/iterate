# fly-test

Fly Machines playground for proving HTTPS MITM on the egress machine.

## Layout

- `fly-test/e2e/run-observability.ts`: canonical e2e runner
- `fly-test/e2e/run-observability-lib.ts`: helper utilities
- `fly-test/e2e/run-observability.test.ts`: helper unit tests
- `fly-test/egress-proxy/go-mitm/main.go`: Go `goproxy` MITM daemon
- `fly-test/runtime-image.Dockerfile`: prebuilt runtime image (bun + cloudflared + fly-mitm)
- `fly-test/egress-proxy/server.ts`: Bun viewer + TS transform service
- `fly-test/egress-proxy/start.sh`: egress init (OpenSSL CA + service launch)
- `fly-test/sandbox/server.ts`: sandbox API/UI that fetches direct HTTPS
- `fly-test/sandbox/start.sh`: sandbox init (trust CA + proxy env)
- `fly-test/scripts/build-runtime-image.sh`: Depot build + push helper (Fly registry default)
- `fly-test/scripts/tail-egress-log.sh`: tail egress proxy log from host
- `fly-test/scripts/cleanup-all-machines.sh`: delete all machines in account/org

## Quick Run

```bash
doppler run --config dev -- bash fly-test/scripts/build-runtime-image.sh
doppler run --config dev -- pnpm --filter fly-test e2e
```

## One-time Setup (Doppler + Fly)

Required Doppler secrets in `dev`:

- `FLY_API_KEY`
- `DEPOT_TOKEN`
- `DEPOT_PROJECT_ID`
- `FLY_ORG` (default: `iterate`)
- `FLY_TEST_RUNTIME_APP` (default: `iterate-node-egress-runtime`)

Build/push runtime image to Fly registry (default):

```bash
doppler run --config dev -- bash fly-test/scripts/build-runtime-image.sh
```

Optional: push to Depot registry instead:

```bash
doppler run --config dev -- env RUNTIME_IMAGE_REGISTRY=depot bash fly-test/scripts/build-runtime-image.sh
```

Platform: use `linux/amd64` (default). Override via `RUNTIME_IMAGE_PLATFORM`.

## What This Proves

The run provisions two machines and proves interception end-to-end:

1. Build runtime image with Depot and push to registry (Fly registry by default).
2. Egress machine generates app CA (`openssl`, ECDSA P-256).
3. Sandbox installs and trusts that CA.
4. Sandbox outbound HTTPS uses `HTTP_PROXY`/`HTTPS_PROXY` -> egress MITM.
5. Go MITM decrypts request, streams request to local TS `/transform`.
6. TS streams upstream response back and adds `x-iterate-mitm-proof: 1`.
7. Sandbox receives modified response header and e2e asserts proof marker exists.
8. Egress logs include decrypted request + transform events.

Artifacts land in:

```bash
fly-test/proof-logs/<app-name>/
```

## Useful Commands

Typecheck + unit tests:

```bash
pnpm --filter fly-test typecheck
pnpm --filter fly-test test
```

Tail egress log:

```bash
doppler run --config dev -- pnpm --filter fly-test tail:egress-log <app-name> egress-proxy
```

Cleanup:

```bash
doppler run --config dev -- pnpm --filter fly-test cleanup:all-machines
```
