# Project creation

`session.projects.create({ project, orgId?, configRepoTemplate? })` records a durable creation
request and returns the project's root context. The dashboard follows the creation state until it
reaches `project/created` or `project/create-failed`.

The project processor creates `/repos/config`, then seeds it only when `main` is unborn. A template
may be a public GitHub repository or subdirectory. Its ref is resolved to a commit before the
request is recorded, so recovery always uses the same source. A template's `package.json` names
its main module in `"main"`. A creation that names none gets core's minimal config, a homepage
and nothing else ([`core/configs/minimal`](../../configs/minimal)). The presets a deployment offers
are [core's configs](../../configs/README.md) and any others its build is given (`scripts/build.ts`
`--template`), all seeded without a GitHub request; the dash and the consent page start a person's
project from the one whose folder is `default`.

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

Every commit fact gets one outcome on `/`, as the generation of the fact's offset
(`src/project/publication.ts` says how): a commit that is `main`'s head as its publication begins
is published — the commit's manifest, its probe, then the pointer `itx.config` and
`project/worker-updated { commitOid, generation, modules }` in one batch, so `/` never holds one
without the other — and a commit main moved on from first is `project/worker-update-failed`. A
caller waits for its commit's outcome by its oid:
`waitForEvent({ type: [...], payload: { commitOid }, afterOffset })`. Within the rule snapshot TTL
of that outcome (5 s, `src/context/rule-snapshots.ts`) every context resolves through the new
pointer: every context's events reach that worker's `processEvent` through their birth
subscription, the project's hosts serve its `fetch`, and a facet named by it (`itx.cd('/').config`
as its source) restarts on its next call when its own module's identity changed; a commit may drop a
Durable Object class or its whole module, and a facet that names it fails its next call, naming it.
A commit the probe refuses is `project/worker-update-failed` with why, and `itx.config` stays where
it was; a platform failure is met again within a minute, then leaves the commit owed to the
project's next incarnation. Probe a candidate with
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
`test/vitest/os/repo-durable-object.test.ts` covers the verbs against a fake remote, and
`test/vitest/os/repos.e2e.test.ts` covers real Artifacts and GitHub.

`src/project/templates.test.ts` covers template copying, ordering, failures, and recovery;
`src/project/processor.test.ts` the publication; `test/vitest/os/session.e2e.test.ts` covers creation;
`test/vitest/os/website-publication.e2e.test.ts` covers publishing.
