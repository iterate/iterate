# ingress-proxy-worker

`apps/ingress-proxy-worker` is a tiny Cloudflare Worker that stores one canonical
route row per public project ingress host and proxies requests to the current
upstream target.

## Contract split

- `apps/ingress-proxy-contract` owns the shared oRPC contract, route schema,
  and generated `openapi.json`
- `apps/ingress-proxy-worker` implements that contract, stores routes in D1, and
  handles fallback proxying for public hosts

## API

All route-management endpoints require `Authorization: Bearer <INGRESS_PROXY_API_TOKEN>`.

- `routes.upsert`
- `routes.get`
- `routes.list`
- `routes.remove`

OpenAPI is exposed from the Worker at:

- `/api/openapi.json`
- `/api/docs`

## Data model

One table:

- `ingress_proxy_route`
  - `id TEXT PRIMARY KEY`
  - `root_host TEXT NOT NULL UNIQUE`
  - `target_url TEXT NOT NULL`
  - `metadata_json TEXT NOT NULL DEFAULT '{}'`
  - timestamps

`root_host` is the canonical deployment host and maps to `ITERATE_INGRESS_HOST`.
Alternate public host shapes are derived at request time from
`ITERATE_INGRESS_ROUTING_TYPE`.

## SQL workflow

- `sql/migrations/*.sql` is the migration history
- `sql/schema.sql` is the generated current-state schema dump
- `sql/queries.sql` is the query source
- `sql/queries.ts` is generated from TypeSQL

Commands:

- `pnpm run db:rebuild`
- `pnpm run db:types`
- `pnpm run db:watch`

`db:types` updates both `sql/queries.ts` and `sql/schema.sql`.

## Tests

- `proxy.test.ts` covers the pure proxy helpers
- `live-e2e.test.ts` runs against a deployed worker and exercises the real API
  and public proxy behavior

## Deploy and verify

CI workflows for this app were intentionally removed during the simplification.
For now, deploys, migrations, and live verification are managed manually.

## Env

`alchemy.run.ts` uses `env-schema.ts` for the ingress-proxy app-specific env contract:

- `WORKER_ROUTES`
- `INGRESS_PROXY_API_TOKEN`
- `TYPEID_PREFIX`

Only `INGRESS_PROXY_API_TOKEN` and `TYPEID_PREFIX` become runtime Worker bindings.
`WORKER_ROUTES` is parsed by `alchemy.run.ts` and used only to attach Cloudflare
Worker routes.

Deploy-time Alchemy env vars are parsed in `alchemy.run.ts`:

- `ALCHEMY_PASSWORD`
- `ALCHEMY_LOCAL`
- `ALCHEMY_STAGE`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

`WORKER_ROUTES` is a comma-separated list of Cloudflare Worker route patterns.

## Deploy and verify

Typical manual flow:

- `pnpm -C apps/ingress-proxy-worker run db:types`
- `pnpm -C apps/ingress-proxy-worker run deploy`
- `doppler run --preserve-env=INGRESS_PROXY_E2E_BASE_URL,INGRESS_PROXY_E2E_PROXY_BASE_DOMAIN -- pnpm -C apps/ingress-proxy-worker run test:e2e-live`

`alchemy.run.ts` is the handwritten source of truth. It also generates a local
`wrangler.json` file mostly for debugging and compatibility. That generated file
is an artifact and should not be checked into Git.

This app relies on a per-directory Doppler setup for `apps/ingress-proxy-worker`.
`doppler.yaml` in the repo declares that this path should use the
`ingress-proxy` project, and `doppler setup` writes the actual scoped config
that `doppler run` uses later.
