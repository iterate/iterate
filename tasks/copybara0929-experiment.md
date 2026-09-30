---
status: in-progress
size: small
---

# Copybara experiment: one-way copies of parts of iterate/iterate

**Status:** done. Self-hosting works from the copy: Misha ran the recipe against iterate/os0929 from an empty folder, and it worked. This PR never merges: it's the experiment and the reference for doing it for real.

- Round 1: Copybara keeps a one-way copy in sync (catch-up, drift, deletes, messages, backlinks).
- Round 2: the `copybara/` layout, two copies, each getting exactly its own commits.
- Round 3: the copy holds what the self-host build needs, with its own root manifests (dependencies a subset of the root's). CI runs the recipe against a fresh clone after every copy.
- Round 4: the real recipe change (2 lines), a public copy, and a published package build for every commit a copy can name. Misha's run worked.
- Open: the inputs for `core/`, `iterate/packages` (left unresolved), and what else changes when iterate/iterate goes private.

## Why

From the 2026-09-29 Tuple call with Jonas (`1b5f47c9`): iterate/iterate goes private, and public repos (`iterate/os`, `iterate/packages`) become one-way copies of parts of it. Before doing that for real, check that Copybara can keep such copies in sync, and settle where their files live. The real thing will likely start over from what this teaches, so this PR never merges.

## Goal

When a commit of iterate/iterate deploys successfully, each copy's `main` catches up to that commit. Nothing flows back.

- **iterate/os0929:** `apps/os` and `packages/iterate`, today's stand-ins for `core/os` and `core/lib`, plus its README.
- **iterate/packages0929:** every other package, plus its README.

## Copybara or a custom CLI?

Copybara. It was built for this job (Google's internal monorepo → public GitHub repos):

- It keeps its sync state in the destination. Every destination commit gets a `GitOrigin-RevId: <origin sha>` trailer, and each run migrates the origin commits after the newest one. A missed or cancelled run is fixed by the next one. We'd have to write that ourselves in a custom CLI.
- `origin_files` picks the files. `core.move` puts the README in place. `metadata.scrubber` trims commit messages (needed for a public `iterate/os`). `authoring` maps authors.
- Weekly releases ship a `copybara_deploy.jar` (latest `v20260928`), so there's no Bazel build. It needs Java 25+: its class files are version 69, though its README still says 21.
- If we ever take outside contributions, `git.github_pr_origin` can import a fork's commit into iterate/iterate. That fits the "send us a compare link in an issue" plan.

Costs: a JVM in CI, Starlark config, and reference-style docs. iterate/iterate is 1.25 GB on GitHub. `git.origin(partial_fetch = True)` fetches only the files matching `origin_files`, and Depot Cache can keep Copybara's cache between runs.

A custom CLI is better only in two cases: (a) we want the sync to run on the iterate platform (Workers can't run Java), or (b) the copy needs logic Starlark can't express. Neither applies yet. If Copybara turns out painful, the fallback is a ~150-line snapshot script (copy the tree, commit with an `Origin-RevId` trailer, push). This experiment tells us which.

Other known approaches, not chosen:

- **splitsh-lite / `git subtree split`** (Symfony's and Laravel's read-only package repos): fast and history-preserving. But it copies commit messages word for word, can only map one folder to the root, and can't add a README from elsewhere.
- **`git filter-repo` in CI + force-push**: rewrites all history on every run and force-pushes whenever the filter changes.

## How "stays in sync" is normally done, and how it fits here

The usual setup:

1. Run the sync on every push to the origin branch.
2. Because the sync catches up and running it twice changes nothing, missed runs don't matter. A scheduled run is the backstop.
3. The destination is read-only: only the sync bot may push to its `main`.
4. Only one run at a time: a concurrency group per destination.

For us, the copy only moves when a deploy succeeds, not on every push:

- **Trigger:** a `copybara` job at the end of `.depot/workflows/deploy-os.yml`. It runs after the deploy and the project-host check pass, and migrates up to the deployed sha: `copybara migrate … <sha>`. Depot has no `workflow_run`, so the job lives in the deploy workflow. It's a separate job, so a failed sync never touches the deploy. The deploy's concurrency group (`deploy-os-production`, never cancelled) already runs one at a time. The copy's `main` therefore only ever points at a commit that deployed.
  - Deploy OS ships `packages/iterate`, `packages/shared` and `packages/ui`. The other packages go out through pkg.pr.new on every main push, which isn't a deploy. A commit that only touches, say, `packages/agents` reaches the copy with the next OS deploy. Copybara's catch-up means nothing is lost.
  - A manual catch-up is the same script run from a laptop (`node scripts/ci/copybara.ts --sha <sha>`), which reads the same Doppler config.
- **Release:** for now the `GitOrigin-RevId` trailer names the origin commit, and that's enough. Later options: `git.destination(tag_name = …)` tags the copy (for example with the daily `v…` release tag from `release.yml`), or a `Deployed-Version:` line carries the Worker version id that deploy-os already reads from `/version`.
- **Credentials:** the existing iterate GitHub App (app 2001598). It's installed on all of the org's repos with Contents: write, so it reaches a copy repo as soon as the repo exists. Its key is in os/prd `APP_CONFIG`. The job mints an installation token narrowed to the copy repos and `permissions: { contents: "write" }`, with the code the flake dashboard used to narrow one to issues (now `scripts/ci/iterate-app-token.ts`). A leaked token can only write the copies, for an hour.
  - The repo keeps this key out of PR workflows by convention: only the schedule-only flake dashboard reads it (`depot-workflows.test.ts` pins that one). Nothing enforces it, though. Depot runs no PRs from forks, so every run is from someone who can push, holding the one `DOPPLER_TOKEN`, which reads os/prd (`docs/depot-ci.md`). The deploy-os job only runs on main and already holds prd's credentials. The temporary Preview OS job below bends the convention for this one PR.
  - No PAT and no new App. Doppler has no PAT anyway. Its only other GitHub key is `PREVIEW_GITHUB_APP_PRIVATE_KEY`, which belongs to the dummy-petshop's fake GitHub, not github.com.
  - Later, the copy's ruleset can say "only the iterate App may push to `main`".
- **While on the branch:** Deploy OS only runs on main (dispatching it on a branch would deploy the branch to prd), but the PR's own deploy is Preview OS. A **temporary** `copybara` job at the end of Preview OS's Deploy preview, only for this PR's branch, copies the PR head to each copy's `main`. It runs only when Deploy preview actually deployed something (the `cleanup` job's condition), so the branch phase exercises the deploy gate too. A push that cancels the run in progress tests catch-up for free. Since the PR never merges, it stays.
  - Local runs (Homebrew's `openjdk` 26, since Copybara needs 25+) are for getting the config right before pushing.
- **Other GitHub Apps:** about 20 apps are installed on "all repositories" in the org (cursor, claude, devin, graphite, autofix-ci, linear, depot, cloudflare-workers-and-pages, iterate, iterate-preview-1, iterate-misha, …), so they attach to the new repo automatically. For a private copy with no PRs and no workflows they do nothing. For a public `iterate/os` that's "locked down to the max", switch them to selected repositories.
- **The iterate platform:** `@iterate-com/github-sync` keeps two remotes on _one_ history (fast-forward only, same commits). A copy of a subset of files needs different commits, so github-sync can't do this. A platform-native version (the push webhook starts a processor that pushes the copy) would be a good user-space test later. It would need the custom-CLI route, and a test of the platform's git on a 1.25 GB repo. Not for this experiment.

## Round 3: self-hosting from the copy

**The test:** the self-host recipe (`apps/os/public/setup-prompt.md`, served at os.iterate.com/setup-prompt.md) has to keep working with only its clone URL changed. So a fresh clone of the copy must pass:

```bash
git clone --depth 1 https://github.com/iterate/os0929 && cd os0929
pnpm install --frozen-lockfile                       # the recipe runs plain `pnpm install`; frozen proves the lockfile
CLOUDFLARE_ENV=self-host pnpm --filter os build
cd apps/os && pnpm exec wrangler deploy --config dist/server/wrangler.json --dry-run
```

A real deploy needs a Cloudflare account with Artifacts access; the dry run proves the repo side.

**What the build needs outside `apps/os`** (traced from `apps/os/scripts/build.ts`, `generate-wrangler-config.ts` and `vite.config.ts`):

- the workspace packages `packages/iterate`, `packages/shared` and `packages/ui`
- `envs.ts`, and `scripts/lib/{deploy-helpers,env-context,wrangler-config}.ts`
- `configs/`, which `build.ts` bakes in as project templates
- root files: a `package.json`, `pnpm-workspace.yaml` and `pnpm-lock.yaml`, `tsconfig.base.json`, `.nvmrc`, and the `patches/` the lockfile uses

**Why the root files can't be copied as they are:**

- The root lockfile covers all 22 workspace packages, so `--frozen-lockfile` fails in a copy with 4.
- The root `package.json` runs husky and `scripts/lockfile-stamp.ts` on every install, and lists devDependencies for lint, specs and CI.
- `pnpm-workspace.yaml` lists 22 packages, and its catalog, overrides and patches cover all of them.

**The plan:**

- [x] The `os` workflow copies the build's files, listed by hand in `copybara/copy.bara.sky` _(apps/os, packages/{iterate,shared,ui}, configs/, envs.ts, 3 scripts/lib files, 2 tsconfigs, .nvmrc, and both patches: apps/os uses @cloudflare/vitest-plugin too)_
- [x] `copybara/os/package.json`: the copy's root manifest, written by hand. No scripts, and only the dependencies the root-level files import _(zod and @iterate-com/shared)_
- [x] `copybara/os/pnpm-workspace.yaml` and `copybara/os/pnpm-lock.yaml`, generated from the root's: the copy's 4 packages, the root's settings, and the catalog, patches and lockfile trimmed to what those packages use. `pnpm install --lockfile-only` in a scratch folder holding only the copy's manifests does the trimming _(`node scripts/ci/copybara.ts root`, ~6 s: lockfile 15.7k → 10.4k lines. pnpm trims the catalog itself (`cleanupUnusedCatalogs`) and rewrites the workspace file without comments)_
- [x] **Dependencies are a subset of the root's:** every package the copy's lockfile resolves is in the root lockfile at the same version. Each copied package's lockfile entry equals the root's, and `copybara/os/package.json` asks for the same versions as the root. The copy never resolves anything the root hasn't _(checked as versions and integrity. Peer contexts and `optional` flags legitimately differ: trpc-cli is locked without the `effect` another package brings, and 9 packages are optional in the copy)_
- [x] A check fails when the generated files are stale or break the subset rule _(`root --check`, first in both copy jobs, printing the diff. It first went stale on CI only: a laptop's pnpm metadata cache gave crossws another peer range, so the generator now runs pnpm with an empty cache of its own)_
- [x] The Copybara job clones the copy fresh after each push and runs the four commands above _(CI: the job took 65 s in all. Setup, both copies ([os0929 dc3dd69](https://github.com/iterate/os0929/commit/dc3dd6965d9c1111c4def14f45fcaa8ab2406a3b), [packages0929 5ffb336](https://github.com/iterate/packages0929/commit/5ffb33681fd7a9bb324a96a63dfac22c680a47e1)), then a fresh clone of os0929: frozen install 1.8 s with a warm store, the self-host build, the dry-run deploy, and `iterate/node` and `capnweb` importing. A failed Deploy preview (the kit app's new hostname 404ing) skipped the job, as a failed deploy should)_
- [x] ~~**Templates are baked** (option A in the explainer): every `configs/` template goes into the Worker as `default` already does, each file with its source path, target path and content (the fields a shadcn registry item has). A creation records `builtin:<name>@<build sha>`. Custom `github:owner/repo#…` templates are unchanged. A preview bakes the PR's own templates, so `preview-config.ts`'s quick-launch rewrite to the PR head goes~~ _(main's #3439 landed the same idea first: each preset's files are baked in (`templateFiles`), keyed by the build's `github:iterate/iterate#<sha>&path:configs/<name>` reference, so creation never downloads a preset. This branch's version was reverted. main's version broke the self-host build in the copy, though: it pins the templates' agents and voice at a pkg.pr.new build it finds through `git merge-base HEAD origin/main` and `.github/workflows/pkg-pr-new.yml`, neither of which a copy has. Fixed in iterate/iterate's source: `checkoutPublishedPackageCommit` returns the commit HEAD's `GitOrigin-RevId` trailer names)_
- [x] Record what `iterate/os` contains, as input for the `core/` restructure _(below)_

Later, not in round 3: a template registry served by the Worker (shadcn's item format), once features get added to existing projects. Links that name iterate/iterate (the MCP tool's examples link, the recipe's clone URL, `packages/iterate`'s npm metadata, the dash's commit links) wait for the real `iterate/os`.

## Round 4: the recipe, for real

Make the change that introducing `iterate/os` would really need, with `os0929` in place of `os`, and hand Misha a setup prompt to run from an empty folder.

- [x] iterate/os0929 is public, with issues on (the call's plan: issues are the feedback channel; pull requests are what's off)
- [x] pkg.pr.new publishes every push to `copybara0929`, as it does every push to main. A copy's build pins agents and voice at the commit its `GitOrigin-RevId` names, so that commit needs a build. This PR touches no published package, so until now nothing was published for it (`agents@3bf0f600a`: 404). Each push to the branch is one commit, as each squash merge is on main
- [x] The copy's root `package.json` has `"build": "CLOUDFLARE_ENV=self-host pnpm --filter os build"`
- [x] The recipe (`apps/os/public/setup-prompt.md`): the repo link and the clone, `git clone --depth 1 https://github.com/iterate/os0929 iterate`. Cloning into `iterate` keeps every later `iterate/apps/os` path as it is. That's the whole diff _(16b686221: 2 lines)_
- [x] Checked as a stranger would: an unauthenticated clone of os0929, the recipe's plain `pnpm install`, the build. The default template must pin agents and voice at the copy's origin commit, and pkg.pr.new must serve both builds. Then the dry-run deploy and a clean `git status`, and the PR's preview serving the new recipe _(unauthenticated clone at os0929 852884a: install, `pnpm build`, agents and voice pinned at 16b686221 with both builds on pkg.pr.new (200), migrations folder present, dry-run, imports, clean status; the preview `pr3434-8eb276e` served the copy's recipe byte for byte)_
- [x] Misha runs the recipe from an empty folder _(2026-09-29: Codex (gpt-6-sol, medium, fast) followed `https://pr3434-8eb276e-os.iterate-dev-preview.workers.dev/setup-prompt.md` in an empty `mishnusterate` folder, and it worked)_

Known wrinkle, not blocking: the named templates (`heartbeat`, `minimal`) are identified as `github:iterate/iterate#<copy commit>&path:configs/<name>`. Creation writes their baked files, so nothing downloads them. But in a copy's build the name points at a commit iterate/iterate doesn't have. A copy's build should name its own repo (`github:iterate/os0929#…`).

## Round 5: Copybara pins the templates' packages (2026-09-30)

Misha's decision on the default template (the explainer chip): no template moves and no released
versions; Copybara rewrites `@main` to `@<40-character iterate/iterate sha>` in the copied
`configs/*/package.json`, so the copy's templates name the pkg.pr.new build of the commit it was
copied from (every main commit is published).

- [x] `pin_template_packages` in copy.bara.sky, between the move and the message: `@main"` →
      `@<sha>"` in `configs/*/package.json`, the sha being `ctx.changes.current[0].ref` (the one
      change in ITERATIVE, the newest in the SQUASH the sync check runs)
- [x] apps/os/scripts/build.ts pins only a template dependency that still names `@main`, and works
      out the published commit only then. In iterate/iterate every template names `@main`, so
      nothing changes; in a copy nothing does, so the build never asks git for a merge base
- [x] the `GitOrigin-RevId` workaround in published-package-commit.ts is reverted to main's
- [x] main merged (#3447–#3473): the copy's file list drops `envs.ts`, `scripts/lib/deploy-helpers.ts`
      and `env-context.ts` (the build reaches none since #3448), takes `scripts/lib/vite-build.ts`
      and `patches/**` (the vitest-plugin patch is 1.3.2 now; by folder, a bump never breaks the
      copy again). `envs.ts` no longer goes public. The copy's root lockfile and workspace
      regenerated (`root`, then `root --check`: current)
- [x] Simulated locally (no Java here): the file list plus `copybara/os/`, the rewrite with main's
      sha, a fresh `git init` with no origin: frozen install, `CLOUDFLARE_ENV=self-host pnpm --filter
    os build`, `wrangler deploy --dry-run` all pass, and the baked template pins agents and voice
      at that sha. In iterate/iterate the build still pins every `@main`
- [ ] The branch's Copybara job syncs os0929 with the real transform and runs the self-host check

### What `iterate/os` contains, as input for `core/`

What the self-host recipe needs today, and where each piece would sit in the call's layout:

| Today                                                          | Why the recipe needs it                                              | In `core/`?                                                                                                                                                                                              |
| -------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/os`                                                      | the Worker                                                           | `core/os`. But it also carries internal tooling that has no business in a public copy: `scripts/preview*`, `erase-data`, `ensure-resources`, and `e2e/`, `perf/`, `bench/`. Those belong outside `core/` |
| `packages/iterate`                                             | the SDK, and the platform modules baked into the Worker              | `core/lib`                                                                                                                                                                                               |
| `packages/shared`, `packages/ui`                               | the Worker imports them (helpers, and the sign-in and consent pages) | inside `core/`, or a `core/` that stops importing them. As shared, unpublished packages they drag the copy's workspace wider                                                                             |
| `configs/`                                                     | baked into the Worker as project templates                           | with `core/os`, since the Worker ships them                                                                                                                                                              |
| `envs.ts`                                                      | the build reads its self-host environment from it                    | **no**: 511 lines of every app's environments, Cloudflare account ids, bucket and Doppler names. The OS build should import an OS-only module inside `core/`, and the rest stays private                 |
| `scripts/lib/{deploy-helpers,env-context,wrangler-config}.ts`  | the build's imports                                                  | inside `core/os`, or dropped from the build path                                                                                                                                                         |
| root `package.json`, workspace file, lockfile                  | install                                                              | the copy's own, generated (`copybara/os/`)                                                                                                                                                               |
| `tsconfig.base.json`, `tsconfig.app.json`, `.nvmrc`, 2 patches | the tsconfigs extend them; the lockfile applies the patches          | a `core/` tsconfig base; the patches follow the lockfile                                                                                                                                                 |

The rule the recipe check enforces is "`core/` builds from a clone of itself". That covers two things: no imports reaching outside `core/`, and no build step reading this repo's git history or CI files. `checkoutPublishedPackageCommit` was the first case of the second; the trailer handles it.

## Where the copies' files live (for the real `iterate/os`)

From the call: `iterate/os` is `core/`, which is `os/` plus `lib/` (the `iterate` npm package, the CLI with submodules like `iterate/sdk`). Unit and table tests inside `core/` go public. `test/` (end-to-end and Playwright) stays private, and so do tasks, evals and CI. `iterate/packages` is the other packages.

- **Copies keep this repo's paths:** `iterate/os` holds `core/…`, not `core/`'s contents moved to the root. A path in a comment, a stack trace or an agent's answer then means the same file in both repos. The cost is a folder for the files that exist only at a copy's root.
- **`copybara/<name>/` holds those root-only files,** copied there verbatim: `README.md`, and later `LICENSE`, `.github/ISSUE_TEMPLATE/` (the call's "link your fork's compare view in an issue") and maybe an `AGENTS.md` for agents reading the copy.
- **`copybara/copy.bara.sky` holds every copy's workflow.** Copybara only reads a config named `copy.bara.sky`, so per-copy files like `copybara/os.bara.sky` can't work. One file with a `copy_workflow()` helper covers all copies; nothing is generated.
- **Names not chosen:**
  - `repos/`: the platform already has repos (`itx.repos`, `/repos/config`).
  - `public/`: web tooling treats it as static assets.
  - `repo-projects/`: our call's word, meaningless to anyone else.
- **Open:** does `iterate/os` install and build on its own? Then it needs a root `package.json`, `pnpm-workspace.yaml`, tsconfig base and lockfile. The internal root's versions list private packages, so either `core/` carries its own, or `copybara/os/` holds public ones that can drift.

## Release versions in the copy

A pushed commit message is fixed, since changing it rewrites the copy's history. So what goes in depends on when the value exists:

- **Known when the copy runs** (anything Deploy OS knows, like the Worker version id): pass `--labels worker_version:<id>`. The config reads it as the label `FLAG_WORKER_VERSION`, in `metadata.add_header("… ${FLAG_WORKER_VERSION}")` or in `copy_message`.
- **From tags:** `git.origin(describe_version = True)` gives `git describe` labels, the nearest `v…` release tag plus a count.
- **Made later** (the daily `v…` tag from `release.yml`): a tag or GitHub release on the copy, on the commit whose `GitOrigin-RevId` is the released sha. `git.destination(tag_name = …)` also tags at copy time from a label.

## Design

Files in iterate/iterate (branch `copybara0929`, PR to main):

| File                                                   | What                                                                                                                                                                             |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `copybara/copy.bara.sky`                               | The `os` and `packages` workflows, and the message rewrite                                                                                                                       |
| `copybara/os/README.md`, `copybara/packages/README.md` | Each copy's root-only files, moved to its root                                                                                                                                   |
| `scripts/ci/copybara.ts`                               | `--sha <sha>`: mints one iterate App token for all copies, downloads the pinned jar (sha256-checked), and runs each workflow up to that sha. Then it runs each copy's sync check |
| `.depot/workflows/deploy-os.yml`                       | A `copybara` job after the deploy and the host check: the wiring on main, which this PR never exercises                                                                          |
| `.depot/workflows/preview-os.yml`                      | A `copybara` job after this PR's Deploy preview, only on this branch: what actually runs                                                                                         |

### Commit messages

A squash-merged PR's commit message is its title, ` (#123)`, and its body. HTML comments survive into the message: the `<!-- loc-report -->…<!-- /loc-report -->` and `<!-- os-preview -->…<!-- /os-preview -->` sections are in main's commits today. The copy's message is:

- the title, with `(#123)` rewritten to `(iterate/iterate#123)`. GitHub links `owner/repo#N` in commit messages across repos.
- then every paragraph between `<!-- copybara -->` and `<!-- /copybara -->`, in order. The markers are invisible on the rendered PR page and follow the same convention as the existing sections.
- then Copybara's `GitOrigin-RevId` trailer.

`copy_message` in `copybara/copy.bara.sky` does this. Copybara runs any `def f(ctx)` in `transformations` and has a `re2` regex module. A marker only counts on a line of its own.

Commits pushed straight to the experiment branch have no `(#N)`, so their title passes through unchanged.

### Runs and the sync check

- **First run:** `--force --last-rev <start>`. The copy's history starts at the commit after `<start>`, as one full snapshot. `--init-history` would replay all ~790 past commits that touched `packages/`, old messages included. That goes against the call's "history starts when we do this".
- **Merges:** `first_parent = True` is the default, so a merge commit becomes one copy commit. On main every PR is one squash commit, so this matters only for branch-phase runs.
- **No-op runs:** a deploy whose commits don't touch `origin_files` makes Copybara exit 4 (nothing to migrate). The script treats that as green.
- **Sync check:** Copybara writes what a copy should hold at the sha into a folder (`--to-folder --squash`), using the same file selection and moves as the real run. The check hashes that folder with `git write-tree` and compares the result with the copy head's tree hash. A git tree hash depends only on content, so equal hashes mean every file is the same, and a file added by hand shows up. It fetches the copy with `--filter=blob:none`, because trees are enough. (Round 1 compared the `packages` subtree and the README by hand; with excludes and root-only folders, that meant repeating Copybara's globs.)

## Experiment script

### Round 2: iterate/os0929 and iterate/packages0929

- [x] First local run with `--last-rev`: both copies get their first commit, each README lands at its root, and both checks are green _(49 s for both: [os0929 a40ad29](https://github.com/iterate/os0929/commit/a40ad298c42bf48638de253a47a6cd9140da3dd5), [packages0929 b33ddfe](https://github.com/iterate/packages0929/commit/b33ddfe773c5db979dab50e9a26582e63cbe7433). Checked apart from Copybara too: each copied folder's and README's hash equals iterate/iterate's)_
- [x] The Preview OS job's run is green for both, and copies nothing that isn't theirs _(the workflow-only commit was skipped by both)_
- [x] A commit touching `packages/iterate` lands in os0929 alone; one touching another package lands in packages0929 alone _(one CI run, 47 s for both: os0929 got [fa1f53d](https://github.com/iterate/os0929/commit/fa1f53d) (packages/iterate), packages0929 got [741143b](https://github.com/iterate/packages0929/commit/741143b) (packages/agents), both got the delete of both files and one commit for the merge of main. Copybara counted the packages/iterate commit as a candidate for packages0929 and made nothing of it, since the exclude left it empty)_
- [x] Merging `main` into the branch makes one copy commit per copy it touches _(main brought apps/os and packages/cli changes: [14a7879](https://github.com/iterate/os0929/commit/14a7879), [a94b7df](https://github.com/iterate/packages0929/commit/a94b7df))_
- [x] Executable files keep their mode (`packages/cli/bin/iterate.js` is `100755`) _(both executables are `100755` in packages0929. The check compares a copy with Copybara's own output, so it wouldn't catch Copybara dropping a mode; the hash comparison against iterate/iterate would)_

### Round 1: `packages/` → iterate/copybara0929 (repo since deleted)

Through the Preview OS job, with the origin ref being this branch:

- [x] Branch point: first run creates `main` in the copy (`packages/` plus README), and the check is green _(local run, 26 s cold: [2aa4af2](https://github.com/iterate/copybara0929/commit/2aa4af2c25d3cdf566762eaeca7f61b90363d585), with `--last-rev` = the branch point)_
- [x] A commit that touches `packages/` makes one copy commit with the right trailer _(CI, after the PR's Deploy preview: [70b9392](https://github.com/iterate/copybara0929/commit/70b9392d90d460ba1e3a5cef33e389f0cda8de96))_
- [x] A commit that doesn't touch `packages/` is a green no-op _(the same run skipped the two workflow commits pushed with it; a local run with nothing new said "No new changes to import")_
- [ ] ~~Merging `main` into the branch makes one copy commit~~ _(not run: main's commits since the branch point touched no `packages/`, so the merge would only have been a no-op. On main every PR is one squash commit, so merges don't arise there)_
- [x] Deleting a file or folder under `packages/` deletes it in the copy _([a9a6d05](https://github.com/iterate/copybara0929/commit/a9a6d05b676bbde8e08408c419a9da0d5723f5db): the copy's `packages` tree is back to the first commit's, `2c63ae3`)_
- [ ] ~~Editing the README flows through~~ _(not run on its own: every copy moved the README and compared its hash, and the README follows the same path as any file under `packages/`)_
- [x] A squash-merged-style message: the title's `(#N)` becomes `(iterate/iterate#N)` and links; only the `<!-- copybara -->` sections come through; a message with no sections becomes the title alone _(70b9392: the title, the one marked paragraph, the trailer; the mid-sentence marker and Co-Authored-By dropped)_
- [x] GitHub adds a "referenced this pull request" backlink to the iterate/iterate PR when the copy commit lands _(a cross-repository ReferencedEvent on #3434 from 70b9392, 3 s after the push; visible to people who can read the private copy)_
- [x] Migrating up to an older sha, then the newest: the copy stops at the older one, then catches up _(an older sha than the trailer is a Copybara no-op, "nothing new", with no push. The check then compares the copy with the older sha, the known limit in the notes. The newest always catches up)_
- [x] A push that cancels the Preview OS run in progress: the next run catches up _(the edit's run was cancelled mid-deploy, copy job included; the deletion's run copied both, [0f696da](https://github.com/iterate/copybara0929/commit/0f696da) and a9a6d05)_
- [ ] ~~A commit that touches `packages/github-sync` only (not a preview path, so no deploy): it reaches the copy with the next deploy~~ _(can't happen on this PR: preview paths are judged on the whole PR's diff, which touches deploy-os.yml, so every push deployed. Moved to after merge)_
- [x] A hand-made commit on the copy's `main` makes the check go red, and the next sync overwrites it (before the ruleset blocks hand pushes) _(0f696da, the next copy, deleted its file. Red: a local no-op run over [19a8749](https://github.com/iterate/copybara0929/commit/19a87497553841f55076e5bdeb41f0c0cce5b621) failed with "the copy's head … has no GitOrigin-RevId trailer"; Copybara itself looked past it)_
- [x] Time per run on a warm cache, and with a cold cache _(every CI run is cold: the job took 21 s, including checkout, pnpm install and the Temurin download. Locally 26 s cold)_

- [x] Switching from branch history to main: the copy's last trailer names a branch commit that main's squash commit doesn't descend from. See what Copybara does _(dry run: it refuses, "last imported revision … is not ancestor of requested revision". A copy moving from a branch to main needs one run with `--last-rev <the squash commit's parent>`)_

## Out of scope

- The copy building or installing on its own. `packages/*/package.json` use `catalog:` and `workspace:*`, 9 tsconfigs extend `../../tsconfig.base.json`, and `packages/voice/src/worker.test.ts` imports from `apps/os`.
- Two-way sync, the real `iterate/os` and `iterate/packages`, making anything public, and restarting iterate/iterate's history.
- Merging this PR, and so the Deploy OS job ever running.
- A scheduled backstop or a dispatchable workflow. Deploys are frequent, and a laptop run covers manual catch-up.
- Release tags or deployed version ids on the copies (see Release versions).

## Decisions (Misha, 2026-09-29)

1. **Keep the `packages/` prefix in the copy.** It gives the exact tree-hash check, matches the tsconfigs' `../../` depth, and leaves room for root files later.
2. **Commit messages: the title line, with `(#N)` pointing at the iterate/iterate PR, plus opt-in `<!-- copybara -->` sections** (see Commit messages).
3. **Credential: the existing iterate GitHub App**, with its token narrowed to the copy and `contents: write`. No PAT.
4. **Runner: Depot.**
5. **The copy moves only after a successful deploy**, with the `GitOrigin-RevId` trailer standing in for "the release" for now. Assumed: "deploy" means Deploy OS (see Trigger).
6. **"Referenced this pull request" backlinks on iterate/iterate PRs are welcome.**
7. **A temporary job at the end of the PR's Deploy preview drives the branch phase.** It's a throwaway experiment, and the real thing will likely start over.
8. **This PR never merges.** It's the experiment and the place to bikeshed the real layout.
9. **Files live under `copybara/`:** one `copy.bara.sky`, plus a `copybara/<name>/` folder of root-only files per copy. Copies keep this repo's paths. (See Where the copies' files live.)
10. **Round 2 copies to iterate/os0929 and iterate/packages0929;** iterate/copybara0929 is deleted.
11. **The self-host recipe is the test of what `iterate/os` contains:** it keeps working with only the clone URL changed.
12. **The copy's root manifests live in `copybara/os/`:** `package.json` written by hand, the workspace file and lockfile generated from the root's, with dependencies a subset of the root's, checked in CI.
13. **Built-in templates are baked into the Worker for now,** recorded as `builtin:<name>@<sha>`. A registry served by the Worker (shadcn's format) comes later, when features get added to existing projects.

## Implementation notes

- 2026-09-29: the copy repo was created with `gh repo create --private`, with issues and wiki off. The iterate App's installation (all repositories) reached it with no further setup, and the narrowed token (`contents: write`, `metadata: read`, copybara0929 only) also fetches the public iterate/iterate.
- The first local run turned up a message bug: a marker mentioned mid-sentence in a commit message started a "section" that ran to the end of the message. Markers now count only on a line of their own, and a section with no closing marker is dropped. The copy's first commit keeps the leaked message, because the copy's history isn't rewritten.
- Deploy workflows were pinned to a single `deploy` job (`depot-workflows.test.ts`). Deploy OS now also has `copybara`, named as the one exception, so a failed copy is red on its own job and never touches the deploy's posts. Deploy OS's concurrency is on the whole workflow, so the next production deploy also waits for this job (about a minute).
- The iterate App token code moved from the flake dashboard to `scripts/ci/iterate-app-token.ts`, taking the repository and permissions as arguments. Its test moved with it.
- The first CI run of the temporary job failed before starting: Depot's stock image has no Java 21 (no `JAVA_HOME_21_X64`, which GitHub's images have). Both jobs now install Temurin 21 with `actions/setup-java`. `preview-os-workflow.test.ts` pins Preview OS's jobs by name, so it lists the temporary job too.
- Scenario files: `packages/shared/COPYBARA-EXPERIMENT.md` exists only so there's something to copy and later delete. It goes before merge.
- Known limit of the sync check: re-running an _older_ deploy after the copy has moved past it (a manual Deploy OS re-run) is a Copybara no-op. The check then compares the copy (newer) with that older sha and goes red, though nothing is wrong. Deploy OS runs one at a time and in order, so only a hand re-run hits it. Fixing it needs the origin's history (is the trailer's commit a descendant of `sha`?), which the check's depth-1 fetches don't have.
- The second CI run failed in Copybara itself: `UnsupportedClassVersionError`, class file version 69. The v20260928 jar needs Java 25, not the 21 its README names; local runs worked on Homebrew's Java 26. Both jobs now install Temurin 25 with `actions/setup-java@v5` (v4 warns that it's deprecated).
- Round 2 (2026-09-29): Copybara rejects any config file not named `copy.bara.sky` ("Copybara config file filename should be 'copy.bara.sky'"), and has no flag to change that. So per-copy `os.bara.sky` files can't work, and both workflows share `copybara/copy.bara.sky`.
- Round 2: the iterate App token now covers every copy repo at once. `iterateAppToken` takes `repositories` and finds the App through the org's installation (`/orgs/iterate/installation`), not through one repo.
- Round 2: `gh repo delete iterate/copybara0929` failed: the `gh` login lacks the `delete_repo` scope, and `gh auth refresh -s delete_repo` needs a browser. Misha to delete it.
- Round 2: the PR conflicted with main (#3429 changed `resolveEnvContext` to take `getEnv(...)`). A conflicting PR gets no Depot runs, so nothing ran until the merge. The flake dashboard keeps this branch's side, and `iterate-app-token.ts` uses the new signature.
- Round 3: `apps/os`'s build now needs to know which iterate/iterate commit it's built from (to pin the templates' agents and voice builds). In a copy, the `GitOrigin-RevId` trailer is that answer. Any future code that reads git history, `origin/main` or CI files at build time needs the same treatment; the fresh-clone recipe check is what catches it.
- Round 3, found on the side: main's `build()` fails in a shallow checkout whose HEAD isn't pushed (it fetches HEAD from origin to unshallow: "upload-pack: not our ref"). The root checkout on Misha's laptop is shallow, so `apps/os`'s vitest global setup fails until the commit is pushed. Pre-existing in main, not fixed here.
- Round 3, branch-phase caveat: on this branch the copy's trailer is a PR commit, which pkg.pr.new only publishes when the PR changes a published package. So a self-host build of os0929 may pin template packages at a build that 404s. On main, every copied commit is published.
