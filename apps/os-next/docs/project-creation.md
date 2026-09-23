# Project creation

`session.projects.create({ project, orgId?, configRepoTemplate? })` records a durable creation
request and returns the project's root context. The dashboard follows the creation state until it
reaches `project/created` or `project/create-failed`.

The project processor creates `/repos/config`, then seeds it only when `main` is unborn. A template
may be a public GitHub repository or subdirectory. Its ref is resolved to a commit before the
request is recorded, so recovery always uses the same source. Templates must contain `worker.ts`;
the built-in minimal template is used when none is supplied. Built-in choices come from
[configs-next](../../../configs-next/README.md).

If the seed includes `iterate.json`, its `events` list configures the initial userspace
subscription before `project/created`. The optional agents template installs that subscription;
the platform does not add agent lifecycle behavior by itself.

The processor points ingress at the exact seed commit and emits `project/created`. Interrupted
attempts reuse the repository and seed commit; existing repositories and later edits are preserved.
A failure emits `project/create-failed`, and a later create call can start another attempt.

## Publishing

A commit to `/repos/config` emits `repo/commit-completed`, and the project processor publishes the
resulting pinned revision. `worker.ts` must be executable JavaScript; a `.ts` extension does not
cause transpilation. Probe a candidate with `itx.workers.get({ source }).fetch(...)` before
committing it.

An explicit `project/ingress-configured` remains in effect until the next config commit. Loading a
worker alone does not create a route.

`src/project/templates.test.ts` covers template copying, ordering, failures, and recovery;
`e2e/session.e2e.test.ts` covers creation; `e2e/website-publication.e2e.test.ts` covers publishing.
