---
status: in-progress
size: small
branch: bump-middlewright-0-1-4
base: main
---

# Bump Middlewright to 0.1.4

## Status

Not yet implemented. The worktree and task are ready; the dependency, lockfile,
and local patch still need to be reconciled with the `0.1.4` release and checked.

## Goal

Replace the temporary pkg.pr.new Middlewright build with the published `0.1.4`
release. Keep only local patching that is still absent upstream.

## Assumptions

- `0.1.4` is intended to supersede the current `https://pkg.pr.new/middlewright@14`
  pin.
- The existing `patches/middlewright.patch` must be compared with the published
  package before deciding whether to retain, shrink, or remove it.
- This dependency-only change does not need product screenshots or a preview.

## Checklist

- [ ] Inspect the published `0.1.4` package against the local Middlewright patch.
- [ ] Pin `middlewright` to `0.1.4` and regenerate the pnpm lockfile.
- [ ] Remove or update the local patch registration and file as required.
- [ ] Run focused install, typecheck, lint, format, and relevant Playwright-support checks.
- [ ] Record verification, move this task to `tasks/complete/`, and update the PR body.

## Implementation log

- 2026-08-04: Created branch/worktree from `origin/main`; no product code changed yet.
