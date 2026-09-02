---
status: in-progress
size: medium
---

# Artifacts repos: delete on erase + backfill GC

## Status summary

Implementation complete; awaiting review.

- Done: confirmed Artifacts repos were **never covered** by erase-data or
  preview GC (coverage gap, not a broken deletion); erase-data now wipes the
  namespace (budgeted, skipped under `--preserve-auth`); `pnpm artifacts-gc`
  backfill script with dry-run/age-cutoff/live-project-skip; doc row; triage
  unit tests.
- Missing: a live run of the backfill against the real pile — start with
  `doppler` creds available: `pnpm --dir apps/os artifacts-gc --env preview_1 --dry-run`.

## Problem

The dev/preview Cloudflare account (376ef7ed81b0573f93524de763666c15) holds
~783k Artifacts repos across the per-slot namespaces (`os-preview-1-repos`:
94k, `os-preview-3-repos`: 120k, …). Every project repo creation
(`getOrCreateArtifact` in `apps/os/src/domains/repos/artifact-creation.ts`)
mints a repo plus a 365-day write token, and nothing ever deletes them:

- `apps/os/scripts/erase-data.ts` destroys DOs, wipes D1/KV, and
  walks/lifecycle-expires R2 — Artifacts repos are not mentioned.
- `docs/preview-resource-gc.md`'s teardown table covers compute, R2, D1/KV —
  no Artifacts row. The product predates none of this; the repos were simply
  never added to the teardown inventory.

So every preview acquire→erase cycle strands the slot's repos forever.
(Surfaced during the 2026-09-01 Artifacts 403 incident; the pile was a red
herring for that incident but is a real hygiene problem.)

## Design decisions (made AFK — assumptions marked)

- **Erase path owns steady-state deletion.** After an erase, every project in
  the slot is gone, so *every* repo in the slot's `${osWorkerName}-repos`
  namespace is orphaned. erase-data deletes them all, delete-then-relist
  (oldest first, `sort=created_at&direction=asc`, `limit=200`), with the same
  90s deadline budget the R2 walk uses — partial progress is fine, the next
  erase continues.
- **`--preserve-auth` skips the wipe.** Preserve-auth exists for a planned
  production recreation where projects are recreated under their exact ids;
  the backing repos are those projects' git history, so deleting them would
  be data loss. *(Assumption: history should survive a preserve-auth erase.)*
- **Backfill is a separate script** (`apps/os/scripts/artifacts-gc.ts`, run as
  `pnpm artifacts-gc --env preview_N`): the existing pile is far too big for
  erase-data's per-run budget. Oldest-first, rate-limited by the shared 429
  choke point, with `--max-deletes`, `--older-than-hours` (default 24) and
  `--dry-run`. One env per invocation; loop over slots in the shell.
- **Live repos are skipped twice over** in the backfill: repos younger than
  the age cutoff are never touched, and repos whose name parses
  (`RepoArtifactNameCodec`) to a project id present in the slot's
  project-directory KV (`project:<id>` keys) are skipped even when old.
  Global-scope repos (`global{sep}...` names) get no KV check — age cutoff
  only. *(Assumption: prd is not a backfill target for now; the script still
  demands `--yes-i-mean-prd` there like erase-data.)*
- **Tokens die with their repo.** The 365-day write tokens are repo-scoped;
  deleting the repo is assumed to invalidate them, so no separate revocation
  pass. *(Assumption based on the API shape; worth confirming with CF.)*

## Checklist

- [x] erase-data wipes the slot's Artifacts namespace repos (skipped under
      `--preserve-auth`) _— delete-then-relist pass in
      `apps/os/scripts/erase-data.ts`, 90s budget like the R2 walk_
- [x] `artifacts-gc` backfill script with dry-run, age cutoff, live-project
      skip, delete budget _— `apps/os/scripts/artifacts-gc.ts`, run via
      `pnpm artifacts-gc --env <name>`_
- [x] `docs/preview-resource-gc.md` teardown table gains an Artifacts row
- [x] tests for the pure parts (live-project skip / cutoff filtering) _—
      `triageArtifactsRepoPage` covered in `artifacts-gc.test.ts`_

## Implementation log

- Confirmed REST surface via the Cloudflare OpenAPI spec:
  `GET/POST /accounts/{a}/artifacts/namespaces/{ns}/repos` (cursor pagination,
  `sort=created_at|updated_at|last_push_at|name`, `direction`, `limit` ≤ 200),
  `DELETE /accounts/{a}/artifacts/namespaces/{ns}/repos/{name}`.
- `scripts/lib/env-context.ts`'s `cf()` returns `body.result` only (cursor
  discarded) — the erase-data pass uses delete-then-relist instead of cursors,
  matching the existing R2/KV wipe idiom and staying robust when concurrent
  deletes would invalidate a cursor. The backfill needs to advance PAST repos
  it skips, so it makes raw envelope calls (via the shared 429-retry helper)
  and uses the cursor only for pure-skip pages, restarting from the head after
  any deletion.
- Live-project detection: the project-directory KV holds `project:<id>` keys,
  so the live set is one prefix-listed key scan — no value fetches.
- 2026-09-01/02 while implementing: found 13 files in this worktree (prompt
  files + prompt-sections explainer) repeatedly mangled by oxfmt. Root cause
  (confirmed by `oxfmt --check` from the root worktree): format runs in the
  ROOT worktree recurse into `.claude/worktrees/`, where the root-relative
  ignorePatterns don't match the nested copies. Fixed here by adding
  `**/.claude/worktrees/` to `.oxfmtrc.json` — a rider on this PR since the
  mangle broke this branch's codegen lint check twice.
- Review threads from Iterate Review (2 accepted, 1 pushed back — the
  "inferable annotation" suggestion broke typecheck) handled in 54d098919.
