---
state: backlog
priority: low
size: medium
tags: [os, repos, streams, events]
---

# Enrich repo commit events with full commit + numstat (no patch)

## Goal

Emit **one stream event per commit** that is a fully loaded commit summary:
commit metadata **plus** per-file **name-status + numstat** (diffstat),
**without** the unified patch/hunks.

Shape already exists as RPC `repo.commitDetails` /
`RepoCommitDetails` + `RepoCommitFileChange` (`apps/os/src/domains/repos/types.ts`,
`line-diff.ts`):

- oid, full message, author, timestamp, parents
- `files[]`: path, status (`added` | `deleted` | `modified`), additions,
  deletions, binary
- no separate “lines modified” count (git only has +/−)

Prefer reusing that type on the event rather than inventing a parallel shape.

## Today

- Cloudflare Artifacts push queue → `repo/cloudflare-artifact-event-received`
  → one `repo/commit-completed` per **push tip** with only
  `{ beforeCommitOid, branch, commitOid }`.
- File awareness is derived later only for task markdown
  (`repo/task-created|updated|deleted`).
- Push payload may include commit headers (`commits[]`, message, parents) but
  **not** file lists; `commitsTruncated` can omit commits on fat pushes.

## Research notes (do not re-litigate without re-checking)

- **Artifacts Workers binding** (`env.ARTIFACTS`): control plane + tokens only
  in current `@cloudflare/workers-types` — no numstat/diff.
- **Artifacts HTTP control plane**: `log` / `commit` / `tree` / `blob` /
  `file` / `raw` — still **no** diff/numstat/compare endpoint.
- Numstat must be **computed by us** (existing checkout + `diffFileMaps`, or
  tree/blob walk via object APIs if those stay available).

## Design choices when we pick this up

1. **One event per commit** in the push range (`before`…`after`), not one
   tip-only event per push.
2. Payload = commit metadata + numstat files (diffstat); large events OK;
   still no patch.
3. Walk incomplete `commits[]` via log when `commitsTruncated`.
4. Revisit whether task-specific events still need a separate path once
   generic file stats land on every commit event.
## Explicitly deferred

Not implementing now — captured so future work has context.
