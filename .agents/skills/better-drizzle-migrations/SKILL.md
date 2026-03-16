---
name: better-drizzle-migrations
description: How we use Drizzle migrations in local SQLite services like fake-os and registry. Use when changing schema.ts, generating migrations, reviewing SQL, refreshing cached schema.sql, or adding migration guardrails.
---

# Better Drizzle Migrations

## Goals

- `schema.ts` is the schema source of truth
- committed migration `.sql` files are the team history
- `drizzle/schema.sql` is a derived cache for context only
- raw SQL must always be easy to inspect
- Drizzle snapshot files exist for tooling, not for humans to review deeply
- duplicate migration IDs must never be committed

## Services using this workflow

- `services/fake-os`
- `services/registry`

Both services keep the same layout:

- `drizzle.config.ts`
- `src/server/db/schema.ts`
- `src/server/db/index.ts`
- `drizzle/*.sql`
- `drizzle/meta/*`
- `drizzle/schema.sql`
- `scripts/`

## Normal authoring flow

1. Edit `src/server/db/schema.ts`
2. Run `pnpm db:tmp:preview`
3. Run `pnpm db:generate --name <name>`
4. Review the generated migration SQL
5. If needed, edit only the generated `.sql`
6. Run `pnpm db:check`
7. Run `pnpm db:check:migration-ids`
8. Run `pnpm db:migrate`
9. Run `pnpm db:schema`

## Commands

- `pnpm db:generate --name <name>`: generate a new migration with a timestamp prefix
- `pnpm db:migrate`: apply committed migrations to the local service DB
- `pnpm db:tmp:preview`: rebuild a fresh temp DB from committed migrations, then run Drizzle push against only that temp DB and print the raw SQL
- `pnpm db:schema`: rebuild a fresh temp DB from committed migrations and refresh `drizzle/schema.sql`
- `pnpm db:check:migration-ids`: fail if two migration files share the same leading numeric/timestamp ID

## Rules

- Never hand-write a new migration file from scratch
- Never hand-edit `drizzle/meta/_journal.json` or snapshot files
- Review `migration.sql` / `*.sql` first, not the snapshot JSON
- Keep `drizzle/schema.sql` updated so the current schema is easy to read without opening snapshots
- If Drizzle asks an ambiguous question during generation, answer it once while generating the migration, then commit the resulting SQL

## Cached schema

`drizzle/schema.sql` is derived from replaying committed migrations into a fresh temp DB and dumping the resulting SQLite schema.

It is:

- for humans
- for quick review
- for debugging the current shape

It is not:

- the source of truth
- hand-edited
- a replacement for committed migrations

## Duplicate IDs

Migration filenames use timestamp prefixes, and we still run a duplicate-ID check before commit.

That means:

- collisions should be rare
- if a collision does happen in a worktree, commit should fail early
- regenerate one migration instead of renumbering files by hand
