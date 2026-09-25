# Project creation

`session.projects.create({ project, orgId?, configRepoTemplate? })` records a durable creation
request and returns the project's root context. The dashboard follows the creation state until it
reaches `project/created` or `project/create-failed`.

The project processor creates `/repos/config`, then seeds it only when `main` is unborn. A template
may be a public GitHub repository or subdirectory. Its ref is resolved to a commit before the
request is recorded, so recovery always uses the same source. Templates must contain `worker.ts`;
the built-in minimal template is used when none is supplied. Built-in choices come from
[configs](../../../configs/README.md).

If the seed includes `iterate.json`, its `events` list configures the initial userspace
subscription before `project/created`. The optional agents template installs that subscription;
the platform does not add agent lifecycle behavior by itself.

The processor points ingress at the exact seed commit and emits `project/created`. Interrupted
attempts reuse the repository and seed commit; existing repositories and later edits are preserved.
A failure emits `project/create-failed`, and a later create call can start another attempt.

## Publishing

A commit to `/repos/config` emits `repo/commit-completed`, and the project processor publishes the
resulting pinned revision. `worker.ts` is the main module. Files may be TypeScript (types are
stripped, not checked) and import each other by relative path. `iterate/*` and `zod` come from the
platform; any other package is listed in `package.json` and fetched from npm through esm.sh, locked
per dependency set (`src/context/module-resolution.ts`). Probe a candidate with
`itx.workers.get({ source }).fetch(...)` before committing it.

An explicit `itx/ingress-configured` remains in effect until the next config commit. Loading a
worker alone does not create a route.

## A config repo on GitHub

A repo remembers one remote, as git does: `repo.setOrigin(url)` records `repo/origin-set` on the
repo's log, and its state (`origin()`, the live state) names it. `pull()` and `push()` keep the repo's
`main` and the remote's `main` one history. The pack one side's upload-pack answers is forwarded
unchanged to the other side's receive-pack, so commits keep their oids and binary files their bytes.
Both are fast-forward only, proven inside the pack; otherwise they throw `NOT_FAST_FORWARD` with
`{ ours, theirs }`. `{ force: true }` makes the pull reset `main` to the remote's, or the push
overwrite the remote's. A pull that moves `main` emits `repo/commit-completed`, so a pull into
`/repos/config` publishes like a commit.

```ts
const repo = itx.repos.get("/repos/config");
await repo.setOrigin(
  'https://x-access-token:getSecret("/secrets/github-acme", { field: "accessToken" })@github.com/acme/config.git',
);
await repo.pull(); // { status: "updated", commitOid, previousOid }, or "up-to-date"
await repo.push({ force: true }); // iterate's main wins
```

The remote is reached through the context's egress. Its userinfo becomes a Basic credential, as git
and curl send it, and egress substitutes a secret placeholder inside that credential (`secrets.ts`),
so origin stores a placeholder, never a token. A GitHub connection's secret is pinned to
`https://github.com` as well as the API, for git over HTTP. The Dash's project overview links the
config repo (Config repo). A project's own code, such as a processor on the GitHub connection's log,
keeps the two in step: it pulls on a push webhook and pushes on `repo/commit-completed`.
`src/repo/durable-object.test.ts` covers the verbs against a fake remote, and
`e2e/repos.e2e.test.ts` covers real Artifacts and GitHub.

`src/project/templates.test.ts` covers template copying, ordering, failures, and recovery;
`e2e/session.e2e.test.ts` covers creation; `e2e/website-publication.e2e.test.ts` covers publishing.
