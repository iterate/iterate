---
state: todo
priority: low
size: medium
tags:
  - infrastructure
  - sandbox
---

# Clean up entry.ts to separate local-docker and Daytona codepaths

The `apps/os2/sandbox/entry.ts` file handles container startup for both local-docker (dev) and Daytona (production) scenarios. The codepaths are intertwined and could be clearer.

## Current issues

- `isDevMode()` is used throughout but the name is confusing - it really means "local-docker mode"
- The logic for when to rebuild frontend, pull code, run pnpm install etc. is scattered
- Hard to reason about what happens in each scenario

## Suggested improvements

1. Rename `isDevMode()` to `isLocalDockerMode()` for clarity
2. Consider extracting separate functions for each scenario:
   - `setupForLocalDocker()` - mounts local code, always rebuilds frontend
   - `setupForDaytona()` - pulls latest from git, uses pre-built frontend from snapshot
3. Add clear comments documenting the two deployment modes at the top of the file
4. Consider if the two modes should share less code (maybe separate entry points?)

## Files

- `apps/os2/sandbox/entry.ts`
