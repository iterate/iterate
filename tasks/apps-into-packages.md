---
status: waiting-for-iterate-private
size: large
---

# The apps we stand behind move to `packages/`

`packages/` holds the products we stand behind: "the components of a product that our friends use"
(Misha and Jonas, 9/29). The folder is `packages`, not `first-party` (10/1). There's no `slop/`
folder: apps we don't stand behind go to their own repos (Misha, 2026-10-01).

Everything in `packages/` is public: Copybara copies `packages/**` and `configs/**` to
iterate/packages after each Deploy OS (iterate/iterate#3493).

## Status

- Plan only. No code changed.
- Every placement is decided (Misha, 2026-10-02).
- Waits for the cutover: the move is made in iterate/private, not here (Misha, 2026-10-02). Until it
  lands, these apps' latest source is private; the iterate/iterate archive keeps their source as of
  the cutover.
- iterate/private starts as one fresh commit, so this branch (`apps-into-packages` on iterate/iterate)
  can't be merged there. Copy this file and `tasks/apps-into-packages.move.mjs` across, then recheck
  every path and line number below against iterate/private's main.
- Same size and shape as iterate/iterate#3487 (`mkdir core && mv apps/os core`): a scripted path rewrite plus a few
  hand-written changes.

## Where each app goes

| Now                                     | After                                                       |
| --------------------------------------- | ----------------------------------------------------------- |
| `apps/dash`                             | `packages/dash`                                             |
| `apps/notes`                            | `packages/notes`                                            |
| `apps/docs`                             | `packages/docs-app`                                         |
| `apps/agents`                           | `packages/agents-app`                                       |
| `apps/voice`                            | `packages/voice-app`                                        |
| `apps/admin`                            | `packages/admin`                                            |
| `apps/spa`                              | `packages/spa`                                              |
| `apps/browser-extension`                | `packages/browser-extension`                                |
| `apps/kit`                              | stays in `apps/` until its own PR moves it to `iterate/kit` |
| `apps/ci-reports`, `apps/dummy-petshop` | stay in `apps/`, private                                    |

After this, `apps/` means "private": internal CI tooling and test fixtures, plus kit until it leaves.

**Folder names.** Folder = package name without `@iterate-com/`. That avoids the clashes with
`packages/docs` (`@iterate-com/docs`) and `packages/voice` (`@iterate-com/voice`) and needs no
package renames. `@iterate-com/agents-app` keeps its name, so its folder is `agents-app` even though
`packages/agents` is free since iterate/iterate#3496. Every folder stays two levels deep, so relative paths into and
out of an app keep their `../` count, as in iterate/iterate#3487.

Not chosen: one folder per product with `lib/` and `app/` inside (`packages/docs/{lib,app}`). It
moves the published libraries too and changes the depth of every path in six packages.

**Why each one (Misha, 2026-10-02):**

- **kit**: own repo per 9/29, but not in this PR. It's 464 files with its own firmware CI
  (`kit-firmware.yml`) and release assets that `apps/kit/src/firmware/catalog.ts`
  (`FIRMWARE_REPOSITORY`) downloads anonymously. Extracting it is its own job.
- **voice app**: friends use it with Kit, and `packages/voice` is already public. If voice later gets
  its own repo, it goes with kit, `packages/voice` and `configs/voice`.
- **admin**: public. Its source has no secrets or state of its own; it's an OAuth client like the dash.
- **spa, browser-extension**: public, together: the SPA's build makes the extension's zip and serves
  it on its downloads page.
- **ci-reports, dummy-petshop**: private. Internal CI tooling and a test fixture.

## Plan

- [ ] Move with iterate/iterate#3487's script (below), with a new move list. It moves each file, recomputes
      relative imports and markdown links from the new place, and rewrites path mentions.
- [ ] Paths built from an app's name instead of its folder. These break once name and folder
      differ (`docs` → `packages/docs-app`):
  - `scripts/os/preview.ts:329` `path.resolve(REPO_ROOT, "apps", app.name)`: use `app.root`
  - `scripts/ci/depot-workflows.test.ts:100`: `deploy-<app>.yml` → `apps/<app>`
  - `knip.ts:114`: the Start apps' workspaces
  - `scripts/lib/start-app.ts`: `StartApp.name`'s doc ("the directory under apps/") and the
    `apps/${app.name}` error messages and `appLabel`
- [ ] Path filters and working directories:
      `deploy-{dash,notes,docs,agents,voice,admin,spa}.yml` (spa's also lists the extension),
      `main-os-e2e.yml`, `preview-delete.yml`, `preview-parents.yml`, `scripts/ci/preview-paths.ts`.
      The script's rewrite covers these; `depot-workflows.test.ts` checks them against the workspace.
- [ ] `pnpm-workspace.yaml`, `doppler.yaml`, `pnpm-lock.yaml` (importer paths).
- [ ] The packages copy runs when these apps change (below).
- [ ] `README.md` repository map, `copybara/packages/README.md` (lists the apps), the apps' READMEs.
- [ ] Evidence:
  - the PR's preview deploys dash, notes, docs, agents, voice and admin from their new folders
  - the SPA has no per-PR preview: `pnpm --dir packages/spa build` zips the extension from
    `packages/browser-extension`
  - a `--to-folder` run of the packages copy (as `copybara.ts check` does for core) includes them

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

- **The move script** is `tasks/apps-into-packages.move.mjs`, iterate/iterate#3487's unchanged (it was only ever in
  the "copybara experiment" session's scratchpad). Give it this task's move list, and delete it in
  the move's PR. In iterate/iterate#3487 it dropped a `./` from a fixture string whose target started with a dot,
  and prefixed `./` to plain relative markdown links. Compare every renamed file's old content (with
  only paths rewritten) against the new, as iterate/iterate#3487 did.
- **`tasks/`**: iterate/iterate#3487 left `tasks/` alone as history. Do that for `tasks/complete/`, but rewrite open
  task files: `tasks/package-urls-survive-repo-move.md` names `apps/dash/...` paths.
- **After merge**, everyone runs `doppler setup` once to pick up the new folders.
- **Open PRs** (as of iterate/iterate on 2026-10-02): Jonas's draft iterate/iterate#3478 adds `apps/telemetry` and touches `scripts/lib/start-app.ts`,
  `doppler.yaml`, `pnpm-workspace.yaml` and `knip.ts`. Telemetry is internal, so it stays in `apps/`;
  expect small conflicts. Anything that adds a file under a moved app needs a manual move.
- **Gitignored task files** in the root checkout won't be rewritten: `tasks/docs-app.ignoreme.md`.
- Worker names, Doppler project names and package names don't change. Only folders do.

## Out of scope

- Extracting kit (and later voice) into their own repos.
- The license mismatch: AGPL at the root (which the copy includes), Apache-2.0 in the packages'
  `package.json` files.
- The iterate/private cutover itself (`tasks/package-urls-survive-repo-move.md`).

## Implementation log

- 2026-10-01: inventory at `916a48f20`. 11 tracked apps; the ~40 other folders in `apps/` on disk are
  untracked leftovers. `pkg-pr-new.yml` publishes an explicit list of folders, so moving apps into
  `packages/` publishes nothing new to pkg.pr.new. The `.oxlintrc.json` platform-line rule already
  covers `packages/**` and `apps/**` alike. The LOC report counts both as Product.
- 2026-10-02: Misha picked: voice app to packages and kit later; admin public, ci-reports and
  dummy-petshop private; spa and browser-extension to packages; `<x>-app` folder names.
- 2026-10-02: rechecked at `0572e75c9` (after iterate/iterate#3506 and iterate/iterate#3507). `checkCopy` still requires the copy's
  tip to be exactly the synced commit; `preview.ts` still builds app paths from `apps/<name>`.
- 2026-10-02: Misha: make the move in iterate/private, after the cutover. This branch holds the plan
  and the script until then.
