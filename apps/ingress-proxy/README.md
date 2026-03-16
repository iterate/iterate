# ingress-proxy

`apps/ingress-proxy` is a tiny Cloudflare Worker that stores one canonical
route row per public project ingress host and proxies requests to the current
upstream target.

## Contract split

- `apps/ingress-proxy-contract` owns the shared oRPC contract, route schema,
  and generated `openapi.json`
- `apps/ingress-proxy` implements that contract, stores routes in D1, and
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
- `pnpm run db:migrate`

`db:types` updates both `sql/queries.ts` and `sql/schema.sql`.

## Tests

- `proxy.test.ts` covers the pure proxy helpers
- `live-e2e.test.ts` runs against a deployed worker and exercises the real API
  and public proxy behavior

## Deploy and verify

CI workflows for this app were intentionally removed during the simplification.
For now, deploys, migrations, and live verification are managed manually.

Typical manual flow:

- `pnpm -C apps/ingress-proxy run db:types`
- `doppler run -- pnpm -C apps/ingress-proxy run db:migrate`
- `doppler run -- pnpm -C apps/ingress-proxy run deploy`
- `doppler run --preserve-env=INGRESS_PROXY_E2E_BASE_URL,INGRESS_PROXY_E2E_PROXY_BASE_DOMAIN -- pnpm -C apps/ingress-proxy run test:e2e-live`
