# Project creation

`session.projects.create({ project, orgId?, configRepoTemplate? })` registers the directory entry,
enables the project processor on `/`, and records `project/create-requested`. It returns the root
context; the dashboard follows the creation state until success or failure.

An optional config template works like `apps/os`: a public GitHub repository or subdirectory is
copied into the project's independent config repository. Both platforms use the same reference
parser and downloader in `packages/shared/src/config-repo-template`. The API resolves branches
and tags to a commit before persisting the request, so recovery cannot switch template versions.

`session.projects.templates()` returns the built-in choices. The dashboard also accepts custom
references (`github:owner/repo#ref&path:folder`). Omission selects the embedded minimal template.
Preset references must name a published commit containing [configs-next](../../../configs-next/README.md).

The project processor runs these steps from durable state:

1. Create `/repos/config` through the ordinary repository collection.
2. If `main` is unborn, download the pinned template (or use the embedded minimal files), require
   `worker.ts`, and make one seed commit. Existing repositories and later edits are preserved.
3. Read optional `iterate.json` from that commit. Its `events` array subscribes the config worker
   before `project/created`; without it, there is no lifecycle subscription.
4. Point ingress at the exact config commit, then emit `project/created`.

A throw emits `project/create-failed`; a later create call can open a new attempt. Recovery after
an interrupted attempt reuses the repository and existing seed commit. Creation does not wait for
userspace lifecycle handlers; their progress and failures belong to their stream subscription.

The minimal template has no agents. The optional agents template installs a userspace collection
and the `itx.agents` rewrite from `apps/agents`. No agent lifecycle or catalog is built into the
platform's project processor.

## Publication follows the config repo

A commit to `/repos/config` cross-posts `repo/commit-completed` to `/`. The project processor
updates ingress to the new commit. The loader reads that pinned revision, even if the repository
head advances. `worker.ts` must contain executable JavaScript; `.ts` does not imply transpilation.
Probe candidate code with `itx.workers.get({ source }).fetch(...)` before committing it.

Explicit `project/ingress-configured` still overrides ingress until the next config commit.
Loading a worker by itself has no routing side effect. The initial config lifecycle subscription is pinned to the seed commit; changing its code or
event filter requires reconfiguring the subscription explicitly.

Tests: `src/project/templates.test.ts` covers copying, ordering, failures and recovery;
`e2e/session.e2e.test.ts` covers creation; `e2e/website-publication.e2e.test.ts` covers publication.
