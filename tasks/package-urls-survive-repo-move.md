---
status: in-progress
size: medium
---

# Package URLs and template references survive the repo move

iterate/iterate becomes a public archive; work continues in a new private monorepo, iterate/private
(Misha and Jonas, 2026-10-01). Templates, the setup prompt and the tooling name builds and folders
of iterate/iterate. This is the inventory and the plan.

## Status

- Phase 0 (this branch): done, pending CI and review. It changes nothing for users today; it makes
  the later switch to iterate/private a one-line constant plus a sweep of literal URLs, and removes
  the two template paths that download from GitHub.
- Misha has answered the three questions (see Decisions).
- Phase 2 (the switch) and the config-repo fix-up come after iterate/private exists.

## Summary

Everything stays on pkg.pr.new, published from iterate/private. We assume pkg.pr.new works from a
private repo (decided 2026-10-01, stackblitz-labs/pkg.pr.new#240). That assumption doesn't cover
two things:

1. **The repo is part of every URL.** After the move nothing publishes under
   `pkg.pr.new/iterate/iterate/…`. `…@main` there freezes at the last build before the move. That
   build then disappears in pkg.pr.new's cleanup: unused for a month, or six months old regardless
   ([pkg.pr.new's hosting write-up](https://gist.github.com/AmirSa12/2eed810c8d30ed0dc51eda22acebc3e2)).
   So every URL switches to `pkg.pr.new/iterate/private/…` in the first PR on iterate/private.
2. **`github:` template references are anonymous git fetches.** The platform downloads a template
   without credentials (`core/os/src/repo/github-template.ts`), so nothing in iterate/private can be
   downloaded. Most preset references never download, but two paths do: a preset reference from
   before a deploy, and the PR quick-launch links. Phase 0 stops both from downloading.

iterate/private starts with fresh history: one initial commit of the copied code. Commit shas don't
carry over and PR numbers restart.

No compatibility work for projects created before the move: we have no outside users, so the
handful of existing projects (ours) get migrated by hand after the switch (Phase 2).

The org-wide pkg-pr-new GitHub App install already covers iterate/private
(`gh api orgs/iterate/installations`: `repository_selection: all`), so publishing there needs no setup.

## Inventory

### pkg.pr.new builds (`pkg.pr.new/iterate/iterate/…`)

| Where                                                                                                                                                                                               | What it is                                                                                                                                                                                                                   | Who sees it                                                                                                 | Becomes                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `core/lib/src/pkg-pr-new.ts:41` `pkgPrNewVersion`                                                                                                                                                   | The URL of one of our builds. Used by `scripts/os/config-templates.ts`, `scripts/os/preview-packages.ts`, Docs' "Install Docs" route, `buildStanding`, `test/vitest/agents/support.ts` and `test/playwright/docs/support.ts` | Everything that writes a version                                                                            | One `pkgPrNewRepository` constant (Phase 0); `iterate/private` at the switch                                                    |
| `core/lib/src/pkg-pr-new.ts:95` `buildStanding`                                                                                                                                                     | Counts a build as "ours" only if it's exactly `pkgPrNewVersion(name, commit)`                                                                                                                                                | Voice app's build card                                                                                      | Follows the constant. A project still pinned to an `iterate/iterate` build shows as "own" until it's migrated by hand           |
| `core/configs/{default,heartbeat,minimal}/package.json`                                                                                                                                             | devDependency `iterate@main`, used only for local `tsc`                                                                                                                                                                      | iterate/core (self-hosters), and every project born from them                                               | `pkg.pr.new/iterate/private/iterate@main` at the switch. Existing projects: the manual migration                                |
| `configs/voice/package.json`                                                                                                                                                                        | dependency `@iterate-com/voice@main` (pinned at seed), devDependency `iterate@main`                                                                                                                                          | iterate/packages; self-hosts that bake it with `--template github:iterate/packages#main&path:configs/voice` | `iterate/private` at the switch. Without it, a seed silently pins the frozen pre-move build, then fails once cleanup removes it |
| `core/os/public/setup-prompt.md:216-217` "Adding voice"                                                                                                                                             | URL, plus the `x-commit-key` format `iterate:iterate:<sha>`                                                                                                                                                                  | Every deployment serves it; iterate/core                                                                    | `iterate/private` and `iterate:private:<sha>` at the switch                                                                     |
| `.github/workflows/pkg-pr-new.yml:4-6`                                                                                                                                                              | Comments only; the workflow itself doesn't name the repo                                                                                                                                                                     | Us                                                                                                          | Text update at the switch                                                                                                       |
| `scripts/os/preview-packages.ts:41,83`                                                                                                                                                              | Comment, and the timeout error's link to the workflow's runs                                                                                                                                                                 | Preview deploy logs                                                                                         | Built from the constant (Phase 0)                                                                                               |
| `test/vitest/os/npm-packages.e2e.test.ts:58`                                                                                                                                                        | Hardcoded `sdkAt`                                                                                                                                                                                                            | e2e                                                                                                         | `pkgPrNewVersion` (Phase 0)                                                                                                     |
| `core/configs/README.md:26`, `packages/{voice,ai-linter,github-sync,petshop-sdk}/README.md`                                                                                                         | Docs                                                                                                                                                                                                                         | iterate/core, iterate/packages                                                                              | Text update at the switch                                                                                                       |
| `core/lib/src/pkg-pr-new.test.ts:134,188`, `core/os/src/project/templates.test.ts:67-104`, `packages/{voice,docs,github-sync,ai-linter}/src/install.test.ts`, `scripts/os/preview-packages.test.ts` | Test fixtures                                                                                                                                                                                                                | —                                                                                                           | Fixtures that mean "our build" go through `pkgPrNewVersion`; fixtures that only test URL shape can keep any owner/repo          |

### GitHub template references (`github:iterate/iterate#…`)

| Where                                                                                    | What it is                                                                                                                                                                                                                                                                                  | Becomes                                                                                                                                                |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/os/config-templates.ts:22`                                                      | Preset reference for `configs/*` in deploys, previews and tests. Hardcoded repo                                                                                                                                                                                                             | Owner/repo taken from `origin`, sharing `core/os/scripts/build.ts`'s parsing (Phase 0). Becomes `iterate/private` by itself after the move             |
| `scripts/os-dev.ts:27`                                                                   | Same, for `pnpm dev`                                                                                                                                                                                                                                                                        | Same helper                                                                                                                                            |
| `core/os/scripts/build.ts:146` `coreConfigTemplates`                                     | Already takes the repo from `origin`. Its comment "the reference resolves on GitHub, so another deployment can create from it too" stops being true for iterate/private                                                                                                                     | Fix the comment. Other deployments use `github:iterate/core#main&path:core/configs/<name>`, which READMEs already say                                  |
| `core/os/src/project/processor.ts:576` `templateFiles[reference] ?? downloadTemplate(…)` | A preset whose commit the build doesn't have falls back to a GitHub download. The Dash sends the preset reference from when the page loaded (`apps/dash/src/routes/_auth/projects/index.tsx:236`), so a New project sheet left open across a deploy hits this path. That's every main merge | A reference to one of the build's own presets at another commit gets the build's copy (Phase 0)                                                        |
| `scripts/os/preview-config.ts:243,257`                                                   | Quick-launch for a template the PR changes: `github:iterate/iterate#<head>&path:<folder>`, which downloads                                                                                                                                                                                  | Link by name. The preview build already includes the checkout's copy of every template (`scripts/os/preview.ts:1272`, `coreConfigTemplates`) (Phase 0) |
| `configs/README.md:12`, `docs/dev-environments.md:170,206`                               | Docs                                                                                                                                                                                                                                                                                        | Updated with the changes above                                                                                                                         |
| `core/lib/src/config-repo-template.test.ts`, `scripts/os/preview.test.ts:342`            | Parser fixtures; quick-launch fixture                                                                                                                                                                                                                                                       | Parser fixtures stay; the quick-launch fixture follows its change                                                                                      |
| `tasks/complete/2026-10-01-core-minimal-template.md:30`                                  | History                                                                                                                                                                                                                                                                                     | Leave                                                                                                                                                  |

### Related repo names in the same code paths

| Where                                                                                                                                | Problem                                                                                                                    | Becomes                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/docs/src/install.ts:30` `docsAgentGuide`                                                                                   | `raw.githubusercontent.com/iterate/iterate/main/…`, written into projects' AGENTS.md. Goes stale once the repo is archived | `iterate/packages`, which keeps the same paths (Phase 0). Configs that installed Docs before keep the old address; a reinstall would add a second section |
| `packages/ui/src/components/app-build.tsx:155,184`                                                                                   | Commit and compare links to `github.com/iterate/iterate`                                                                   | `iterate/private` at the switch                                                                                                                           |
| `repository`/`homepage`/`bugs` in `core/lib/package.json` and `packages/{voice,docs,github-sync,petshop-sdk,ai-linter}/package.json` | Point at the archive                                                                                                       | `iterate/core` / `iterate/packages` with `directory` (Phase 0)                                                                                            |
| `apps/dash/src/routes/_auth/projects/index.tsx` `templateFields`                                                                     | Matched `configs/<name>` only, so `?template=heartbeat` and `?template=minimal` landed on the default template             | ~~Match `core/configs/<name>` too~~ Already fixed on main (it matches by folder name) by the time Phase 0 started                                         |

### Handled elsewhere

- Copybara reading a private source, repo names hardcoded in CI and monitors, ci-reports, and
  `core/os/src/mcp.ts:75`: the "Make CI tooling, Copybara and ci-reports work from iterate/private"
  session (`local_a276104b-99ef-4620-92f5-5796547b3420`).
- Kit firmware (`FIRMWARE_REPOSITORY`): Kit moves to its own public repo, iterate/kit, with its
  releases (`tasks/kit-own-repo.md`, iterate/iterate#3511, iterate/kit#1).
- apps/ → packages/ (`tasks/apps-into-packages.md`, `local_79e74bd2-2b8a-4062-8675-ca096cee0c44`).
  The move doesn't wait for it.

## Plan

### Phase 0: now, on iterate/iterate (this branch; no behavior change today)

- [x] `pkgPrNewRepository = "iterate/iterate"` in `core/lib/src/pkg-pr-new.ts`. `pkgPrNewVersion`,
      the error link in `preview-packages.ts`, the npm-packages e2e and the "our build" test fixtures
      use it, so the switch is one line plus a sweep of literal URLs _(the e2e and
      `pkg-pr-new.test.ts` go through `pkgPrNewVersion`; other fixtures stay literal so they read
      plainly, and fail loudly at the switch until swept)_
- [ ] ~~`buildStanding` counts builds from `iterate/iterate` as ours, and the build card links each
      commit to its own repo~~ _(built, then removed: no outside users, so existing projects are
      migrated by hand instead)_
- [x] `config-templates.ts` and `os-dev.ts` take the preset's owner/repo from `origin`, through one
      helper shared with `build.ts` _(`githubHeadOf` in `core/os/scripts/build.ts`)_
- [x] A creation naming one of the build's own presets at another commit is seeded from the build's
      copy, with no GitHub request _(`presetFiles` in `core/os/src/project/processor.ts`)_
- [x] Quick-launch links use names only _(`templateQuickLaunches` takes no changed paths or head; the `templateFields` half was already on main)_
- [x] `docsAgentGuide` → iterate/packages; `package.json` `repository` fields → the public copies

### Phase 1: the move (Misha and Jonas)

- iterate/private is a new repo: the code copied in as one initial commit. Nothing from
  iterate/iterate's history is pushed, commit shas don't match, and PR numbers restart.
- Copybara, CI and ci-reports: the CI tooling session (above).

### Phase 2: the switch (first PR on iterate/private)

It has to be the first PR (or part of the initial commit). An earlier PR's preview would look for
its packages under iterate/iterate at an iterate/private commit, and wait until it times out.

- [ ] `pkgPrNewRepository = "iterate/private"`
- [ ] Literal URLs: `core/configs/*/package.json`, `configs/voice/package.json`, `setup-prompt.md` (and
      `iterate:private:<sha>`), the build card's links in `packages/ui/src/components/app-build.tsx`,
      READMEs, workflow comments, any fixtures left. Done when
      `git grep -n -E 'pkg\.pr\.new/iterate/iterate|github:iterate/iterate|github\.com/iterate/iterate/(commit|compare)'`
      lists only parser fixtures and `tasks/complete/`
- [ ] Evidence on the PR's preview:
  - the pkg-pr-new run publishes under iterate/private at the head
  - the deploy logs `[pkg.pr.new] … serves … at <head>`
  - the voice and docs e2e rows install `iterate/private` builds
  - a project created from Voice gets a seed commit that pins `iterate/private/@iterate-com/voice@<sha>`
- Branches in flight on iterate/iterate get reapplied onto iterate/private as patches after the
  switch; with fresh history, nothing merges across.

### Phase 2b: migrate existing projects by hand

- [ ] After the switch, re-pin each prd project's `@iterate-com/*` dependencies to iterate/private
      builds and point `devDependencies.iterate` at `…/iterate/private/iterate@main`. Coordinated by
      the "Iterate repo privatization status" session. Until then those projects keep running on
      their pinned builds, and the voice app's build card shows them as "own"

### Phase 3: archive iterate/iterate

After prd deploys from iterate/private. Projects already running are unaffected: the platform keeps
each resolved dependency graph (`module-lock-3/…` in `core/os/src/context/module-resolution.ts`)
and never goes back to pkg.pr.new for it. A _new_ resolution of an `iterate/iterate` build fails
once pkg.pr.new's cleanup removes it. That includes every project's graph if the lock prefix is ever
bumped, a risk that exists today and that the move doesn't change.

### Later, optional

- npm releases of `iterate` for templates' `devDependencies`: permanent, public, no repo in the
  name. We own `iterate` on npm (0.4.0 published; the repo has 0.4.1), but nothing publishes it
  today. Not needed for the move.

## Not chosen

- **GitHub Release tarballs on iterate/packages.** Dropped 2026-10-01 in favor of pkg.pr.new. It
  would need a release pipeline into another repo, a new loader resolution path (the loader resolves
  only npm versions and pkg.pr.new commits through esm.sh), and new pinning and standing logic in
  place of `x-commit-key` and `last-modified`. The one thing it adds is permanence; pick it up if
  pkg.pr.new fails for the private repo or the cleanup causes trouble.
- **npm for everything.** Per-commit and per-PR builds, and pinning by commit, don't fit npm, and
  `@iterate-com/*` isn't on npm.
- **pkg.pr.new's short URLs (`pkg.pr.new/iterate@main`).** They resolve the repo through the npm
  package's `repository` field, which needs npm releases. The loader and `pkgPrNewBuildOf` also
  parse only `<owner>/<repo>/<package>@<ref>`.

## Decisions (Misha, 2026-10-01)

1. **Preset reference from before a deploy:** the build seeds a reference to one of its own presets
   from its current copy, whatever the commit. An old reference gets today's template.
2. **Existing projects:** no compatibility code for projects created before the move; we have no
   outside users. Migrate ours by hand after the switch (Phase 2b).
3. **Build card commit links:** link to iterate/private. Revisit if anyone outside complains.

## Implementation log

- 2026-10-01: inventory from `git grep` at `916a48f20`. Checked: pkg-pr-new app installed org-wide
  on all repos; iterate/private not visible yet; `iterate` is on npm (0.4.0), `@iterate-com/voice`
  is not; iterate/packages has `packages/docs/AGENTS.md`; iterate/core and iterate/packages have
  issues enabled.
- 2026-10-01: plan updated for fresh history in iterate/private and Misha's answers; Phase 0 starts
  on branch `package-urls-repo-move`.
- Phase 0: main had already made the Dash's `templateFields` match presets by folder name, so the
  Dash needed no change. The generated preset reference is unchanged today:
  `github:iterate/iterate#<HEAD>&path:configs/voice`, now read from `origin`.
- Phase 0, second pass (Misha: "we have zero real customers"): removed the compatibility code for
  projects created before the move: `buildStanding` counting iterate/iterate builds as ours with a
  repository per commit, the build card's per-repo links, and `installDocs` rewriting the guide's
  old address. Existing projects get a manual migration instead (Phase 2b).
- Local checks: typecheck, lint, knip and format clean; tests of core/lib, core/os, packages/docs,
  packages/ui and scripts/os pass. `scripts/ci/toolchain.test.ts` and the shell-hook rows fail on
  macOS's bash 3.2 (`inherit_errexit`), on main too.
