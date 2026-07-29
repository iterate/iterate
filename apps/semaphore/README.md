# Semaphore app

Cloudflare-only: TanStack Start + oRPC + sqlfu/D1 inventory storage, with a Durable Object coordinator per resource type.

## Stack

- **API:** oRPC over OpenAPI/HTTP at `/api`
- **Frontend:** TanStack Start + Router + Query
- **DB:** sqlfu-generated D1 query wrappers (`sql/.generated/`)
- **Coordinator:** one Durable Object per resource `type` handles active leases, waiters, and expiry
- **Secrets:** Doppler project `semaphore` (see repo `doppler.yaml`)

## Auth

Semaphore sits behind the same apps/auth relying-party auth as apps/os — there
is no shared API secret. Two credential lanes, both requiring an **iterate
admin** identity:

- **Browser:** sign in via `/api/iterate-auth/login` (OIDC against the env's
  auth worker); the dashboard and its server functions use the
  `iterate_session` cookie.
- **API/CLI:** `Authorization: Bearer <access token>`, verified as a JWT
  against Auth's Doppler-derived public signing key. CLIs
  mint admin tokens offline with the config's `AUTH_FORGE_ES256_PRIVATE_JWK`
  (`scripts/auth/semaphore-token.ts`, same mechanism as `pnpm auth:mint`), or
  accept a pre-minted token via `SEMAPHORE_API_TOKEN`.

Provisioning: `pnpm preview provision-auth-preview-configs` seeds the preview
slots (OAuth client + forge key per `semaphore/preview_N` Doppler config);
`pnpm --dir apps/semaphore sync-auth-client` (run under
`doppler run --project auth --config prd`) does the same for prd, including
mirroring the forge key into `_shared/prd` for the repo-root preview CLI.
Local dev sign-in needs `APP_CONFIG_ITERATE_AUTH__*` keys in `semaphore/dev`
(and a baked `APP_CONFIG_ITERATE_AUTH__JWKS` for forge-minted bearers).

## Key files

- `wrangler.jsonc` — GENERATED from the root `envs.ts` by `scripts/generate-wrangler-config.ts`; top level is local dev, env blocks are the deployed environments
- `scripts/deploy.ts` — deploy an env (`--env prd`/`--env preview_N`): secret verification, D1 migrations, `vite build`, `wrangler deploy --secrets-file`, smoke
- `scripts/ensure-resources.ts` — create-only DNS bring-up for a new env
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

The preview CLI authenticates with a forge-minted admin bearer token (or an
explicit `SEMAPHORE_API_TOKEN`) — see the Auth section. To seed or repair the
preview inventory from this package, run:

```bash
doppler run --project semaphore --config prd -- pnpm --dir apps/semaphore seed:environment-config-leases
```

## Dashboard

The signed-in dashboard at `/resources/` shows the preview-slot fleet as a
grid sorted by most recent activity: card color is lease state (amber =
leased, green = available), and each card carries the holder (linked to its
PR), lease expiry, last acquired/released times, per-app links, and an
expandable raw JSON view. Two operator actions run against the coordinator:

- **Release** (leased slots) — confirm-gated; evicts the current lease.
- **Claim for PR…** (available slots) — records a `pr-<n>` holder with the
  standard 24h preview lease, the dashboard equivalent of
  `pnpm preview acquire`. Claiming marks ownership so CI will not deploy
  over the slot; deploying to it remains the PR flow's job.

## Contract

`src/contract.ts` contains the oRPC contract, schemas, and local client helper.

## Deploy

Deploys are wrangler-native, driven by the root `envs.ts` (see
`docs/devops-cloudflare-doppler.md`):

- `pnpm deploy --env prd`
- `pnpm deploy --env preview_3`
- `pnpm infra deploy --env preview_9` from the repo root — create the stage's
  Alchemy D1/KV/R2 stack and generated manifest
- `pnpm ensure-resources --env preview_9` — create the Semaphore DNS record

**CAUTION:** `semaphore-prd`'s `ResourceCoordinator` Durable Object holds the
live preview-slot lease state for the whole fleet. Always deploy over it;
never delete the worker or erase its storage. Semaphore has no data-erasure
command; its preview e2e generates per-run-unique resource types and
self-cleans.
