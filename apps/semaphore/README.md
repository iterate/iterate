# semaphore

`apps/semaphore` is a tiny Cloudflare Worker for leasing shared resources.

It stores resource inventory in D1 and uses one Durable Object per resource `type` to coordinate active leases, waiters, and expiry.

Consumers should use `@iterate-com/semaphore-contract` for the shared oRPC contract and `createSemaphoreClient`.

## API

All endpoints require `Authorization: Bearer <SEMAPHORE_API_TOKEN>`.

- `resources.add({ type, slug, data })`
- `resources.delete({ type, slug })`
- `resources.list({ type? })`
- `resources.acquire({ type, leaseMs, waitMs? })`
- `resources.release({ type, slug, leaseId })`

## Model

- Resource identity is `{ type, slug }`
- `slug` is unique within a `type`
- `data` is a JSON-serializable object and is returned in full by `list` and `acquire`
- `leaseMs` is required and capped at `3600000`
- `waitMs` defaults to `0` and is capped at `300000`
- delete removes inventory immediately but does not revoke an active lease
- waiting acquires are best-effort in v1; if a waiting client disconnects after the DO grants a lease, that lease may stay live until expiry

## Deploy

Alchemy manages the Worker, D1 database, and Durable Object namespace.

## Local Commands

- `pnpm --filter @iterate-com/semaphore test`
- `pnpm --filter @iterate-com/semaphore typecheck`
- `pnpm --filter @iterate-com/semaphore test:e2e`
- `pnpm --filter @iterate-com/semaphore test:e2e-live`

`test:e2e` boots the real Worker through Alchemy dev and expects the local Doppler and Cloudflare dev credentials path to be available.

`test:e2e-live` runs against an already-deployed worker using `SEMAPHORE_E2E_BASE_URL` and `SEMAPHORE_E2E_API_TOKEN` (or `SEMAPHORE_API_TOKEN`).

## CI

- PRs and `main` pushes only trigger the semaphore live deploy/test workflow when `apps/semaphore/**` or its workflow files change.
- The live workflow deploys an ephemeral worker, runs `test:e2e-live`, then tears the worker down.
- `main` runs that same live flow before deploying the production semaphore worker.
