# Project creation

**The saga is implemented** (2026-09-21, PR #2760 and its follow-up). `session.projects.create()`
registers the directory entry, enables the `project` processor row on `/`, appends
`project/create-requested { slug, orgId }` there under the caller and returns the root context at
once. The project processor (`src/project/processor.ts`) runs the saga from state at head:

1. `itx.repos.create("/repos/config")` — the same collection a caller uses; a repo that exists answers at once;
2. when `main` is unborn, ONE seed commit: `worker.ts` (the project's homepage, a plain-JavaScript
   `WorkerEntrypoint` answering `Homepage of project <slug>`) and `AGENTS.md` (what the repo is);
3. `project/ingress-configured` on `/`, its target `itx.workers.get({ source: itx.repos.get('/repos/config').modules({ commitOid }), cacheKey: commitOid })` — the repo's whole tree at that exact commit as the worker's modules (`worker.ts` the main module, every `.js` file under its own path), keyed by the commit;
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
