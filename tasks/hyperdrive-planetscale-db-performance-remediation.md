---
state: backlog
priority: high
size: medium
dependsOn: []
tags:
  - database
  - performance
  - cloudflare
  - planetscale
---

# Migrate OS runtime DB path to Hyperdrive and add placement hints

Frame this work as database performance remediation:

- reduce connection pressure / slot exhaustion risk
- improve p95/p99 request latency for DB-heavy routes
- align runtime architecture with current Cloudflare + PlanetScale guidance

## Why now

- Current runtime path in `apps/os/backend/db/client.ts` depends on `DATABASE_URL` and does not use Hyperdrive.
- Worker code (`apps/os/backend/worker.ts`) creates DB clients in request middleware and scheduled handlers; under load this increases connection pressure.
- Repo has no `HYPERDRIVE` binding today.
- Cloudflare now supports explicit Placement Hints for running Workers near backend infrastructure.

## Scope

1. Provision Hyperdrive for staging + production

- Configure PlanetScale origin.
- Set `caching.disabled = true` (explicitly no query caching for now).

2. Add Hyperdrive binding in infrastructure

- Update `apps/os/alchemy.run.ts` to create/bind Hyperdrive to the OS Worker/TanStackStart resource.
- Keep `DATABASE_URL` for migrations and scripts.

3. Support local Hyperdrive dev mode

- Configure local Hyperdrive origin for Miniflare/Alchemy dev to local docker Postgres.
- Keep local workflow intact while matching production runtime code path.

4. Refactor runtime DB client factory

- Replace direct-only `getDb()` path with env-aware runtime factory:
  - prefer `env.HYPERDRIVE.connectionString`
  - fallback `env.DATABASE_URL` for compatibility
- Keep Drizzle call sites unchanged.

5. Wire worker runtime to new DB factory

- Update request middleware + scheduled handlers in `apps/os/backend/worker.ts`.
- Add lightweight logs for selected DB mode (`hyperdrive` vs `direct`) without leaking secrets.

6. Add placement hints near database

- In `apps/os/alchemy.run.ts`, set Worker placement for DB proximity:
  - primary: `placement.host` for PlanetScale host:5432
  - fallback: `placement.region` if stable region mapping is preferred
  - alternative: `placement.mode = "smart"` when topology uncertainty exists
- Validate behavior using `cf-placement` header.

7. Rollout and validation

- Staging first, then production.
- Validate:
  - Hyperdrive binding active
  - runtime uses Hyperdrive path
  - query cache disabled
  - lower DB connection pressure / fewer 5xx on `getEnv` and `reportStatus`
  - improved latency on DB-heavy routes

## Notes / cautions

- Keep migration/admin connections direct (`PSCALE_DATABASE_URL`) unless later explicitly changed.
- `placement.host` is experimental per Cloudflare docs; be ready to switch to `placement.region` or `mode: smart`.
- Hyperdrive dev support is available in Alchemy/Miniflare but marked experimental in docs.
