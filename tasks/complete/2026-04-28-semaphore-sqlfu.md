---
state: done
priority: high
size: medium
---

# Move semaphore to SQLFu

Status summary: implemented, merged with current `main`, and verified. Semaphore now uses SQLFu for D1 resource storage and ResourceCoordinator Durable Object SQLite storage, with one `queries.sql` file per SQLFu project. No known missing pieces remain.

## Goal

Move `apps/semaphore` to SQLFu, matching the direction already taken by `apps/events`.

## Assumptions

- This should remove Semaphore's local TypeSQL/custom generated-query path, not merely add SQLFu alongside it.
- The D1 resource inventory database should use SQLFu definitions, migrations, query files, and generated query modules.
- The `ResourceCoordinator` Durable Object should also use SQLFu for its per-object SQLite schema and query helpers, similar to `apps/events/src/durable-objects`.
- Runtime behavior should stay the same: Durable Objects remain authoritative for active leases, while D1 mirrors inventory and current lease state for operator visibility.

## Checklist

- [x] Add SQLFu config and SQL files for the semaphore D1 resource database. _Implemented in `apps/semaphore/sqlfu.config.ts` and `apps/semaphore/src/db`, with D1 queries collapsed into `src/db/queries/queries.sql`._
- [x] Replace `apps/semaphore/sql/queries.ts` imports/usages with SQLFu-generated query modules. _Resource store and oRPC handlers now use `src/db/queries/.generated` via the request SQLFu client._
- [x] Add SQLFu config, migrations, definitions, and generated query modules for `ResourceCoordinator` Durable Object storage. _Implemented under `apps/semaphore/src/durable-objects/db`; DO queries live in `db/queries/queries.sql`, and `ResourceCoordinator` now runs the bundled migration._
- [x] Remove the old TypeSQL generator script/config and package dependency. _Deleted `scripts/generate-queries.ts`, `typesql.json`, `raw-sql.d.ts`, and `sql/queries.*`; removed `typesql-cli`._
- [x] Update semaphore package scripts to use `sqlfu generate`. _Added `sqlfu:generate` and pointed `db:types` at it._
- [x] Run focused verification for `apps/semaphore`. _Ran SQLFu generation, D1 + Durable Object migration/definition checks, `pnpm --dir apps/semaphore typecheck`, and `pnpm --dir apps/semaphore test`._

## Implementation Notes

- Branch: `semaphore-sqlfu`
- Worktree: `../worktrees/iterate/semaphore-sqlfu`
- SQLFu generation command: `pnpm --dir apps/semaphore sqlfu:generate`
- D1 schema check: `pnpm --dir apps/semaphore exec sqlfu check migrations-match-definitions`
- Durable Object schema check: `../../node_modules/.bin/sqlfu check migrations-match-definitions` from `apps/semaphore/src/durable-objects`

### 2026-05-15 PR update

- Merged current `origin/main` into `semaphore-sqlfu` and resolved conflicts from `main` removing the old ingress-proxy app.
- Dropped the PR's stray ingress-proxy management-host files so the final PR diff is Semaphore-only plus lockfile/task updates.
- Restored lazy SQLFu D1 config resolution so `pnpm --dir apps/semaphore sqlfu:generate` works in a clean checkout without pre-existing Alchemy Miniflare state; DB-touching SQLFu commands still throw a targeted setup error if local D1 state has not been materialized.
- Fixed an inherited generated-workflow issue where the new integration workflow referenced `runsOnDepotUbuntuForContainerThings` but the helper was missing, causing GitHub to create a failed no-job workflow run.
