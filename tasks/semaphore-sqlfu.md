---
state: ready
priority: high
size: medium
---

# Move semaphore to SQLFu

Status summary: spec drafted and ready for implementation. The task is not implemented yet. Main missing pieces are replacing semaphore's custom TypeSQL/query generator, adding SQLFu configs/generated files, and verifying the app still typechecks/tests.

## Goal

Move `apps/semaphore` to SQLFu, matching the direction already taken by `apps/events`.

## Assumptions

- This should remove Semaphore's local TypeSQL/custom generated-query path, not merely add SQLFu alongside it.
- The D1 resource inventory database should use SQLFu definitions, migrations, query files, and generated query modules.
- The `ResourceCoordinator` Durable Object should also use SQLFu for its per-object SQLite schema and query helpers, similar to `apps/events/src/durable-objects`.
- Runtime behavior should stay the same: Durable Objects remain authoritative for active leases, while D1 mirrors inventory and current lease state for operator visibility.

## Checklist

- [ ] Add SQLFu config and SQL files for the semaphore D1 resource database.
- [ ] Replace `apps/semaphore/sql/queries.ts` imports/usages with SQLFu-generated query modules.
- [ ] Add SQLFu config, migrations, definitions, and generated query modules for `ResourceCoordinator` Durable Object storage.
- [ ] Remove the old TypeSQL generator script/config and package dependency.
- [ ] Update semaphore package scripts to use `sqlfu generate`.
- [ ] Run focused verification for `apps/semaphore`.

## Implementation Notes

- Branch: `semaphore-sqlfu`
- Worktree: `../worktrees/iterate/semaphore-sqlfu`
