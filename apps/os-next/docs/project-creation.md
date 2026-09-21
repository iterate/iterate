# Project creation

**The saga is implemented** (2026-09-21, PR #2760 and its follow-up). `session.projects.create()`
registers the directory entry, enables the `project` processor row on `/`, appends
`project/create-requested { slug, orgId }` there under the caller and returns the root context at
once. The project processor (`src/project/processor.ts`) runs the saga from state at head:

1. `itx.repos.create("/repos/config")` — the same collection a caller uses; a repo that exists answers at once;
2. when `main` is unborn, ONE seed commit: `worker.ts` (the project's homepage, a plain-JavaScript
   `WorkerEntrypoint` answering `Homepage of project <slug>`) and `AGENTS.md` (what the repo is);
3. `project/ingress-configured` on `/`, its target `itx.workers.get({ source: itx.repos.get('/repos/config').readFile('worker.ts', { commitOid }), cacheKey: commitOid })` — the apex answers that exact commit, keyed by it;
4. `project/created` — or `project/create-failed { error }` on any throw; a later `projects.create`
   of the same slug is a new attempt.

Every step is idempotent on its own, so an attempt lost with an incarnation is simply run again by
the next. The dash renders the facet's live state as the creation's progress (`apps/dash`,
`/projects/<slug>`: registered, the config repo seeded, the homepage published). The project
processor also maintains the catalog, and points the apex at every later commit of the config repo
(below); the platform never touches the seeded files again.

## Publication follows the config repo

**A commit to `/repos/config` IS its publication** (2026-09-21): the repo facet cross-posts
`repo/commit-completed { path, commitOid, … }` to `/`, the project processor keeps the latest one as
`configRepoTip` and points the ingress at it — `project/ingress-configured` with the target above, keyed
by the commit — so the apex serves the new `worker.ts` a moment after the commit. This is apps/os's
rule ("commits land on main and redeploy"), and it is what an agent needs: its scripts run in
`<agent>/sandbox`, which never reaches `/`, so the old recipe (append `project/ingress-configured` on
the root by hand) could not be followed from there — the prd project `dawg` showed exactly that. Proof:
`e2e/website-publication.e2e.test.ts`.

```ts
const repo = itx.repos.get("/repos/config");
// Probe the candidate WITHOUT committing: a broken commit takes the site down until the next one.
const probe = await itx.workers
  .get({ source: { "worker.js": candidate } })
  .fetch(new Request(projectUrl));
// Then commit — the publication follows.
await repo.writeFile("worker.ts", candidate);
// Fetch projectUrl until it shows the change before claiming publication.
```

The loader executes JavaScript; `.ts` does not imply transpilation. A cold load must read the pinned
revision even if the repository head advances (the target names the commit, and caches under it).
An explicit `project/ingress-configured` appended on `/` still points the apex wherever it says
(`target: null` disables it; an unconfigured apex returns 404) until the next commit of the config
repo moves it again. `<app>--<project>.<base>` uses `itx.apps.<app>`. Loading a worker has no
routing side effect.

## Proposed events and ownership

Follow the [OS project saga](../../os/src/domains/projects/project-processor-implementation.ts).
Event names below omit `events.iterate.com/`.

| Event                        | Stream                                                     | Meaning                                                                |
| ---------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| `project/create-requested`   | `/`                                                        | The directory row's facts (slug, org); a pinned template version later |
| `repo/create-requested`      | `/repos/config`                                            | Provision repository and seed files                                    |
| `repo/commit-completed`      | `/repos/config`                                            | Record actual seed commit                                              |
| `repo/created`               | `/repos/config`, cross-posted to `/` by the repo processor | Provisioning and seeding completed                                     |
| `project/ingress-configured` | `/`                                                        | Activate the probed revision                                           |
| `project/created`            | `/`                                                        | Terminal success (existence only; the state keeps its offset)          |
| `project/create-failed`      | `/`                                                        | Terminal failure, the error on the event                               |
| `project/worker-updated`     | `/`                                                        | Ready worker revision and commit                                       |

The API registers the directory entry, enables the project processor row and
appends the intent (both idempotent), and returns at once — the dash watches the
facet's live state for the terminal event. Caller disconnection must not cancel
this durable work: the processor runs it from state at head, after any eviction.

The repository processor owns provisioning/seeding (`itx.repos.create(path)` opens
it). Seeding needs durable recovery: reuse the repository and seed commit after
redelivery, including when a successful push lost its acknowledgement. Never overwrite subsequent
edits. Pin the template version in the request so deployment cannot change it
mid-recovery.

The project processor loads/probes the exact seed revision, then atomically
appends ingress, explicit userspace subscriptions, `project/created` and initial
`project/worker-updated`. `project/created` is the first userspace lifecycle event;
subscriptions start there, excluding bootstrap history. Creation does not wait
for userspace handlers.

## Recovery, edits and rollout

Deterministic provisioning/build failures emit `project/create-failed` with
request offset, stage and error. Transient retries need explicit bounds and an
exhaustion outcome. Stable idempotency keys deduplicate effects; only authoritative
terminal events matching the open intent can complete creation.

Later config commits use the same load/probe/activate flow, ending in
`project/worker-updated` or `project/worker-update-failed`. Keep the last verified
revision on failure. The project processor owns activation. Existing nonempty
repos and mappings require deliberate adoption, preserving files and app rules.

The deployed runtime retired only the exact former automatic config subscription;
custom subscriptions and historical events remain. An inventory of 1,423 projects
found no custom root mappings needing adoption. Agents now receive project identity
and explicit-publication instructions. Automatic repo publication and project
bootstrapping still require this saga.

Acceptance must cover fresh API creation, file discovery, real public HTTP,
subsequent edits, duplicate requests, restart at external-effect boundaries,
seed preservation, bounded failure/recovery and no premature userspace execution.
The bench proof published the requested joke, verified HTTP/content, returned the
hostname on a fresh follow-up and ended with no pending work or warnings/errors.
