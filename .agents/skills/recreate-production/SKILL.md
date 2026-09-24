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
overwrite an earlier archive. The archive also records the project's custom hostnames
(`hostnames`). Report only the non-secret counts, hostnames and paths.

Capture the users, organizations and memberships as well; a project seed carries only its own
organization:

```sh
pnpm --dir apps/os project-seed structure --env prd --file <absolute-path>-structure.json
```

## Pause merges from the erase until verification

Every merge to `main` that touches the Worker redeploys prd (Deploy OS). A deploy during the
restore resets Durable Objects under a running `apply`. Before the erase:

1. The owner or you announce a merge pause where the team merges, lasting until
   `verify-structure` passes. Nothing enforces it.
2. Check that no Deploy OS run is in flight:
   `depot ci run list --org 0p91s0lz49 --repo iterate/iterate`.

If a deploy lands mid-restore anyway (for example `apply` fails with "Durable Object reset
because its code was updated"), wait for it to finish. Then rerun `apply` for every seed, not
only the one that failed, and then `verify-structure`. `apply` is idempotent, so a rerun only
finishes what was cut off. Lift the pause once verification passes.

## Restore

```sh
pnpm --dir apps/os project-seed apply \
  --env prd --yes-i-mean-prd --file <absolute-path>.json \
  --organization <organization> --owners <owner-email> [...]
```

`apply` creates or converges the selected project through normal project, repository, and secret
operations. It restores the config tree, organization membership, and secrets into fresh project
identity bindings. It lands the project on its organization's record, the list the dash shows,
and restores the custom hostnames on the deployment the seed was captured from. It verifies the
Git tree, published commit, membership roles, the organization's record, secret readback and
each hostname's Cloudflare answer before returning. Project IDs are kept; user and organization
IDs are minted afresh.

After every seed is applied, compare the whole structure with the capture:

```sh
pnpm --dir apps/os project-seed verify-structure --env prd --file <absolute-path>-structure.json
```

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
