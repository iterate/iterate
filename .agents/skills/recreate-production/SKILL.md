---
name: recreate-production
description: Capture or restore a selected project after a deliberate production data erase.
---

# Recreate a production project

Use this skill only for a deliberate production recovery. Read
[Project recovery seeds](../../../apps/os/docs/project-seeds.md) before acting: it explains what a
seed holds, what `apply` converges and refuses, hostnames, and the merge pause. A seed is a semantic
snapshot of one project, not a database dump.

Use `pnpm --dir apps/os project-seed` and always pass `--env`. Keep archives outside the
repository. They contain encrypted secret cells and must never be committed or printed. Report only
non-secret counts, hostnames and paths.

## Steps

1. Capture each project, then the users, organizations and memberships (a project seed carries only
   its own organization):

   ```sh
   pnpm --dir apps/os project-seed capture \
     --env prd --project <slug> --file <absolute-path>.json
   pnpm --dir apps/os project-seed check \
     --env prd --file <absolute-path>.json
   pnpm --dir apps/os project-seed structure --env prd --file <absolute-path>-structure.json
   ```

2. Pause merges from the erase until `verify-structure` passes: every merge that touches the Worker
   redeploys prd, and a deploy resets Durable Objects under a running `apply`. The owner or you
   announce the pause where the team merges (nothing enforces it), and check that no Deploy OS run
   is in flight (the command is in project-seeds.md).
3. Inventory the erase with `pnpm --dir apps/os erase-data --env prd --yes-i-mean-prd --dry-run`.
   The erase and the deploy after it are separate operations, run only on the user's explicit
   request; no seed command performs either.
4. Restore every seed, then compare the whole structure with the capture:

   ```sh
   pnpm --dir apps/os project-seed apply \
     --env prd --yes-i-mean-prd --file <absolute-path>.json \
     --organization <organization> --owners <owner-email> [...]
   pnpm --dir apps/os project-seed verify-structure --env prd --file <absolute-path>-structure.json
   ```

   If a deploy lands mid-restore anyway (`apply` fails with "Durable Object reset because its code
   was updated"), wait for it to finish, rerun `apply` for every seed with the same
   `--organization` and `--owners`, then `verify-structure`. Lift the pause once verification
   passes.

A rerun of `apply` resets the project to its archive (config tree, every archived secret's value,
the members). Inside the restore window that only finishes what was cut off. Never rerun it on a
live deployment hours later.

## Boundaries

- Do not run capture, erase, deploy, apply, or provider checks without the user's explicit request.
- Never replay stream history, offsets, processor state, OAuth sessions, grants, other repositories,
  R2 files, agents, or workspaces. A seed does not contain them.
- Retain the deployment's `APP_CONFIG_SECRETS__KEY`; an archive cannot be restored without it or a
  retained previous key.
- If a command fails, preserve the archive and fix the reported condition before retrying. Do not
  attempt recovery by appending legacy events or restoring database rows.
