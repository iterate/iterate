---
name: drizzle-migrations
description: Drizzle ORM database migration workflow. Use when making schema changes, adding columns/tables, or modifying the database. Triggers include "add a column", "create a table", "schema change", "migration", "db change", or any task that modifies drizzle schema files.
---

# Drizzle Migration Workflow

When making database schema changes, you MUST follow this exact process. **Never write migration SQL or snapshot JSON by hand.**

## Process

### 1. Edit the schema file

Make your changes in the drizzle schema source (e.g. `apps/os/backend/db/schema.ts` or similar `schema.ts`).

### 2. Generate migration with drizzle-kit

From the package directory (e.g. `apps/os/`):

```bash
pnpm drizzle-kit generate --name descriptive_migration_name
```

This produces three things:

- A `.sql` migration file
- An updated `meta/_journal.json`
- A new `meta/*_snapshot.json`

If drizzle-kit asks interactive questions (e.g. "is this column created or renamed?"), answer them.

### 3. Review and optionally edit the `.sql` file

You MAY edit the generated `.sql` file — for example to add data migrations, backfills, or custom SQL that drizzle-kit can't auto-generate.

**NEVER manually edit `_journal.json` or `*_snapshot.json` files.** These are managed exclusively by drizzle-kit.

### 4. Verify migration consistency

```bash
pnpm drizzle-kit check
```

Fix any reported issues before proceeding.

### 5. Run the migration locally

```bash
pnpm drizzle-kit migrate
```

Confirm the schema matches what your code expects.

## What NOT to Do

- **Never write `.sql` migration files from scratch** — always generate them
- **Never edit `_journal.json` or `*_snapshot.json`** — these are drizzle-kit managed
- **Never skip the `generate` step** — even if you "know" the SQL

## Running Migrations in Production

After merging schema changes, run:

```bash
PSCALE_DATABASE_URL=$(doppler secrets --config prd get --plain PLANETSCALE_PROD_POSTGRES_URL) pnpm os db:migrate
```

## Resolving Merge Conflicts

See `docs/fixing-drizzle-migration-conflicts.md` for detailed steps. The short version:

1. Reset meta files to main: `git checkout main -- <migrations-dir>/meta/`
2. Delete your branch's `.sql` files
3. Regenerate: `pnpm drizzle-kit generate --name your_migration`
4. Verify: `pnpm drizzle-kit check`
