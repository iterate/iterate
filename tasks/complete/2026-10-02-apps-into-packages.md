---
status: done
size: large
---

# The apps we stand behind move to `packages/`

`packages/` holds the products we stand behind: "the components of a product that our friends use"
(Misha and Jonas, 9/29). The folder is `packages`, not `first-party` (10/1). There's no `slop/`
folder: apps we don't stand behind go to their own repos (Misha, 2026-10-01).

Everything in `packages/` is public: Copybara copies `packages/**` and `configs/**` to
iterate/packages (iterate/iterate#3493). The move lands on iterate/iterate before the cutover to
iterate/private (Misha, 2026-10-02), so the apps' source stays public after it.

## Status

- Done, pending merge: iterate/iterate#3512. CI is green, including the preview deploying every
  moved app from its new folder; the AI linter had no findings and Bugbot one (a repeated
  explanation, fixed).
- Left for after merge: each app's first deploy from `packages/`, and the first
  `copy-packages.yml` run.
- When it merges, tell the "Iterate repo privatization status" session
  (`local_f9dad892-5f7e-44be-bd4c-916be3847685`): iterate/private's draft root commit lists the
  `apps/` and `packages/` layout.

## Where each app goes

| Now                                     | After                        |
| --------------------------------------- | ---------------------------- |
| `apps/dash`                             | `packages/dash`              |
| `apps/notes`                            | `packages/notes`             |
| `apps/docs`                             | `packages/docs-app`          |
| `apps/agents`                           | `packages/agents-app`        |
| `apps/voice`                            | `packages/voice-app`         |
| `apps/admin`                            | `packages/admin`             |
| `apps/spa`                              | `packages/spa`               |
| `apps/browser-extension`                | `packages/browser-extension` |
| `apps/ci-reports`, `apps/dummy-petshop` | stay in `apps/`, private     |

After this, `apps/` means "private": internal CI tooling and test fixtures.

**Folder names.** Folder = package name without `@iterate-com/`. That avoids the clashes with
`packages/docs` (`@iterate-com/docs`) and `packages/voice` (`@iterate-com/voice`) and needs no
package renames. `@iterate-com/agents-app` keeps its name, so its folder is `agents-app` even though
`packages/agents` is free since iterate/iterate#3496. Every folder stays two levels deep, so
relative paths into and out of an app keep their `../` count, as in iterate/iterate#3487.

Not chosen: one folder per product with `lib/` and `app/` inside (`packages/docs/{lib,app}`). It
moves the published libraries too and changes the depth of every path in six packages.

**Why each one (Misha, 2026-10-02):**

- **voice app**: friends use it with Kit, and `packages/voice` is already public. If voice later gets
  its own repo, it goes with `packages/voice` and `configs/voice`.
- **admin**: public. Its source has no secrets or state of its own; it's an OAuth client like the dash.
- **spa, browser-extension**: public, together: the SPA's build makes the extension's zip and serves
  it on its downloads page.
- **ci-reports, dummy-petshop**: private. Internal CI tooling and a test fixture.

**License.** The apps get no LICENSE of their own, so they fall under the root AGPL-3.0, as
`copybara/packages/README.md` already says for everything without one. iterate/iterate#3508 gave
Apache-2.0 only to code people build on: the SDK, the installable packages, the ui components and
the templates.

## Plan

- [x] Move with iterate/iterate#3487's script (`tasks/apps-into-packages.move.mjs`), with this
      task's move list. It moves each file, recomputes relative imports and markdown links from the
      new place, and rewrites path mentions. Delete the script once it has run. _210 files; the
      script skipped the 16 images (it only reads text files), moved by hand; deleted after_
- [x] Paths built from an app's name instead of its folder. These break once name and folder
      differ (`docs` → `packages/docs-app`):
  - `scripts/os/preview.ts:329` `path.resolve(REPO_ROOT, "apps", app.name)`: use `app.root`
  - `scripts/ci/depot-workflows.test.ts:100`: `deploy-<app>.yml` → `apps/<app>`
  - `knip.ts:114`: the Start apps' workspaces
  - `scripts/lib/start-app.ts`: `StartApp.name`'s doc ("the directory under apps/") and the
    `apps/${app.name}` error messages and `appLabel`
  - _`appDirectory(app)` in start-app.ts (from `StartApp.root`) for preview.ts and the messages;
    `deployedFolders` in depot-workflows.test.ts, which fails for a deploy workflow with no folder;
    knip lists the folders_
- [x] Path filters and working directories:
      `deploy-{dash,notes,docs,agents,voice,admin,spa}.yml` (spa's also lists the extension),
      `main-os-e2e.yml`, `preview-delete.yml`, `preview-parents.yml`, `scripts/ci/preview-paths.ts`.
      The script's rewrite covers these; `depot-workflows.test.ts` checks them against the workspace.
      _rewritten by the script; depot-workflows.test.ts passes_
- [x] `pnpm-workspace.yaml`, `doppler.yaml`, `pnpm-lock.yaml` (importer paths). _lockfile: importer
      keys and two `link:` paths only, no version changes_
- [x] `lint/public-copies.test.ts` passes: the moved apps are now in iterate/packages, so their
      markdown can't link outside it (`../../docs/…`, `../../envs.ts`), and they can't name a PR
      as a bare `#N`. Dead links become plain paths. _9 dead links in the admin, agents, dash, docs
      and notes READMEs: core/lib ones link iterate/core, the rest are plain paths. No bare refs_
- [x] The packages copy runs when these apps change (below). _`.depot/workflows/copy-packages.yml`;
      `copybara.ts sync --copy core|packages`_
- [x] `README.md` repository map, `copybara/packages/README.md` (lists the apps), the apps' READMEs.
      _also the creating-an-app skill, which now puts a new app in `packages/<app>`_
- [ ] Evidence:
  - the PR's preview deploys dash, notes, docs, agents, voice and admin from their new folders
  - [x] the SPA has no per-PR preview: `pnpm --dir packages/spa build` zips the extension from
        `packages/browser-extension` _writes `iterate-chrome-extension-0.3.2.zip`_
  - [x] ~~a `--to-folder` run of the packages copy (as `copybara.ts check` does for core) includes
        them~~ _no Java 25 on this Mac; `lint/public-copies.test.ts` lists the copy's files from
        copy.bara.sky's globs, and it now covers the apps' markdown_

### When the packages copy runs

Today Deploy OS's `copybara` job copies both repos. Deploy OS's path filter covers `packages/ui`,
`shared` and `voice`, but none of the moved apps, so their changes would wait for the next OS
deploy.

Recommended: a new `copy-packages.yml`, on push to main, path-filtered to `packages/**`,
`configs/**`, `copybara/packages/**` and `LICENSE`, in one concurrency group that never cancels.
`copybara.ts sync` takes which copies to make; Deploy OS makes `core` only.

Not chosen: a copy job in each app's deploy workflow. Seven workflows would push to one repo, and
`checkCopy` requires the copy's tip to be exactly the synced commit. An older commit's deploy that
finishes after a newer one fails that check.

Either way the copy no longer waits for a production deploy, so "after each production deploy" in
`copybara/packages/README.md` changes to "after each change".

## Gotchas

- **The move script** got two things wrong in iterate/iterate#3487: it dropped a `./` from a fixture
  string whose target started with a dot, and prefixed `./` to plain relative markdown links.
  Compare every renamed file's old content (with only paths rewritten) against the new, as
  iterate/iterate#3487 did.
- **`tasks/`**: iterate/iterate#3487 left `tasks/` alone as history. Do that for `tasks/complete/`,
  but rewrite open task files.
- **After merge**, everyone runs `doppler setup` once to pick up the new folders.
- **Open PRs**: Jonas's draft iterate/iterate#3478 adds `apps/telemetry` and touches
  `scripts/lib/start-app.ts`, `doppler.yaml`, `pnpm-workspace.yaml` and `knip.ts`. Telemetry is
  internal, so it stays in `apps/`; expect small conflicts. Anything that adds a file under a moved
  app needs a manual move.
- **Gitignored task files** in the root checkout won't be rewritten: `tasks/docs-app.ignoreme.md`.
- Worker names, Doppler project names and package names don't change. Only folders do.

## Out of scope

- Extracting voice into its own repo, later.
- The cutover itself (`tasks/package-urls-survive-repo-move.md`).

## Implementation log

- 2026-10-01: inventory at `916a48f20`. 11 tracked apps; the ~40 other folders in `apps/` on disk are
  untracked leftovers. `pkg-pr-new.yml` publishes an explicit list of folders, so moving apps into
  `packages/` publishes nothing new to pkg.pr.new. The `.oxlintrc.json` platform-line rule already
  covers `packages/**` and `apps/**` alike. The LOC report counts both as Product.
- 2026-10-02: Misha picked: voice app to packages and kit later; admin public, ci-reports and
  dummy-petshop private; spa and browser-extension to packages; `<x>-app` folder names.
- 2026-10-02: Misha first deferred the move to iterate/private, then (via the privatization status
  session) put it back on iterate/iterate, before the cutover.
- 2026-10-02: merged main at `70dca5cdc`: iterate/iterate#3508 (licenses, core/os docs, the
  public-copies lint), iterate/iterate#3509 (qualified PR refs) and iterate/iterate#3511 (kit gone).
  `envs.ts` keeps `kitWorkers` for the fault alarm and the preview sweep.
- 2026-10-02: moved and checked locally: `pnpm typecheck`, `pnpm lint`, `pnpm knip`, `pnpm format`;
  the lint workspace's tests (74); the scripts workspace's tests, whose only failures are
  `toolchain` and `tracing` (macOS bash, as on main); agents-app's and voice-app's tests.
- 2026-10-02: PR CI green on `2fb923406`. Bugbot flagged `copy-packages.yml`'s header for
  repeating `copybara.ts`'s explanation of when each copy runs (rules/comments/no-repeated-explanations);
  the header now points there.
