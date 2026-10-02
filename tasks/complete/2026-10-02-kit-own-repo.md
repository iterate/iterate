---
status: done
size: large
---

# Kit moves to iterate/kit

iterate/iterate becomes a public archive, and iterate/private starts as one fresh commit of its
main. Kit is the one thing that would force workarounds into iterate/private's first commits:
boards download firmware releases without signing in, so the releases must live in a public repo.
So Kit (`apps/kit`: the ESP-IDF 6.1 firmware, the Mac board, the flasher and the setup UI) moves to
its own public repo, iterate/kit, before the cutover. The 9/29 Tuple call already listed kit and
firmware as separate repos. iterate/mobile made the same split on 9/30.

## Status

- Done. iterate/iterate#3511 removes Kit here and iterate/kit#1 makes it stand alone there; both
  merge in the cutover order below, which the same session runs right after: prd deploys from
  iterate/kit before its PR merges, then the leftover `-kit` preview Workers go.
- Outside the PRs: iterate/kit is public with apps/kit's history, its rulesets and iterate's merge
  settings, and every board's newest release copied there.

## What ties Kit to iterate/iterate

- Firmware releases: `FIRMWARE_REPOSITORY = "iterate/iterate"` (`apps/kit/src/firmware/catalog.ts`),
  used by `releases.ts` (lists tags from the browser) and `firmware-proxy.ts` (k.iterate.com streams
  release files). `kit-firmware.yml` publishes to `github.repository`. `firmware-release.ts` runs
  `git ls-remote origin` with no credentials. The "Kit firmware tags" ruleset guards
  `refs/tags/kit-firmware/**` (bypass: repository admins and the depot-code-access app).
  About 7 boards × 20 releases live on iterate/iterate; the archive keeps serving them.
- The Worker: k.iterate.com (`kiterate` on the prd account) deploys from `deploy-kit.yml`, and
  `kit.iterate-dev-preview.workers.dev` from `preview-parents.yml`. Every PR's preview set deploys a
  kit too (`PREVIEW_DEPLOYMENT_APPS`).
- Code: `envs.ts` (`kitEnvs`), `scripts/lib/start-app*.ts` (Worker config, build, deploy),
  `scripts/ci/{esp-idf,toolchain}.sh`, `@iterate-com/ui` (shadcn components and the shared
  `apps/{server,router,head,document}` scaffolding), `@iterate-com/shared` (`start-app-config`,
  `posthog`, vitest reporters), `@iterate-com/voice/install` and the `iterate` SDK (`core/lib`).

## Decisions (assumed; Misha to confirm in review)

- **Public repo, with apps/kit's history.** `git filter-repo --subdirectory-filter apps/kit` (99
  commits since #2347), with each `(#N)` in a message rewritten to `(iterate/iterate#N)`, so links
  reach the archive. Firmware `git log`/`blame` keeps working. The import lands on iterate/kit's
  main as-is (it does not build there yet); the PR that makes it build stacks on top.
- **Repo root = old `apps/kit`.** `firmware/`, `src/`, `scripts/`, `public/` at the top.
- ~~**Firmware versions restart their count.**~~ _Changed while building it: versions count on from
  iterate/iterate's (`COMMITS_BEFORE_THE_MOVE = 3103 - 99` in firmware-release.ts), and each
  board's newest release, `003103-2026-10-02-bbd8934`, is copied to iterate/kit at 5a0e46f (the
  filtered bbd8934, which built them). Without the copies, k.iterate.com would list no firmware
  from its first deploy from iterate/kit until the first builds there published (10–15 minutes);
  with a restarted count, the copies would sort above every new release forever._
- **Depot CI, as iterate/iterate.** The depot-code-access app is installed on every repo in the
  org, and the org's one Depot secret, `DOPPLER_TOKEN`, comes with it. No new credentials. The tag
  ruleset is recreated on iterate/kit with the same bypass.
- **Packages:** `iterate` and `@iterate-com/voice` from pkg.pr.new at a pinned iterate/iterate main
  commit (iterate/private after the cutover). Components from the shadcn registry on
  iterate/packages (`iterate-logo`, `log-in-with-iterate`, `posthog`) and shadcn's own (`button`,
  `field`, …). The few files Kit used from `packages/ui/src/apps` and `packages/shared` are copied
  into `src/app/`, each saying where it came from.
- **Kit's own `envs.ts`** holds `preview` and `prd` (the same workers, Doppler project `kit`) as
  plain data, and `vite.config.ts` builds the Worker config that `scripts/lib/start-app.ts` used to.
  Its `denyZones` is a copy of iterate/iterate's `ownZones()` at the move. _`preview` deploys with
  Doppler `kit/dev`: kit has no `preview` config, and iterate deployed it with `os/preview`'s
  token._
- **Deploys:** main pushes deploy `preview` (kit.iterate-dev-preview.workers.dev, signs in against
  os.iterate-dev-preview) and then `prd` (k.iterate.com). Same Worker names, so nothing is created
  or deleted. Per-PR Kit previews are left for later; iterate/iterate's PR previews lose their kit.
- **Paging:** a red main run of the firmware or deploy workflow posts to #error-pulse with the
  Slack bot token in Doppler `kit/prd`. Smaller than iterate's dashboard rows; the same channel.
- **iterate/iterate keeps** `k.iterate.com` in the prd project wildcard's `excludedHostnames`, and
  `kiterate` in the prd fault alarm's workers: it's still a first-party Worker on the prd account.
  _Done as `kitWorkers` in envs.ts, which also keeps `kit.iterate-dev-preview.workers.dev` in
  `ownZones` and stops the preview sweep listing the dev `kit` Worker as unknown._
  Comments in `packages/voice` and `core/os` that point into `apps/kit/firmware` link to iterate/kit.

## Cutover order

Nothing may redeploy k.iterate.com from iterate/iterate once iterate/kit deploys it, or Kit would
go back to listing iterate/iterate's releases.

1. Merge the iterate/iterate PR that removes `apps/kit` (deletes `deploy-kit.yml` and
   `kit-firmware.yml`). k.iterate.com keeps serving its last deploy, still listing iterate/iterate's
   releases, which the archive keeps serving.
2. Check no Deploy Kit run is still queued or running here (its concurrency group queues runs
   instead of cancelling them, and a late one would overwrite step 3). Then deploy prd from
   iterate/kit#1's head (`pnpm run deploy --env prd`). Kit then lists iterate/kit's
   releases, the copied `003103-…` ones, so there is no gap. Deploying before the merge matters:
   on the merge's push, Deploy and Kit Firmware both take about 3 minutes, and the firmware's last
   step (k.iterate.com serves the new files) would race prd's deploy and page.
3. Merge iterate/kit's PR. Its main push deploys again and builds and publishes `003104-…` for
   every board (the PR changes files in every board's inputs).
4. Check k.iterate.com lists `003104-…`.
5. Delete the per-commit preview Workers named `…-<sha7>-kit` on the dev account (two on
   2026-10-02: `main-bbd8934-kit`, `pr3478-bc264e9-kit`, plus any preview deployed before this
   merges). Once Kit is out of `PREVIEW_DEPLOYMENT_APPS`, the sweep and cleanups no longer count
   them as members of their deployments, so nothing else deletes them.

## Plan

- [x] iterate/kit: create (public), push the filtered history to main _(99 commits, 5a0e46f)_
- [x] iterate/kit: tag ruleset like iterate/iterate's _(ruleset 24352548)_
- [x] Copy each board's newest release to iterate/kit _(7 releases, sha256 of every asset checked)_
- [x] iterate/kit PR: standalone package (pkg.pr.new, shadcn, `src/app/`, `envs.ts`, deploy script)
      _(iterate/kit#1)_
- [x] iterate/kit PR: CI (typecheck, lint, format, vitest, firmware host tests), firmware releases,
      deploy, paging _(`.depot/workflows/{ci,kit-firmware,deploy}.yml`, `scripts/ci/page.ts`)_
- [x] iterate/kit PR: README/AGENTS.md for the new layout; `apps/kit/...` paths in comments fixed
- [x] Evidence: the PR's CI green, firmware legs build every board, a preview Worker deployed from
      the branch serves the releases _(sign-in reaches the dev platform; I didn't sign in)_
- [x] iterate/iterate PR: remove `apps/kit` and its plumbing (workflows, preview set, envs, knip,
      doppler.yaml, docs, tests)
- [x] Cutover, in order: merge this PR, deploy prd from iterate/kit#1's head, merge it _(this session, on Misha's go-ahead)_
- [x] Tell the Archive Handover session once kit is gone _(told it the PRs are open; again after the merge)_
- [x] Tell the apps-into-packages session
- [x] Note in `tasks/run-this-script.md` that Kit's Prepare card is now an iterate/kit change

## Implementation notes

- Depot CI ran iterate/kit's workflows with no setup: depot-code-access is on every org repo, and
  the org's `DOPPLER_TOKEN` reaches them. ESP-IDF's first install there came from the network (the
  key is the pin file's hash, and the moved file's header changed); main's first run caches it.
- iterate's `toolchain.test.ts` fails on macOS (bash 3.2 has no `inherit_errexit`); the script only
  runs in CI. iterate/kit's copy skips there.
- Lint run in this `.claude` worktree reads no files; it was run from a worktree outside it.
- For mobile (Misha asked): iterate/kit's deploys are the pattern worth copying to iterate/mobile,
  whose website deploys by hand: `envs.ts` as data, `vite.config.ts` building the Worker config,
  `pnpm run deploy --env`, a Deploy workflow with preview before prd, and a page on red. Its EAS
  builds could publish like Kit's releases (GitHub releases planned by input diffs), if it ever
  needs downloads without signing in.
- A review of both PRs (a subagent, 2026-10-02) found: `pnpm deploy` is pnpm's own command (fixed:
  `pnpm run deploy`); iterate/kit's main was unprotected (added "Required CI" for its two CI
  checks, "Main's history" against force pushes and deletion, and iterate's merge settings: squash
  with the PR's title and body); Kit's voice pin is invisible from `packages/voice` (a comment in
  `install.ts`); orphaned `-kit` preview Workers after the merge (cutover step 5); iterate's zod
  patch was missing (copied). Left as is: `scripts/ci/page.ts` pages once per red run, so a board
  that stays broken pages daily from the scheduled run, where iterate's notify.ts keeps one page
  per red streak.
