# Fixing Drizzle Migration Merge Conflicts

When multiple branches add migrations, merge conflicts can occur. This guide covers how to resolve them.

## How Drizzle Migrations Work

Drizzle stores migrations in:

- `backend/db/migrations/*.sql` — actual SQL migration files
- `backend/db/migrations/meta/_journal.json` — tracks migration order and tags
- `backend/db/migrations/meta/*_snapshot.json` — schema state snapshots

The journal file is the source of truth for which migrations exist and their order.

## Common Conflict Scenarios

### 1. Same Migration Index on Both Branches

Both branches generate a new migration (e.g., `0005_*.sql`) independently:

```
main:     0005_feature_a.sql
branch:   0005_feature_b.sql
```

### 2. Journal File Conflicts

The `_journal.json` has conflicting entries from both branches.

### 3. Tag Mismatch

Journal references a file that doesn't exist (wrong tag name).

## Resolution Steps

### Step 1: Reset Journal to Main

```bash
git checkout main -- apps/os2/backend/db/migrations/meta/_journal.json
```

### Step 2: Delete Your Branch's Migration Files

Remove the SQL file and snapshot your branch added:

```bash
rm apps/os2/backend/db/migrations/XXXX_your_migration.sql
rm apps/os2/backend/db/migrations/meta/XXXX_snapshot.json
```

### Step 3: Regenerate Migration

```bash
cd apps/os2
pnpm drizzle-kit generate --name your_migration_name
```

This creates a new migration with the correct next index number.

### Step 4: Verify with drizzle-kit check

```bash
pnpm drizzle-kit check
```

This verifies migration consistency. Fix any reported issues.

## Manual Journal Fix (Alternative)

If you need to preserve both migrations:

1. Open `_journal.json`
2. Ensure each entry has a unique `idx` (0, 1, 2, 3...)
3. Ensure each `tag` matches an existing `.sql` file name (without `.sql`)
4. Ensure `idx` values are sequential with no gaps
5. Order entries by `when` timestamp

Example journal entry:

```json
{
  "idx": 5,
  "version": "7",
  "when": 1768259708633,
  "tag": "0005_billing_account",
  "breakpoints": true
}
```

The `tag` must exactly match the filename: `0005_billing_account.sql`

## Preventing Conflicts

1. **Coordinate migration timing** — avoid parallel schema changes when possible
2. **Rebase frequently** — keep branches up to date with main
3. **Generate migrations late** — delay `drizzle-kit generate` until ready to merge
4. **Use named migrations** — `drizzle-kit generate --name descriptive_name` makes conflicts easier to understand

## Debugging Tips

### Check for Missing Files

```bash
# List all SQL migrations
ls apps/os2/backend/db/migrations/*.sql

# Check journal entries
cat apps/os2/backend/db/migrations/meta/_journal.json | jq '.entries[].tag'
```

### Verify Tags Match Files

Every `tag` in the journal must have a corresponding `.sql` file:

- Journal tag: `0005_billing_account`
- File must exist: `0005_billing_account.sql`

### Missing Snapshots

Snapshots are only needed for generating new migrations, not for running them. If you're missing a snapshot but have the SQL file, migrations will still run.

## Real Example: Tag Mismatch Fix

Error:

```
Error: No file backend/db/migrations/0006_lowly_jack_power.sql found
```

Actual file: `0006_drop_stripe_event.sql`

Fix in `_journal.json`:

```diff
- "tag": "0006_lowly_jack_power",
+ "tag": "0006_drop_stripe_event",
```

## References

- [Drizzle Kit Check](https://orm.drizzle.team/docs/drizzle-kit-check) — verify migration consistency
- [Drizzle Migrations](https://orm.drizzle.team/docs/migrations) — migration overview
- [GitHub Discussion #1104](https://github.com/drizzle-team/drizzle-orm/discussions/1104) — community discussion on merge conflicts
