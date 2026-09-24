---
name: recreate-production
description: Capture or restore a selected project after a deliberate production data erase.
---

# Recreate a production project

Use this skill only for a deliberate production recovery. Read
[Project recovery seeds](../../../apps/os/docs/project-seeds.md) before acting. A seed is a
semantic snapshot of one project, not a database dump.

Use `pnpm --dir apps/os project-seed` and always pass `--env`. Keep archives outside the
repository. They contain encrypted secret cells and must never be committed or printed.

## Capture

```sh
pnpm --dir apps/os project-seed capture \
  --env prd --project <slug> --file <absolute-path>.json
pnpm --dir apps/os project-seed check \
  --env prd --file <absolute-path>.json
```

Capture creates a mode-0600 archive, Git mirror, working clone, and receipt. It refuses to
overwrite an earlier archive. Report only the non-secret counts and paths.

## Restore

```sh
pnpm --dir apps/os project-seed apply \
  --env prd --yes-i-mean-prd --file <absolute-path>.json \
  --organization <organization> --owners <owner-email> [...]
```

`apply` creates or converges the selected project through normal project, repository, and secret
operations. It restores the config tree, organization membership, and secrets into fresh project
identity bindings. It verifies the Git tree, published commit, membership roles, and secret
readback before returning.

## Boundaries

- Do not run capture, erase, deploy, apply, or provider checks without the user's explicit request.
- Never replay stream history, offsets, processor state, OAuth sessions, grants, other repositories,
  R2 files, agents, or workspaces. A seed does not contain them.
- Retain the deployment's `APP_CONFIG_SECRETS__KEY`; an archive cannot be restored without it or a
  retained previous key.
- Before an erase, inventory with `pnpm --dir apps/os erase-data --env prd --yes-i-mean-prd --dry-run`.
  The erase and deployment are separate operations; no seed command performs either implicitly.
- If a command fails, preserve the archive and fix the reported condition before retrying. Do not
  attempt recovery by appending legacy events or restoring database rows.
