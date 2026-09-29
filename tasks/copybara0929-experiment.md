---
status: ready
size: small
---

# Copybara experiment: `packages/` → iterate/copybara0929

**Status:** built, branch phase starting.

- Done: the copy repo exists; the Copybara config, `scripts/ci/copybara.ts`, and the jobs after Deploy OS and (temporary) after this PR's Deploy preview are written. A local run made the copy's first commit, and its sync check passed.
- Missing: the scenarios below, run through the PR's preview deploys; then delete the temporary job and merge.

A throwaway experiment: the real `iterate/os` will likely start over from what this teaches.

## Why

From the 2026-09-29 Tuple call with Jonas (`1b5f47c9`): iterate/iterate goes private, and public repos (`iterate/os`, `iterate/packages`) become one-way copies of parts of it. Before doing that for real, check that Copybara can keep one such copy in sync. `apps/os` is left alone until Jonas stops changing it.

## Goal

When a commit of iterate/iterate deploys successfully, `main` of a private iterate/copybara0929 catches up to that commit. The copy holds exactly `packages/**` plus its own `README.md`. Nothing flows back.

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
- **Credentials:** the existing iterate GitHub App (app 2001598). It's installed on all of the org's repos with Contents: write, so it reaches iterate/copybara0929 as soon as the repo exists. Its key is in os/prd `APP_CONFIG`. The job mints an installation token narrowed to `repositories: ["copybara0929"]` and `permissions: { contents: "write" }`, the same way `iterateAppIssuesToken` in `scripts/ci/flake-dashboard/update.ts` narrows one to issues (generalize that function). A leaked token can only write the copy, for an hour.
  - The repo keeps this key out of PR workflows by convention: only the schedule-only flake dashboard reads it (`depot-workflows.test.ts` pins that one). Nothing enforces it, though. Depot runs no PRs from forks, so every run is from someone who can push, holding the one `DOPPLER_TOKEN`, which reads os/prd (`docs/depot-ci.md`). The deploy-os job only runs on main and already holds prd's credentials. The temporary Preview OS job below bends the convention for this one PR.
  - No PAT and no new App. Doppler has no PAT anyway. Its only other GitHub key is `PREVIEW_GITHUB_APP_PRIVATE_KEY`, which belongs to the dummy-petshop's fake GitHub, not github.com.
  - Later, the copy's ruleset can say "only the iterate App may push to `main`".
- **While on the branch:** Deploy OS only runs on main (dispatching it on a branch would deploy the branch to prd), but the PR's own deploy is Preview OS. A **temporary** `copybara` job at the end of Preview OS's Deploy preview, only for this PR's branch, copies the PR head to the copy's `main`, with the origin ref being the `copybara0929` branch. It runs only when Deploy preview actually deployed something (the `cleanup` job's condition), so the branch phase exercises the deploy gate too. A push that cancels the run in progress tests catch-up for free. It's deleted before merge.
  - Local runs (Homebrew's `openjdk` 26, since Copybara needs 25+) are for getting the config right before pushing.
- **Other GitHub Apps:** about 20 apps are installed on "all repositories" in the org (cursor, claude, devin, graphite, autofix-ci, linear, depot, cloudflare-workers-and-pages, iterate, iterate-preview-1, iterate-misha, …), so they attach to the new repo automatically. For a private copy with no PRs and no workflows they do nothing. For a public `iterate/os` that's "locked down to the max", switch them to selected repositories.
- **The iterate platform:** `@iterate-com/github-sync` keeps two remotes on _one_ history (fast-forward only, same commits). A copy of a subset of files needs different commits, so github-sync can't do this. A platform-native version (the push webhook starts a processor that pushes the copy) would be a good user-space test later. It would need the custom-CLI route, and a test of the platform's git on a 1.25 GB repo. Not for this experiment.

## Design

Files in iterate/iterate (branch `copybara0929`, PR to main):

| File                              | What                                                                                                                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `copybara/copy.bara.sky`          | The workflow below                                                                                                                                                                 |
| `copybara/copybara0929/README.md` | The copy's README, reviewed here and moved to the copy's root                                                                                                                      |
| `scripts/ci/copybara.ts`          | `--workflow <name> --sha <sha>`: mints the narrowed iterate App token, downloads the pinned jar (sha256-checked), runs `copybara migrate` up to that sha, then runs the sync check |
| `.depot/workflows/deploy-os.yml`  | New `copybara` job after the deploy and the host check (workflow `copybara0929`, origin ref `main`)                                                                                |
| `.depot/workflows/preview-os.yml` | **Temporary** `copybara` job after Deploy preview, only on the `copybara0929` branch (workflow `copybara0929_branch`, origin ref `copybara0929`). Deleted before merge             |

```python
# copybara/copy.bara.sky (sketch): one workflow per origin ref, `copybara0929` and `copybara0929_branch`
core.workflow(
    name = name,
    origin = git.origin(
        url = "https://github.com/iterate/iterate",
        ref = ref,  # "main" after deploys, "copybara0929" in the branch phase; the run passes the sha
        partial_fetch = True,
    ),
    origin_files = glob(["packages/**", "copybara/copybara0929/README.md"]),
    destination = git.destination(
        url = "https://github.com/iterate/copybara0929",
        push = "main",
    ),
    destination_files = glob(["**"]),
    mode = "ITERATIVE",  # one copy commit per origin commit that touches origin_files
    authoring = authoring.pass_thru("iterate-copybara <copybara@iterate.com>"),
    transformations = [
        core.move("copybara/copybara0929/README.md", "README.md"),
        copy_message,  # defined above core.workflow (Starlark needs it first); see Commit messages
    ],
)
```

### Commit messages

A squash-merged PR's commit message is its title, ` (#123)`, and its body. HTML comments survive into the message: the `<!-- loc-report -->…<!-- /loc-report -->` and `<!-- os-preview -->…<!-- /os-preview -->` sections are in main's commits today. The copy's message is:

- the title, with `(#123)` rewritten to `(iterate/iterate#123)`. GitHub links `owner/repo#N` in commit messages across repos.
- then every paragraph between `<!-- copybara -->` and `<!-- /copybara -->`, in order. The markers are invisible on the rendered PR page and follow the same convention as the existing sections.
- then Copybara's `GitOrigin-RevId` trailer.

A Starlark function does this. Copybara runs any `def f(ctx)` in `transformations` and has a `re2` regex module. Starlark has no `while`, so the sections are found with `split`:

```python
def copy_message(ctx):
    title = ctx.message.split("\n")[0]
    title = re2.compile(" \\(#([0-9]+)\\)$").matcher(title).replace_all(" (iterate/iterate#$1)")
    sections = [
        part.split("<!-- /copybara -->")[0].strip()
        for part in ctx.message.split("<!-- copybara -->")[1:]
    ]
    ctx.set_message("\n\n".join([title] + sections) + "\n")
```

Commits pushed straight to the experiment branch have no `(#N)`, so their title passes through unchanged.

### Runs and the sync check

- **First run:** `--force --last-rev <start>`. The copy's history starts at the commit after `<start>`, as one full snapshot. `--init-history` would replay all ~790 past commits that touched `packages/`, old messages included. That goes against the call's "history starts when we do this".
- **Merges:** `first_parent = True` is the default, so a merge commit becomes one copy commit. On main every PR is one squash commit, so this matters only for branch-phase runs.
- **No-op runs:** a deploy whose commits don't touch `origin_files` makes Copybara exit 4 (nothing to migrate). The script treats that as green.
- **Sync check:** git tree hashes depend only on content, so the check needs no file diffing. It reads the `GitOrigin-RevId` trailer on the copy's HEAD. It asserts that the `packages` tree hash in that origin commit, in the deployed sha, and in the copy's HEAD are all the same (`git rev-parse <commit>:packages`). This only works if the copy keeps the `packages/` prefix (decision 1). It fetches the copy with `--filter=blob:none`, because trees are enough.

## Experiment script

On the branch, through the temporary Preview OS job (origin ref = the `copybara0929` branch):

- [x] Branch point: first run creates `main` in the copy (`packages/` plus README), and the check is green _(local run, 26 s cold: [2aa4af2](https://github.com/iterate/copybara0929/commit/2aa4af2c25d3cdf566762eaeca7f61b90363d585), with `--last-rev` = the branch point)_
- [x] A commit that touches `packages/` makes one copy commit with the right trailer _(CI, after the PR's Deploy preview: [70b9392](https://github.com/iterate/copybara0929/commit/70b9392d90d460ba1e3a5cef33e389f0cda8de96))_
- [x] A commit that doesn't touch `packages/` is a green no-op _(the same run skipped the two workflow commits pushed with it; a local run with nothing new said "No new changes to import")_
- [ ] Merging `main` into the branch makes one copy commit
- [ ] Deleting a file or folder under `packages/` deletes it in the copy
- [ ] Editing the README flows through
- [x] A squash-merged-style message: the title's `(#N)` becomes `(iterate/iterate#N)` and links; only the `<!-- copybara -->` sections come through; a message with no sections becomes the title alone _(70b9392: the title, the one marked paragraph, the trailer; the mid-sentence marker and Co-Authored-By dropped)_
- [x] GitHub adds a "referenced this pull request" backlink to the iterate/iterate PR when the copy commit lands _(a cross-repository ReferencedEvent on #3434 from 70b9392, 3 s after the push; visible to people who can read the private copy)_
- [ ] Migrating up to an older sha, then the newest: the copy stops at the older one, then catches up
- [ ] A push that cancels the Preview OS run in progress: the next run catches up
- [ ] A commit that touches `packages/github-sync` only (not a preview path, so no deploy): it reaches the copy with the next deploy
- [ ] A hand-made commit on the copy's `main` makes the check go red, and the next sync overwrites it (before the ruleset blocks hand pushes) _(red: a local no-op run over [19a8749](https://github.com/iterate/copybara0929/commit/19a87497553841f55076e5bdeb41f0c0cce5b621) failed with "the copy's head … has no GitOrigin-RevId trailer"; Copybara itself looked past it)_
- [ ] Time per run on a warm cache, and with a cold cache

After merge, on main:

- [ ] The first Deploy OS after merge runs the `copybara` job: the copy is at the deployed sha, and the check is green
- [ ] A deploy that fails leaves the copy where it was, and the next successful one catches up
- [ ] A PR that only touches `packages/agents` reaches the copy with the next OS deploy
- [x] Switching from branch history to main: the copy's last trailer names a branch commit that main's squash commit doesn't descend from. See what Copybara does _(dry run before merge: it refuses, "last imported revision … is not ancestor of requested revision". After merge, the first Deploy OS copy goes red until one run with `--last-rev <squash commit's parent>`)_

Claude creates iterate/copybara0929 (private) with `gh`. Misha is an org admin, and members may create private repos. Nothing needs Misha's hands.

## Out of scope

- The copy building or installing on its own. `packages/*/package.json` use `catalog:` and `workspace:*`, 9 tsconfigs extend `../../tsconfig.base.json`, and `packages/voice/src/worker.test.ts` imports from `apps/os`.
- Two-way sync, `iterate/os`, making anything public, and restarting iterate/iterate's history.
- A scheduled backstop or a dispatchable workflow. Deploys are frequent, and a laptop run covers manual catch-up.
- Release tags or deployed version ids on the copy (see Release).

## Decisions (Misha, 2026-09-29)

1. **Keep the `packages/` prefix in the copy.** It gives the exact tree-hash check, matches the tsconfigs' `../../` depth, and leaves room for root files later.
2. **Commit messages: the title line, with `(#N)` pointing at the iterate/iterate PR, plus opt-in `<!-- copybara -->` sections** (see Commit messages).
3. **Credential: the existing iterate GitHub App**, with its token narrowed to the copy and `contents: write`. No PAT.
4. **Runner: Depot.**
5. **The copy moves only after a successful deploy**, with the `GitOrigin-RevId` trailer standing in for "the release" for now. Assumed: "deploy" means Deploy OS (see Trigger).
6. **"Referenced this pull request" backlinks on iterate/iterate PRs are welcome.**
7. **A temporary job at the end of the PR's Deploy preview drives the branch phase.** It's a throwaway experiment, and the real thing will likely start over.

## Implementation notes

- 2026-09-29: the copy repo was created with `gh repo create --private`, with issues and wiki off. The iterate App's installation (all repositories) reached it with no further setup, and the narrowed token (`contents: write`, `metadata: read`, copybara0929 only) also fetches the public iterate/iterate.
- The first local run turned up a message bug: a marker mentioned mid-sentence in a commit message started a "section" that ran to the end of the message. Markers now count only on a line of their own, and a section with no closing marker is dropped. The copy's first commit keeps the leaked message, because the copy's history isn't rewritten.
- Deploy workflows were pinned to a single `deploy` job (`depot-workflows.test.ts`). Deploy OS now also has `copybara`, named as the one exception, so a failed copy is red on its own job and never touches the deploy's posts. Deploy OS's concurrency is on the whole workflow, so the next production deploy also waits for this job (about a minute).
- The iterate App token code moved from the flake dashboard to `scripts/ci/iterate-app-token.ts`, taking the repository and permissions as arguments. Its test moved with it.
- The first CI run of the temporary job failed before starting: Depot's stock image has no Java 21 (no `JAVA_HOME_21_X64`, which GitHub's images have). Both jobs now install Temurin 21 with `actions/setup-java`. `preview-os-workflow.test.ts` pins Preview OS's jobs by name, so it lists the temporary job too.
- Scenario files: `packages/shared/COPYBARA-EXPERIMENT.md` exists only so there's something to copy and later delete. It goes before merge.
- Known limit of the sync check: re-running an _older_ deploy after the copy has moved past it (a manual Deploy OS re-run) is a Copybara no-op. The check then compares the copy (newer) with that older sha and goes red, though nothing is wrong. Deploy OS runs one at a time and in order, so only a hand re-run hits it. Fixing it needs the origin's history (is the trailer's commit a descendant of `sha`?), which the check's depth-1 fetches don't have.
- The second CI run failed in Copybara itself: `UnsupportedClassVersionError`, class file version 69. The v20260928 jar needs Java 25, not the 21 its README names; local runs worked on Homebrew's Java 26. Both jobs now install Temurin 25 with `actions/setup-java@v5` (v4 warns that it's deprecated).
