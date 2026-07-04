# Semaphore app

Cloudflare-only: TanStack Start + oRPC + sqlfu/D1 inventory storage, with a Durable Object coordinator per resource type.

## Stack

- **API:** oRPC over OpenAPI/HTTP at `/api`
- **Frontend:** TanStack Start + Router + Query
- **DB:** sqlfu-generated D1 query wrappers (`sql/.generated/`)
- **Coordinator:** one Durable Object per resource `type` handles active leases, waiters, and expiry
- **Secrets:** Doppler project `semaphore` (see repo `doppler.yaml`). The bearer/operator token is `APP_CONFIG_SHARED_API_SECRET`; callers can expose the same value as `SEMAPHORE_API_TOKEN`.

## Key files

- `wrangler.jsonc` — GENERATED from the root `envs.ts` by `scripts/generate-wrangler-config.ts`; top level is local dev, env blocks are the deployed environments
- `scripts/deploy.ts` — deploy an env (`--env prd`/`--env preview_N`): secret verification, D1 migrations, `vite build`, `wrangler deploy --secrets-file`, smoke
- `scripts/ensure-resources.ts` — create-only D1 + DNS bring-up for a new env
- `vite.config.ts` — `@cloudflare/vite-plugin` + TanStack Start; optional `PORT` for dev
- `src/worker.ts` — Worker fetch + `withEvlog`
- `src/config.ts` — `AppConfig` schema + `parseConfig`
- `src/env.ts` — the worker's binding contract (`DB`, `RESOURCE_COORDINATOR`)
- `src/request-context.ts` — per-request `RequestContext` (`config`, `db`, `log`, `rawRequest`)
- `src/durable-objects/resource-coordinator.ts` — lease orchestration, alarms, and waiter dispatch
- `src/lib/resource-store.ts` — D1-backed resource reads/writes and lease-state mirroring
- `definitions.sql`, `migrations/`, `sql/queries.sql`, `sqlfu.config.ts` — sqlfu schema, migration history, query sources, and config
- `src/contract.ts` — oRPC contract, schemas, and client helper
- `src/orpc/*` — contract implementation + handlers

## Scripts

```bash
pnpm cli          # doppler + app CLI commands
pnpm dev          # doppler + vite dev in workerd; optional PORT= for fixed port; Ctrl+C to stop
pnpm build        # production client/server bundle
pnpm deploy --env prd   # deploy an environment (see Deploy below)
pnpm gen:wrangler # regenerate wrangler.jsonc from the root envs.ts
pnpm seed:environment-config-leases
pnpm sqlfu:generate
pnpm sqlfu:check
pnpm sqlfu:migrate # apply migrations to the local dev D1
pnpm test         # typecheck only
pnpm test:e2e     # requires `SEMAPHORE_BASE_URL`
```

## Environment config leases for PR previews

Semaphore owns the environment config lease inventory used by PR previews.
Leases record a `holder` (`pr-1234` from the PR flow, `manual-<user>` from
`pnpm preview acquire`) so every slot is attributable, and acquire-specific/
release take an explicit `force` flag for human overrides — evictions are
logged events (`evicted`, `force-released`), never implicit. The repo-root
preview CLI usually runs through the shared production Doppler config:

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

Deploys are wrangler-native, driven by the root `envs.ts` (see
`docs/devops-cloudflare-doppler.md`):

- `pnpm deploy --env prd`
- `pnpm deploy --env preview_3`
- `pnpm ensure-resources --env preview_9` — bring up a new env's D1 + DNS, then paste the printed IDs into the root `envs.ts`

**CAUTION:** `semaphore-prd`'s `ResourceCoordinator` Durable Object holds the
live preview-slot lease state for the whole fleet. Always deploy over it;
never delete the worker or erase its storage. `pnpm destroy` is deliberately
a no-op — semaphore's preview e2e generates per-run-unique resource types and
self-cleans.
