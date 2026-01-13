---
state: pending
priority: medium
size: small
---

# Restore Split Changelog for apps/os

The changelog mechanism was simplified to show all changes together. Previously, it split changes into "apps/os changes" and "other changes" sections.

## What Was Removed

In `.github/ts-workflows/workflows/ci.ts` (lines 110-111 of the original):

```typescript
write_git_changes apps/os 'apps/os changes'
write_git_changes ':!apps/os' 'other changes'
```

Was replaced with:

```typescript
write_git_changes '.' 'changes'
```

## How It Worked

The `write_git_changes` bash function was defined in the "Write changelog" step:

```bash
write_git_changes() {
  glob=$1
  description=${2:-$glob}

  changes=$(git log $LAST_RELEASE..HEAD --oneline -- $glob | sed 's/^/- /g')

  if [ "$changes" != "" ]; then
    add_to_changelog "## $description"
    add_to_changelog "$changes"
  fi
}
```

It used git's pathspec filtering:

- `apps/os` - only commits that touched files in apps/os
- `:!apps/os` - exclude commits that touched apps/os (everything else)

This created separate sections in the release notes showing:

1. What changed in apps/os specifically
2. What changed in the rest of the codebase

## To Restore

1. Edit `.github/ts-workflows/workflows/ci.ts`
2. Replace the single `write_git_changes` call with the two original calls
3. Run `pnpm generate` in `.github/ts-workflows` to regenerate the YAML
