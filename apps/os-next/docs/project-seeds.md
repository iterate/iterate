# Project recovery seeds

Use `pnpm --dir apps/os-next project-seed` to capture, check and restore selected
projects across a deliberate environment erase. Always select `--env` explicitly.

```sh
pnpm --dir apps/os-next project-seed capture \
  --env prd --project garple --file ~/.iterate/backups/garple-2026-09-22.json
pnpm --dir apps/os-next project-seed check \
  --env prd --file ~/.iterate/backups/garple-2026-09-22.json
pnpm --dir apps/os-next project-seed apply \
  --env prd --yes-i-mean-prd \
  --file ~/.iterate/backups/garple-2026-09-22.json \
  --organization garple --owners jonas@nustom.com misha@nustom.com
```

Capture writes a new mode-0600 JSON archive, a full Git mirror (`<file>.git`),
and a working clone (`<file>.repo`). It refuses to overwrite an earlier backup.
A `.pending` receipt distinguishes a failed capture from a completed archive.
Keep all these files outside the source repository. Never print or commit the
archive, even though its secret values are encrypted.

The archive contains the project slug, organization name and members, the
config repository's exact file tree, and each project secret's current encrypted
cell. It contains no encryption key or plaintext secret material. Capture checks
that each cell decrypts locally before declaring the archive usable.

Secret ciphertext authenticates its original context (project ID and path),
URL restrictions and revision. Those fields travel with the archive. Restore
opens it locally using the deployment's `APP_CONFIG_SECRETS__KEY` (or its retained
previous key during rotation), recreates an absent project with its archived ID,
then calls `itx.secrets.set` to encrypt it afresh under that same identity.
**Retain the encryption key.** A wrong key or altered binding fails before restore
creates users, organizations or projects.
The operator-only export bypasses project-authored rewrites; an ordinary project
owner cannot export encrypted cells.

Restore preserves the archived project ID when the project is absent. It recreates users and
organization memberships, restores secrets, then commits the config file tree
through the normal repository API. It verifies decrypted secret readback, the Git
tree, the project processor's published commit and membership roles. Reapplying
converges on the same project and config tree. A slug with a different ID, an archived
ID held by another project, existing projects in another organization, ambiguous organization names
and failed project creation are refused. Membership restoration adds/updates the requested members; it does not
remove unrelated memberships from an existing organization; the CLI writes them through the
operator's `organizations.create` and `organizations.addMember`.

`--organization` changes the destination organization. `--owners` replaces the
archive's requested member list with explicit owners. Without these flags, the
archived organization and roles are used.

When a project has no config repo, capture fails rather than claiming a complete
backup. `capture --config-repo /absolute/path/to/checkout` explicitly selects a
replacement local Git repository's `main` branch. Commit any intended changes
there before capture. The current repository API supports regular UTF-8 files;
capture refuses binary files, executable modes, symlinks and submodules it could
not restore exactly. Restore does not build or adapt legacy OS source code.

Seeds intentionally omit stream histories, derived state, user/org secrets,
OAuth sessions and grants, other repositories, files in R2, agents and workspaces.
Routes and deployment configuration remain owned by `envs.ts`. This is a selected
project recovery mechanism, not a complete database snapshot. Verify the restored
websites and external integrations separately before declaring recovery complete.

For an erase, inventory first:

```sh
pnpm --dir apps/os-next erase-data --env prd --yes-i-mean-prd --dry-run
```

The erase refuses shared data resources while another worker still binds them,
and refuses preview parents with multiple namespaces for a class. Retire any
confirmed predecessor's writers before erasing shared stores. The worker identity
and routes remain; Durable Objects, directory rows, both KV stores, R2 objects and
Artifacts repositories are emptied and verified. Deploy normally before applying
seeds. No seed command erases or deploys anything implicitly.
