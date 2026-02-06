# fly-test

Shared integration proof for HTTPS egress interception.

One scenario, two providers:

- `docker`
- `fly`

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

Fly:

```bash
doppler run --config dev -- pnpm --filter fly-test build:fly-images
doppler run --config dev -- pnpm --filter fly-test e2e:fly
```

## Providers

- `fly-test/e2e/providers/docker.ts`
- `fly-test/e2e/providers/fly.ts`

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
