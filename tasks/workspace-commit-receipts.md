---
state: todo
priority: low
size: medium
tags: [os, workspaces, architecture, durability]
---

# Durable receipts for workspace commits

Follow-up from the workspace-mounts thermo reviews (PR #2095, round-3 major
5). A workspace `git.commit` is: classify → repo `commitFiles` (remote side
effect) → clear the committed mount's whiteouts and local shadows. A crash or
storage error between the remote commit and the cleanup leaves the repo
updated while the overlay still carries the committed state.

## Why this is LOW priority (the current self-healing)

- Leftover whiteouts are healed by both `gitStatus` and the next `gitCommit`
  (stale-whiteout reconciliation with in-lock point re-verification).
- Leftover local shadows carry content IDENTICAL to what was committed; they
  read correctly, show as harmless shadowed "modified" entries, and clear on
  the next commit of that mount (`commitFiles` returns `noChanges` and the
  cleanup still runs).
- The one genuinely stale outcome — the repo moves FURTHER before the user
  touches the workspace again, leaving the old shadow pinning old content —
  is the ordinary overlay-pins-a-path semantics, escapable via
  `revert`/`reset`.

## What the receipt design adds (when worth it)

1. Journal `{ operationId, mount, manifest }` durably before the repo RPC.
2. Give `commitFiles` an idempotent operation id (dedupe on the repo side).
3. On boot/next touch, a pending receipt re-drives cleanup idempotently.
4. Then cleanup order stops mattering and the RPC result is truthful even
   across evictions.

Pairs naturally with the lazy-Artifacts read layer work
(`tasks/lazy-artifacts-repo-reads.md`), which reshapes commit plumbing anyway.
