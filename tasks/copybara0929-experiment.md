---
status: in-progress
size: small
---

# Copybara experiment: one-way copies of parts of iterate/iterate

**Status:** rounds 1 and 2 done. This PR never merges: it's the experiment and the place to bikeshed the real layout.

- Round 1: `packages/` copied to iterate/copybara0929. Every scenario below ran, and the copy stayed in sync.
- Round 2: the layout for the real thing (`copybara/`), with two copies, iterate/os0929 and iterate/packages0929. Each copy got exactly its own commits, and the checks passed.
- Missing: deleting iterate/copybara0929 (`gh` needs the `delete_repo` scope, which only an interactive login grants). Then the open layout questions: does `iterate/os` build on its own, and which root-only files (LICENSE, issue template) does it get?

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

### Round 1: `packages/` → iterate/copybara0929 (repo to delete)

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
