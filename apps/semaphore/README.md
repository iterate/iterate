# Semaphore app

Cloudflare-only: TanStack Start + oRPC + raw D1 inventory storage, with a Durable Object coordinator per resource type.

## Stack

- **API:** oRPC over OpenAPI/HTTP at `/api`
- **Frontend:** TanStack Start + Router + Query
- **DB:** raw D1 queries via generated TypeSQL helpers (`sql/queries.ts`)
- **Coordinator:** one Durable Object per resource `type` handles active leases, waiters, and expiry
- **Secrets:** Doppler project `semaphore` (see repo `doppler.yaml`). `DOPPLER_CONFIG` is injected by `doppler run`, and `_shared` defines `ALCHEMY_STAGE=${DOPPLER_CONFIG}`. The bearer token now lives in root-level `APP_CONFIG.sharedApiSecret`.

## Key files

- `alchemy.run.ts` — Alchemy app + D1 + Durable Object + TanStackStart
- `vite.config.ts` — Alchemy Cloudflare TanStack Start plugin; optional `PORT` for dev
- `src/entry.workerd.ts` — Worker fetch + `withEvlog`
- `src/context.ts` — `manifest`, `config`, `env`, `db`, `log`
- `src/durable-objects/resource-coordinator.ts` — lease orchestration, alarms, and waiter dispatch
- `src/lib/resource-store.ts` — D1-backed resource reads/writes and lease-state mirroring
- `src/orpc/*` — contract binding + handlers

## Scripts

```bash
pnpm cli          # doppler + iterate local-router commands
pnpm dev          # doppler + Alchemy local (Vite); optional PORT= for fixed port; Ctrl+C to stop
pnpm build        # production client/server bundle
pnpm deploy       # `doppler run --config prd` — `_shared` resolves `ALCHEMY_STAGE=prd`
pnpm seed:tunnel-pool
pnpm test         # typecheck only; worker-backed Vitest needs `pnpm test:workers`
pnpm test:workers
pnpm test:e2e     # requires `SEMAPHORE_BASE_URL`
```

## Contract

[`apps/semaphore-contract`](../semaphore-contract) — `src/orpc/orpc.ts` implements it.
