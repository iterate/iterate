# semaphore

`apps/semaphore` is a tiny Cloudflare Worker for leasing shared resources.

It stores resource inventory in D1 and uses one Durable Object per resource `type` to coordinate active leases, waiters, and expiry.

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
- `data` is an arbitrary JSON object and is returned in full by `list` and `acquire`
- `leaseMs` is required
- `waitMs` defaults to `0`
- delete removes inventory immediately but does not revoke an active lease

## Deploy

Alchemy manages the Worker, D1 database, and Durable Object namespace.

- `pnpm --filter @iterate-com/semaphore-worker test`
- `pnpm --filter @iterate-com/semaphore-worker typecheck`
