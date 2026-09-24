# Project recovery seeds

Use `pnpm --dir apps/os project-seed` to capture, check and restore selected
projects across a deliberate environment erase. Always select `--env` explicitly.

```sh
pnpm --dir apps/os project-seed capture \
  --env prd --project garple --file ~/.iterate/backups/garple-2026-09-22.json
pnpm --dir apps/os project-seed check \
  --env prd --file ~/.iterate/backups/garple-2026-09-22.json
pnpm --dir apps/os project-seed apply \
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
config repository's exact file tree, each project secret's current encrypted
cell, and the project's own hostnames (`hostnames`, below). It contains no
encryption key or plaintext secret material. Capture checks that each cell
decrypts locally before declaring the archive usable.

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
tree, the project processor's published commit, membership roles, and that the
organization's record lists the project. Every step converges: reapplying
converges on the same project, config tree and hostnames, and finishes an apply
that a failure or a deploy cut short. A slug with a different ID, an archived
ID held by another project, existing projects in another organization, ambiguous organization names
and failed project creation are refused. Membership restoration adds/updates the requested members; it does not
remove unrelated memberships from an existing organization; the CLI writes them through the
operator's `organizations.create` and `organizations.addMember`.

`apply` creates the project with the operator's `projects.create` into the named
organization, and calls it again for a project that already exists. Every creation,
a person's or the operator's, lands `organization/project-created` on the
organization's record (the `organization` fold the dash lists an organization's
projects from) unless the record already has it. So a rerun writes no second event,
and a project the record lacks (restored before 2026-09-24) gets its event.

`--organization` changes the destination organization. `--owners` replaces the
archive's requested member list with explicit owners. Without these flags, the
archived organization and roles are used.

When a project has no config repo, capture fails rather than claiming a complete
backup. `capture --config-repo /absolute/path/to/checkout` explicitly selects a
replacement local Git repository's `main` branch. Commit any intended changes
there before capture. The current repository API supports regular UTF-8 files;
capture refuses binary files, executable modes, symlinks and submodules it could
not restore exactly.

## Hostnames

`hostnames` lists every custom hostname the project serves at capture (a Cloudflare
for SaaS custom hostname the processor provisioned, with no removal pending), for
example `["garple.com"]`. A first add still in flight or one that was refused is not
recorded. Archives captured before 2026-09-24 have no `hostnames` field and restore none.

After the config is published, `apply` appends `project/hostname-add-requested` for
each archived hostname the project does not serve. This is the same event the dash's
Hostnames page appends. `apply` then waits up to 60 s for each answer and prints
Cloudflare's status. A hostname already served is left alone, so a rerun requests
nothing. A refused hostname, or one with no answer within 60 s, fails `apply`
with its name and the reason. `erase-data` does not delete the Cloudflare custom
hostname and the owner's CNAMEs are on their own DNS, so the add finds the existing
custom hostname and the answer is usually `active` straight away.

Hostnames are restored only when `apply` targets the deployment the archive was
captured on (`source.platform`), because a custom hostname lives on that
deployment's SaaS zone. Onto any other deployment, `apply` skips them and says so.

## Users and organizations

A project seed carries its organization's name and members. The deployment's whole
user and organization structure — members of every organization, users and
organizations with no project, the deployment's own `admin` organization — is a
separate file:

```sh
pnpm --dir apps/os project-seed structure \
  --env prd --file ~/.iterate/backups/structure-2026-09-22.json
pnpm --dir apps/os project-seed verify-structure \
  --env prd --file ~/.iterate/backups/structure-2026-09-22.json
```

`structure` writes a new mode-0600 file (emails, no secrets) and refuses to
overwrite one. `verify-structure` compares the deployment with it by what a
recreation keeps: organizations by name, members by email and role, projects by
ID, slug and organization name. It prints every difference and fails on a missing
organization, membership or project. A captured user who has not signed in again,
an empty organization and anything new are printed as notes.

Only project IDs survive a recreation. `apply` recreates each member through
sign-in's find-or-create by email and each organization under a fresh ID; a
person's identity links (Google, Cloudflare) re-attach by email at their next
sign-in. Nothing outside the control plane names a user or organization ID —
grants, sessions and the `/users/<id>` and `/organizations/<id>` contexts are
erased with the deployment — so apply every project seed, then run
`verify-structure`.

Seeds intentionally omit stream histories, derived state, user/org secrets,
OAuth sessions and grants, other repositories, files in R2, agents and workspaces.
Routes and deployment configuration remain owned by `envs.ts`. This is a selected
project recovery mechanism, not a complete database snapshot. Verify the restored
websites and external integrations separately before declaring recovery complete.

## Moving a deployment to a new Worker

A recreation onto a new Worker (a renamed `workerName` in `envs.ts`, fresh
resources from `ensure-resources`) needs no erase: the new Worker starts empty
and the old one keeps its data until its owner deletes it. Deploy the new Worker
beside the old one, restore onto it, then move the routes:

```sh
pnpm --dir apps/os ensure-resources --env prd   # KV, R2 and Artifacts namespace; commit the ids
pnpm --dir apps/os run deploy --env prd --without-routes
```

`--without-routes` deploys code, bindings and secrets with no routes: Cloudflare
refuses a route pattern another Worker holds (10020), so the operator moves each
route to the new Worker with the zone's route API, platform hostnames first. The
next ordinary deploy finds the routes already its own. Moving a route back is the
rollback.

For an erase, inventory first:

```sh
pnpm --dir apps/os erase-data --env prd --yes-i-mean-prd --dry-run
```

**Pause merges to `main` from the erase until the last `apply` and `verify-structure`
have passed.** Every merge that touches the Worker runs Deploy OS, which redeploys prd
in the middle of the restore. On 2026-09-24 two merges redeployed prd during a
recreate: #3032's deploy reset the Durable Objects under an `apply` ("Durable Object
reset because its code was updated"), and #3033's landed during verification.
Nothing enforces the pause. The owner,
or the agent running the recreate, announces it where the team merges, before the
erase, and lifts it after verification. Before the erase, check that no Deploy OS run
is in flight (`depot ci run list --org 0p91s0lz49 --repo iterate/iterate`). If a deploy
lands mid-restore anyway, rerun `apply` for every seed once the deploy has finished,
then `verify-structure`. `apply` is idempotent, so a rerun only finishes what was cut
off.

The erase refuses shared data resources while another worker still binds them,
and refuses preview parents with multiple namespaces for a class. Retire any
confirmed predecessor's writers before erasing shared stores. The worker identity
and routes remain; Durable Objects, directory rows, both KV stores, R2 objects and
Artifacts repositories are emptied and verified. Deploy normally before applying
seeds. No seed command erases or deploys anything implicitly.
