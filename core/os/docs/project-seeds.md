# Project recovery seeds

Use `pnpm os:project-seed` to capture, check and restore selected
projects across a deliberate environment erase. Always select `--env` explicitly.

```sh
pnpm os:project-seed capture \
  --env prd --project garple --file ~/.iterate/backups/garple-2026-09-22.json
pnpm os:project-seed check \
  --env prd --file ~/.iterate/backups/garple-2026-09-22.json
pnpm os:project-seed apply \
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
cell, the project's own hostnames (`hostnames`, below) and its fetch routes
(`fetchRoutes`, below). It contains no encryption key or plaintext secret
material. Capture checks that each cell decrypts locally before declaring the
archive usable.

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
tree, the project processor's published commit and membership roles. Every step converges: reapplying
converges on the same project, config tree and hostnames, and finishes an apply
that a failure or a deploy cut short.

**A rerun resets the project to the archive; it is only safe inside the restore
window.** It commits the archived config tree again (deleting files added since and
reverting later edits), sets every archived secret back to its archived value
(reverting a rotated key or a refreshed OAuth token), and adds the archive's members,
or the `--owners` given. Rerun it with the same `--organization` and `--owners` as the
first run.

A slug with a different ID, an archived
ID held by another project, existing projects in another organization, ambiguous organization names
and failed project creation are refused. Membership restoration adds/updates the requested members; it does not
remove unrelated memberships from an existing organization; the CLI writes them through the
operator's `organizations.create` and `organizations.addMember`.

`apply` creates the project with the operator's `projects.create` into the named
organization, and calls it again for a project that already exists. Every creation,
a person's or the operator's, lands `organization/project-added` on the
organization's activity under the project's idempotency key, so a rerun, or two
creations at once, write no second event.

`--organization` changes the destination organization. `--owners` replaces the
archive's requested member list with explicit owners. Without these flags, the
archived organization and roles are used.

When a project has no config repo, capture fails rather than claiming a complete
backup. `capture --config-repo /absolute/path/to/checkout` explicitly selects a
replacement local Git repository's `main` branch. Commit any intended changes
there before capture. The current repository API supports regular UTF-8 files;
capture refuses binary files, executable modes, symlinks and submodules it could
not restore exactly.

### A config repo for a newer platform

`apply` restores a config tree byte for byte, so a tree written for an older platform must be
migrated in a checkout before capture, with `--config-repo` naming it. For a platform whose SDK has
`IterateConfigEntrypoint` (core/configs/default is the reference):

- `worker.ts` extends `IterateConfigEntrypoint` from `iterate/sdk`, not `ConfigWorker`, and types
  `processEvent`'s argument as `IterateConfigProcessEventArgs`;
- its `processEvent` has the init case: `installAgents(itx)` on the platform's
  `events.iterate.com/project/worker-updated` on `/`;
- `agents.ts` re-exports `AgentCollectionDurableObject` and `AgentDurableObject` from
  `iterate/agents`, which the platform ships, and the root `package.json` lists no
  `@iterate-com/agents`;
- the `agents/` folder and `iterate.json` are gone.

## Hostnames

`hostnames` lists every custom hostname the project serves at capture (a Cloudflare
for SaaS custom hostname the processor provisioned, with no removal pending), for
example `["garple.com"]`. A first add still in flight or one that was refused is not
recorded.

After the config is published, `apply` appends `project/hostname-add-requested` for
each archived hostname the project does not serve. This is the same event the dash's
Domains page appends. `apply` then waits for the answers, 60 s in total for all
of the seed's hostnames, and prints Cloudflare's status for each. A hostname already
served is left alone, so a rerun requests nothing. A refused hostname fails `apply`
with its name and the reason; so do answers still missing after 60 s, naming the
hostnames. `erase-data` does not delete the Cloudflare custom
hostname and the owner's CNAMEs are on their own DNS, so the add finds the existing
custom hostname and the answer is usually `active` straight away. The project claims
a hostname only once its ownership record, the TXT record `_iterate.<hostname>` with
`iterate-project=<project id>`, is in DNS. A seed restores the project's id, so a
hostname whose owner added that record is claimed and served again; one without it
comes back unclaimed, and the Domains page shows the record to add.

`primaryHostname` records the project's primary hostname (one of `hostnames`), or
null. After the hostnames, `apply` appends `project/primary-hostname-configured` for
it, the event the dash's Make primary appends, unless the project already has it, and
waits for the project processor to reduce it. The reduce takes only a hostname whose
certificate is active. After an erase Cloudflare still holds it, so it usually is;
one still pending is not made primary, and `apply` says so rather than failing: make
it primary on the dash's Domains page once it serves.

Hostnames are restored only when `apply` targets the deployment the archive was
captured on (`source.platform`), because a custom hostname lives on that
deployment's SaaS zone. Onto any other deployment, `apply` skips them and says so.

## Fetch routes

`fetchRoutes` lists the project's fetch routes at capture as `itx.fetchRoutes.list()`
answers them: name, `requestMatcher`, `target`, `authRequirement` and `priority`.
`capture` skips a route to a lent stub, such as `iterate tunnel`'s `tunnel-<name>`,
and prints its name: the route ends with its lend, and a seed carries no lend. Run
the tunnel again after `apply`. `check` validates each route with the platform's own
rules, so an archive whose route `itx.fetchRoutes.set` would refuse fails before
`apply` touches the deployment.

After the config is published and before the hostnames, `apply` sets each archived
route with `itx.fetchRoutes.set`, so a restored hostname's first request takes its
route. A route of the same name becomes the archived one. `set` appends nothing for
a route that already matches, so a rerun sets nothing. A route the archive lacks is
left alone. `apply` reads each route back and prints whether it set it again.
Routes are restored onto any deployment: a `url.hostname` matcher matches only
requests on that host. `verify-structure` does not compare routes.

An archive from before seeds carried routes has no `fetchRoutes` and fails `check`.
Capture again; after an erase, add `"fetchRoutes": []` and set the routes by hand.

## Users and organizations

A project seed carries its organization's name and members. The deployment's whole
user and organization structure — members of every organization, users and
organizations with no project, the deployment's own `admin` organization — is a
separate file:

```sh
pnpm os:project-seed structure \
  --env prd --file ~/.iterate/backups/structure-2026-09-22.json
pnpm os:project-seed verify-structure \
  --env prd --file ~/.iterate/backups/structure-2026-09-22.json
```

`structure` writes a new mode-0600 file (emails, no secrets) and refuses to
overwrite one. `verify-structure` compares the deployment with it by what a
recreation keeps: organizations by name, members by email and role, projects by
ID, slug and organization name. It prints every difference and fails on a missing
project, membership, or organization with projects. A captured user who has not
signed in again, an organization with no projects (no seed carries one) and anything
new are printed as notes.

Only project IDs survive a recreation. `apply` recreates each member through
sign-in's find-or-create by email and each organization under a fresh ID; a
person's identity links (Google, Cloudflare) re-attach by email at their next
sign-in. Nothing outside the control plane names a user or organization ID —
grants, sessions and the `/users/<id>` and `/organizations/<id>` contexts are
erased with the deployment — so apply every project seed, then run
`verify-structure`.

Seeds intentionally omit stream histories, derived state, user/org secrets,
OAuth sessions and grants, other repositories, files in R2, agents and workspaces.
Worker routes and deployment configuration remain owned by `envs.ts`. This is a selected
project recovery mechanism, not a complete database snapshot. Verify the restored
websites and external integrations separately before declaring recovery complete.

## What a seed does not carry

An erase also removes what a project set up at runtime, and `apply` does not bring it back:

- **Integration connections:** the control plane's `integration_routes` row and the `project`
  facet's connection. The seed restores the secret `/secrets/<provider>-<connection>`, but without
  its route the platform mints no token for it and no webhook reaches the project.
- **Processors a session installed**, on the root and on each connection's log
  (`/integrations/<provider>/<connection>`), with the rewrite rules their installers wrote. For
  example the agents app, `@iterate-com/github-sync` and `@iterate-com/ai-linter`.
- **A repo's origin** (`itx.repos.get(path).origin()`).
- **Device client rules and schedules.**
- **Fetch routes to a lent stub**, such as `iterate tunnel`'s `tunnel-<name>`: run the tunnel
  again.
- **Config files that are not UTF-8.** `capture` refuses them, so a project that has one is
  captured with `capture --config-repo` from a checkout without it. The origin's history keeps
  it.

Restoring these is part of the recreate. On 2026-09-28 the prd `iterate` project came back
without its GitHub connection, sync and linter, left as an owner to-do, and nobody noticed for
18 hours.

Before the erase, list each project's processors and origin from an operator session
(`iterate repl --project <slug>`) and keep the output with the archive:

```ts
const { integrations } = (await itx.facets.get("project").snapshot()).state;
for (const path of ["/", ...Object.keys(integrations)])
  console.log(
    path,
    (await itx.cd(path).processors.list()).map(
      (row) => `${row.name} ${row.hostedFacet?.cacheKey ?? ""}`,
    ),
  );
console.log(integrations, await itx.repos.get("/repos/config").origin());
```

After `apply` and `verify-structure`, restore them in this order:

1. **Connections**, under the archived connection names, so the secret and the log keep their
   paths. For GitHub through iterate's App, an operator session calls
   `itx.integrations.connect("github", { installationId, connection })`. An admin of the GitHub
   account opens the `authorizationUrl` it answers once, in a browser signed in to the platform as
   a member of the project. GitHub skips its prompt for someone who authorized the App before, and
   the callback answers "Done: GitHub is connected". Other providers connect again from the Dash's
   Integrations page. Check that `integration_routes` has the row and that a webhook lands on the
   connection's log. To wait for a connect, read that row, or the project facet from
   `iterate repl` at most once a minute. Never loop `itx run` on `/`: every run wakes the root
   and writes three events to its log.
2. **Origins**, with `repo.setOrigin(url)` and the archived URL. When the origin still has the
   pre-erase history (the erase does not reach GitHub), make it the base again:
   `repo.pull({ force: true })` (the Dash's "Keep GitHub's"), commit on top whatever the recreate
   changed since the capture (a re-pin, for example), and `repo.push()`, which is fast-forward
   only. Never force-push the origin. Diff the two trees first, so nothing only the restored side
   had is lost. Both tips end at the same SHA.
3. **Processors**, with each installer as its README says (iterate/config's `install.ts` for
   the sync and linter). The same source gives the same `cacheKey` as the list.
4. **Check** the list again, then prove each connection once end to end. For the `iterate`
   project: a push to iterate/config arrives in `/repos/config` as the same commit, a commit in
   `/repos/config` reaches GitHub, and the "Iterate GitHub AI linter" check appears on a PR.

## Moving a deployment to a new Worker

A recreation onto a new Worker (a renamed `workerName` in `envs.ts`, fresh
resources from `ensure-resources`) needs no erase: the new Worker starts empty
and the old one keeps its data until its owner deletes it. Deploy the new Worker
beside the old one, restore onto it, then move the routes:

```sh
pnpm os:ensure-resources --env prd   # D1, KV, R2 and Artifacts namespace; commit the ids
pnpm os:deploy --env prd --without-routes
```

`--without-routes` deploys code, bindings and secrets with no routes: Cloudflare
refuses a route pattern another Worker holds (10020), so the operator moves each
route to the new Worker with the zone's route API, platform hostnames first. The
next ordinary deploy finds the routes already its own. Moving a route back is the
rollback.

For an erase, inventory first:

```sh
pnpm os:erase-data --env prd --yes-i-mean-prd --dry-run
```

**Pause merges to `main` from the erase until the last `apply` and `verify-structure`
have passed.** Every merge that touches the Worker runs Deploy OS, which redeploys prd
in the middle of the restore (#3032's deploy reset the Durable Objects under an `apply`).
Nothing enforces the pause. The owner,
or the agent running the recreate, announces it where the team merges, before the
erase, and lifts it after verification. Before the erase, check that no Deploy OS run
is in flight: Deploy OS reports a `Deploy OS / deploy` check run on each commit it
deploys, and every line below must read `completed`:

```sh
for sha in $(gh api 'repos/iterate/iterate/commits?sha=main&per_page=5' -q '.[].sha'); do
  gh api "repos/iterate/iterate/commits/$sha/check-runs?check_name=Deploy%20OS%20/%20deploy" \
    -q ".check_runs[] | \"${sha:0:9} \(.status) \(.conclusion)\""
done
```

If a deploy lands mid-restore anyway, wait for it to finish, then rerun `apply` for
every seed with the same `--organization` and `--owners` as the first run, then
`verify-structure`. Inside the restore window a rerun only finishes what was cut off.

**Never roll `os-prd` back until `verify-structure` passes, and never onto a version
tagged `erase-parked`.** The erase deploys a parked worker that deletes every Durable
Object class. Its version stays in the Worker's version list with that tag, and a
rollback onto it deletes every Durable Object again. After the deploy that follows
the erase, every project host answers 421 until `apply` recreates its project. The
post-deploy check posts that to #ci, says not to roll back, and passes. Any page it
posts names the exact `wrangler rollback <version>`, or says there is no safe target.
If a rollback lands on a parked version anyway, erase again, deploy, and rerun every
`apply`.

The erase refuses shared data resources while another worker still binds them,
and refuses a worker with two Durable Object namespaces of one class. Retire any
confirmed predecessor's writers before erasing shared stores. The worker identity
and routes remain; Durable Objects, both KV stores, R2 objects and Artifacts repositories
are emptied and verified, and the control plane's D1 loses its schema and migration
history. The deploy after the erase migrates the D1 from nothing; deploy normally before
applying seeds. No seed command erases or deploys anything implicitly.

Artifacts deletes a repository asynchronously: its name stays taken for a while after
the erase has verified the namespace empty. A config repo created meanwhile waits up to
20 s for the name (`TAKEN_NAME_WAIT_MS` in `src/context/cf-artifacts.ts`), then fails the
project's creation with that reason. Rerun `apply` for that seed once the deletion has
landed.
