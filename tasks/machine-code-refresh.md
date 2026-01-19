---
state: todo
priority: medium
size: medium
tags:
  - machine-provider
  - dx
---

# Machine Code Refresh

Add ability to refresh daemon code on running machines without a full restart.

## Problem

When developing, changes to daemon code require restarting the machine to take effect. For local-docker this is slow (full container restart), and for Daytona there's no mechanism at all - you'd need to recreate the machine.

## Solution

### 1. Version Tracking

Add version info to machines:

- **OS version**: Git SHA at deployment time, passed via env var (e.g., `ITERATE_GIT_SHA`) from GitHub Actions
- **Daemon version**: Git SHA read at runtime via `git rev-parse HEAD`
- Add `getVersion` to daemon tRPC router returning current git SHA
- OS can compare its SHA to daemon's to show "update available" indicator

### 2. Machine Provider `refreshCode` Method

Add to `MachineProvider` interface:

```typescript
interface MachineProvider {
  // ... existing methods

  /** Refresh code on the machine. Returns false if not supported. */
  refreshCode?(targetRef: string): Promise<{ success: boolean; message?: string }>;
}
```

Implementation per provider:

| Provider                  | Mechanism                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------ |
| `daytona`                 | `git fetch && git checkout <targetRef> && pnpm install` then restart daemon via s6   |
| `local-docker`            | `rsync` from `/local-iterate-repo` mount, `pnpm install`, then restart daemon via s6 |
| `local` / `local-vanilla` | Not needed (already using host code)                                                 |

### 3. Daemon Endpoint

Add `selfUpdate` mutation to daemon tRPC router:

```typescript
selfUpdate: publicProcedure
  .input(z.object({ targetRef: z.string() }))
  .mutation(async ({ input }) => {
    // Provider-specific logic based on environment detection
    // e.g., check if /local-iterate-repo exists for local-docker
    // After update: exit process, s6 will restart
  });
```

### 4. OS tRPC Procedure

Add `machine.refreshCode` mutation that:

1. Gets OS's current git SHA (from env var)
2. Calls daemon's `selfUpdate` with that SHA
3. Returns success/failure

### 5. UI

- Add "Refresh Code" button to machine detail page (separate from Restart)
- Only show for machine types that support it (daytona, local-docker)
- Show loading state during refresh
- Toast on success: "Code updated, daemon restarting..."
- Optional: Show version mismatch indicator when OS SHA != daemon SHA

## Notes

- Don't rebuild opencode - just the daemon
- `pnpm install` should be fast if lockfile unchanged
- s6 auto-restarts daemon when it exits
- For Daytona, need to handle auth for git fetch (should already have GitHub token from bootstrap)

## Related

- `apps/daemon/server/trpc/router.ts` - daemon tRPC router
- `apps/os/backend/providers/` - machine provider implementations
- `apps/os/sandbox/entry.sh` - shows local-docker rsync flow
- `.github/workflows/` - where to add ITERATE_GIT_SHA to deployment
