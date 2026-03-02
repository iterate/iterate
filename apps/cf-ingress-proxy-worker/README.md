# ingress-proxy worker

`apps/cf-ingress-proxy-worker` is a tiny programmable ingress proxy on Cloudflare Workers.

It maps inbound host patterns to upstream targets stored in D1, then forwards HTTP/WebSocket traffic transparently.

## Why this exists

For ephemeral environments (E2E runs, agent sandboxes, preview stacks), we need many public hostnames quickly without provisioning per-host DNS + TLS each time.

Pattern:

```text
*.ingress.iterate.com CNAME -> ingress-proxy worker
```

With wildcard DNS/TLS already available in Cloudflare, this also works for CNAME-driven setups and future subdomain patterns like iterate.app project hostnames.

## Design constraints

- Transparent by default: preserve inbound `Host`, headers, body stream, and WebSocket upgrades.
- Optional per-pattern header overrides for exceptional auth/routing cases.
- Hostname tokens are opaque: this service does not interpret `__`, ports, or service names.
- Conflict-safe writes: duplicate patterns across different routes are rejected with typed conflict errors.

## Data model

Two tables:

- `routes`
  - route group metadata
  - stable external `routeId` (typeid)
- `route_patterns`
  - child rows for each pattern -> target (+ optional headers)
  - `ON DELETE CASCADE`

## SQL + schema workflow

- `schema.sql` is the canonical full schema.
- `migrations/*.sql` are hand-written migration steps for D1.
- `sql/*.sql` are query sources for TypeSQL.
- `sql/*.ts` are generated, committed wrappers (`client: "d1"`) with zero runtime ORM overhead.

Commands:

- `pnpm run db:rebuild` rebuilds local `.local.db` from `schema.sql`.
- `pnpm run db:types` rebuilds `.local.db` and regenerates `sql/*.ts`.
- `pnpm run db:watch` runs TypeSQL in watch mode.

When changing schema:

1. update `schema.sql`
2. add a new migration in `migrations/`
3. run `pnpm run db:types`
4. commit schema, migration, `.sql` query changes, and generated `sql/*.ts`

## Guardrails (read before editing)

- Do not hand-edit generated files in `sql/*.ts`.
- `sql/*.sql` is the source for query codegen; always run `pnpm run db:types` after SQL edits.
- `schema.sql` is canonical for TypeSQL introspection; migrations are canonical for remote D1 rollout. Keep both aligned.
- If `schema.sql` changes without a migration, deploys can succeed with stale remote schema assumptions.
- If a migration changes without updating `schema.sql`, generated query types can become wrong for new schema state.
- Resolver match ordering is critical:
  - exact pattern must beat wildcard
  - longer/more-specific wildcard must beat shorter wildcard
  - preserve this when editing `select-resolved-route-by-host.sql`
- Write-path internals (`createRoute`/`updateRoute`) are admin-only. Proxy request latency depends on resolver path (`resolveRoute`), not route-management calls.

## Safe change checklist

From repo root:

```bash
pnpm -C apps/cf-ingress-proxy-worker run db:types
pnpm --filter @iterate-com/cf-ingress-proxy-worker typecheck
pnpm --filter @iterate-com/cf-ingress-proxy-worker test
```

For routing behavior changes (matching order, forwarding semantics), also run live E2E:

```bash
INGRESS_PROXY_E2E_BASE_URL=<https://...workers.dev> \
INGRESS_PROXY_E2E_API_TOKEN=<token> \
pnpm --filter @iterate-com/cf-ingress-proxy-worker test:e2e-live
```

## Admin API (oRPC)

All endpoints require `Authorization: Bearer <INGRESS_PROXY_API_TOKEN>`.

- `createRoute`
- `updateRoute`
- `deleteRoute`
- `getRoute`
- `listRoutes`

`createRoute`/`updateRoute` accept:

- `metadata?: Record<string, unknown>`
- `patterns: Array<{ pattern: string; target: string; headers?: Record<string, string> }>`

## Env validation

`env.ts` declares the worker env contract using Zod and throws on invalid config.

- required: `DB`, `INGRESS_PROXY_API_TOKEN`
- defaulted (non-secret): `TYPEID_PREFIX` (default `ipr`)

## Deploy

Alchemy manages worker + D1 resources.

- set `WORKER_NAME` before running `alchemy.run.ts`
- worker name: `<WORKER_NAME>`
- D1 name: `<WORKER_NAME>-routes`
- D1 schema applied via `migrations/`
- deploy scripts:
  - `pnpm run dev` (dev stage)
  - `pnpm run deploy:prd` (prod)

## Tests

- SQLite-backed unit tests for conflict/matching internals.
- E2E-style worker tests for API and proxy behavior.
- Live deployment E2E (Vitest):
  - `INGRESS_PROXY_E2E_BASE_URL=<https://...workers.dev> INGRESS_PROXY_E2E_API_TOKEN=<token> pnpm --filter @iterate-com/cf-ingress-proxy-worker test:e2e-live`
  - Covers exact vs wildcard priority, wildcard specificity, create/update conflict paths, and self-update behavior.

## TODO (explicitly deferred)

Pattern lookup optimization is intentionally deferred. Current matching prioritizes correctness and simplicity; optimize query narrowing later if route cardinality warrants it.

- Add route TTL/expiry support (schema + API + resolver semantics + dedicated E2E coverage).
