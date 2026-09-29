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
   its own organization). A config repo written for an older platform must be migrated first,
   because `apply` restores its tree byte for byte (project-seeds.md, "A config repo for a newer
   platform"): clone it, migrate it, and capture from the checkout with `--config-repo`:

   ```sh
   pnpm --dir apps/os project-seed capture \
     --env prd --project <slug> --file <absolute-path>.json \
     [--config-repo <absolute-path-to-migrated-checkout>]
   pnpm --dir apps/os project-seed check \
     --env prd --file <absolute-path>.json
   pnpm --dir apps/os project-seed structure --env prd --file <absolute-path>-structure.json
   ```

   A seed does not carry the connections, installed processors or repo origins a project set up
   at runtime. List them for each project and keep the list with the archive
   ([What a seed does not carry](../../../apps/os/docs/project-seeds.md#what-a-seed-does-not-carry)).

2. Pause merges from the erase until `verify-structure` passes: every merge that touches the Worker
   redeploys prd, and a deploy resets Durable Objects under a running `apply`. The owner or you
   announce the pause where the team merges (nothing enforces it), and check that no Deploy OS run
   is in flight (the command is in
   [`apps/os/docs/project-seeds.md`](../../../apps/os/docs/project-seeds.md), "Pause merges").
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

5. Restore what the seeds did not carry: reconnect each integration under its archived connection
   name, set each repo's origin and make it one history with the remote again, reinstall each
   processor, and check that every row on the list is back. This is part of the recreate, not an
   owner to-do for later. If a step needs a person, such as a GitHub admin opening the connect
   link once, ask for it during the window. If nobody does it, the first line of your report says
   the recreate is not done and names what is missing. The recipe is in
   [What a seed does not carry](../../../apps/os/docs/project-seeds.md#what-a-seed-does-not-carry).

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
