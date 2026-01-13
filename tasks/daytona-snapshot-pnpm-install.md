---
state: todo
priority: medium
size: small
tags:
  - sandbox
  - performance
  - daytona
---

# Pre-bake pnpm install into Daytona snapshot

Running `pnpm install` on sandbox startup takes a long time. We should bake the installed dependencies into the snapshot so sandboxes are ready to use immediately.

## Current state

The snapshot is created from `apps/os/sandbox/Dockerfile` and only installs global tooling (pnpm, tsx, gh, opencode, claude). When a sandbox starts and clones the iterate repo, it still needs to run `pnpm install` which takes ages.

## Proposed solution

Update the Dockerfile to:

1. Clone the iterate repo
2. Run `pnpm install` to populate the node_modules
3. Optionally remove the .git directory to reduce snapshot size (the actual repo gets cloned fresh on sandbox start anyway)

This way the node_modules are already in the snapshot, and subsequent `pnpm install` runs will be near-instant due to the lockfile matching.

## Considerations

- Snapshot size will increase significantly due to node_modules
- Need to update snapshot version in `apps/os/alchemy.run.ts` (currently `iterate-sandbox-0.0.3-dev` on line 217)
- May want to document a process for periodically refreshing the snapshot when dependencies change significantly
