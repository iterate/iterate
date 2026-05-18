---
name: drizzle-migrations
description: Drizzle ORM database migration workflow for packages that still use Drizzle (agents, example). Do NOT use for apps/os — that app uses sqlfu/D1.
---

# Drizzle Migration Workflow

Use this skill only for packages that still ship Drizzle schema + migrations.

**Do not use for `apps/os`.** OS schema lives in `apps/os/src/db/definitions.sql`; run `pnpm --dir apps/os sqlfu:generate` / `sqlfu:migrate` instead.

## Process

### 1. Edit the schema file

Example paths:

- `apps/agents/src/db/schema.ts`
- `apps/example/src/db/schema.ts`

### 2. Generate migration

From the package directory:

```bash
pnpm drizzle-kit generate --name descriptive_migration_name
```

### 3. Review the generated `.sql`

You may edit generated SQL for backfills. **Never edit `_journal.json` or `*_snapshot.json` by hand.**

### 4. Verify

```bash
pnpm drizzle-kit check
```

### 5. Run locally

```bash
pnpm drizzle-kit migrate
```

## Merge Conflicts

See `docs/fixing-drizzle-migration-conflicts.md`.

## What NOT To Do

- Never write migration SQL from scratch without `drizzle-kit generate`
- Never use `pnpm os db:migrate` — legacy OS app removed
- Never apply this workflow to `apps/os` sqlfu migrations
