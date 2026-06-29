# Semaphore app

Cloudflare-only: TanStack Start + oRPC + sqlfu/D1 inventory storage, with a Durable Object coordinator per resource type.

## Stack

- **API:** oRPC over OpenAPI/HTTP at `/api`
- **Frontend:** TanStack Start + Router + Query
- **DB:** sqlfu-generated D1 query wrappers (`sql/.generated/`)
- **Coordinator:** one Durable Object per resource `type` handles active leases, waiters, and expiry
- **Secrets:** Doppler project `semaphore` (see repo `doppler.yaml`). `DOPPLER_CONFIG` is injected by `doppler run`, and `_shared` defines `ALCHEMY_STAGE=${DOPPLER_CONFIG}`. The bearer/operator token is `APP_CONFIG.sharedApiSecret`; callers can expose the same value as `SEMAPHORE_API_TOKEN`.

## Key files

- `alchemy.run.ts` — Alchemy app + D1 + Durable Object + TanStackStart
- `vite.config.ts` — Alchemy Cloudflare TanStack Start plugin; optional `PORT` for dev
- `src/worker.ts` — Worker fetch + `withEvlog`
- `src/config.ts` — `AppConfig` schema + `parseConfig`
- `src/request-context.ts` — per-request `RequestContext` (`config`, `db`, `log`, `rawRequest`)
- `src/durable-objects/resource-coordinator.ts` — lease orchestration, alarms, and waiter dispatch
- `src/lib/resource-store.ts` — D1-backed resource reads/writes and lease-state mirroring
- `definitions.sql`, `migrations/`, `sql/queries.sql`, `sqlfu.config.ts` — sqlfu schema, migration history, query sources, and config
- `src/contract.ts` — oRPC contract, schemas, and client helper
- `src/orpc/*` — contract implementation + handlers

## Scripts

```bash
pnpm cli          # doppler + app CLI commands
pnpm dev          # doppler + Alchemy local (Vite); optional PORT= for fixed port; Ctrl+C to stop
pnpm build        # production client/server bundle
pnpm deploy       # deploy prd through Doppler and alchemy.run.ts
pnpm seed:environment-config-leases
pnpm sqlfu:generate
pnpm sqlfu:check
pnpm test         # typecheck only
pnpm test:e2e     # requires `SEMAPHORE_BASE_URL`
```

## Environment config leases for PR previews

Semaphore owns the environment config lease inventory used by PR previews. The repo-root preview CLI usually runs through the shared production Doppler config:

```bash
doppler run --project _shared --config prd -- pnpm preview status
```

The preview CLI reads `SEMAPHORE_API_TOKEN` first and falls back to `APP_CONFIG_SHARED_API_SECRET`. To seed or repair the preview inventory from this package, run:

```bash
doppler run --project semaphore --config prd -- pnpm --dir apps/semaphore seed:environment-config-leases
```

The browser UI calls this value the operator token. Do not copy the token into source files, docs, or PR comments.

## Contract

`src/contract.ts` contains the oRPC contract, schemas, and local client helper.

## Deploy

Use the raw lifecycle scripts with Doppler outside the package script:

- `doppler run --project semaphore --config preview_2 -- pnpm exec tsx ./alchemy.run.ts`
- `doppler run --project semaphore --config prd -- pnpm exec tsx ./alchemy.run.ts`
- `doppler run --project semaphore --config preview_2 -- pnpm exec tsx ./alchemy.run.ts --destroy`
- `doppler run --project semaphore --config prd -- pnpm exec tsx ./alchemy.run.ts --destroy`
