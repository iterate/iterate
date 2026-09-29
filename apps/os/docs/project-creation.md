# Project creation

`session.projects.create({ project, orgId?, configRepoTemplate? })` records a durable creation
request and returns the project's root context. The dashboard follows the creation state until it
reaches `project/created` or `project/create-failed`.

The project processor creates `/repos/config`, then seeds it only when `main` is unborn. A template
may be a public GitHub repository or subdirectory. Its ref is resolved to a commit before the
request is recorded, so recovery always uses the same source. A template's `package.json` names
its main module in `"main"`; the built-in default template is used when none is supplied. Built-in choices come from
[configs](../../../configs/README.md).

Once the seed's publication has landed, admitted or refused (below), the processor points the
project's ingress at its published config, `itx.config`, once, and emits `project/created`. Interrupted attempts reuse the repository and seed commit; existing repositories
and later edits are preserved. A failure emits `project/create-failed`, and a later create call can
start another attempt.

## Publishing

A commit to `/repos/config` emits `repo/commit-completed`, and the project processor publishes it
(`src/project/publication.ts`); `package.json`'s `"main"` names the main module. Files may be
TypeScript (types are stripped, not checked) and import each other by relative path. `iterate/*` and
`zod` come from the platform; any other package is listed in `package.json` and fetched from npm
through esm.sh, locked per dependency set (`src/context/module-resolution.ts`).

A commit fact only wakes the publication, which publishes `main`'s head as the generation of the
fact's offset on `/`, so a return to a commit published before is a publication of its own. It
builds the commit's manifest: each top-level module (a `.ts` or `.js` file at the repo's root) by the
identity of what the loader loads with it as the main module, and the Durable Object classes it
exports. Every top-level module must resolve. Its probe loads them in one worker and admits the
commit when the main module's default export is an `IterateConfigEntrypoint` that constructs and
every class the last publication exported is still exported; a side script that throws as it is
imported keeps its identity and exports no class. Then, as the platform, the rule `itx.config` names
the commit's worker with its manifest — its write answers once no context resolves through an older
snapshot of `/` — and `project/worker-updated { commitOid, generation, modules }` lands: every
context's events reach that worker's `processEvent` through their birth subscription, the project's
hosts serve its `fetch` (so one version of the config worker runs at a time), and a facet named by
it (`itx.cd('/').config` as its source) restarts on its next call when its own module's identity
changed. Only the platform writes `itx.config`, and only its rule vouches for a manifest. A commit
the probe refuses is `project/worker-update-failed` with why, and `itx.config` stays where it was. A platform failure (esm.sh, a module lock, the probe's
load) is met again after 5 s and 30 s within a minute; then `project/worker-update-failed` with
`unavailable` leaves the commit owed to the project's next incarnation. Probe a candidate with
`itx.workers.get({ source }).fetch(...)` before committing it.

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

The remote is reached through the CALLER's egress, its own `itx.fetch` through its own rules
(`library.ts`), never the repo's: a context that may not fetch reaches no remote through a repo. The
URL's userinfo becomes a Basic credential, as git and curl send it, and egress substitutes a secret
placeholder inside that credential (`secrets.ts`). An origin's credential must be a plain user name
and one placeholder, so an origin stored on the log never holds a token. A GitHub connection's secret is pinned to
`https://github.com` as well as the API, for git over HTTP. The Dash's project overview links the
config repo (Config repo). A project's own code, such as a processor on the GitHub connection's log,
keeps the two in step: it pulls on a push webhook and pushes on `repo/commit-completed`.
`src/repo/durable-object.test.ts` covers the verbs against a fake remote, and
`e2e/repos.e2e.test.ts` covers real Artifacts and GitHub.

`src/project/templates.test.ts` covers template copying, ordering, failures, and recovery;
`src/project/processor.test.ts` the publication; `e2e/session.e2e.test.ts` covers creation;
`e2e/website-publication.e2e.test.ts` covers publishing.
