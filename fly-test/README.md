# fly-test

Fly Machines playground for proving HTTPS MITM on the egress machine.

## Layout

- `fly-test/e2e/run-observability.ts`: canonical e2e runner
- `fly-test/e2e/run-observability-lib.ts`: helper utilities
- `fly-test/e2e/run-observability.test.ts`: helper unit tests
- `fly-test/egress-proxy/go-mitm/main.go`: Go `goproxy` MITM daemon
- `fly-test/egress-proxy/server.ts`: Bun viewer + TS transform service
- `fly-test/egress-proxy/start.sh`: egress init (OpenSSL CA, Go build, Bun, tunnel)
- `fly-test/sandbox/server.ts`: sandbox API/UI that fetches direct HTTPS
- `fly-test/sandbox/start.sh`: sandbox init (trust CA, proxy env, Bun, tunnel)
- `fly-test/scripts/tail-egress-log.sh`: tail egress proxy log from host
- `fly-test/scripts/cleanup-all-machines.sh`: delete all machines in account/org

## Quick Run

```bash
doppler run --config dev -- pnpm --filter fly-test e2e
```

## What This Proves

The run provisions two machines and proves interception end-to-end:

1. Egress machine generates app CA (`openssl`, ECDSA P-256).
2. Sandbox installs and trusts that CA.
3. Sandbox outbound HTTPS uses `HTTP_PROXY`/`HTTPS_PROXY` -> egress MITM.
4. Go MITM decrypts request, calls local TS `/transform`.
5. TS fetches upstream and prepends proof bytes to response body.
6. Sandbox receives modified body and e2e asserts proof marker exists.
7. Egress logs include decrypted request + transform events.

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
