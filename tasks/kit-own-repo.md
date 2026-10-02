---
status: in-progress
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

- Spec only so far.

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
- **Firmware versions restart their count.** A version is `<first-parent commit count>-<date>-<sha7>`
  on the repo's main. iterate/kit's main has about 100 commits, so its first release is
  `0001xx-…`, below iterate/iterate's `003xxx-…`. Nothing compares versions across repos: Kit lists
  only its own repo's tags, and a board updates only when someone calls `system.update` with a URL.
  The date still says which is newer.
- **Depot CI, as iterate/iterate.** The depot-code-access app is installed on every repo in the
  org, and the org's one Depot secret, `DOPPLER_TOKEN`, comes with it. No new credentials. The tag
  ruleset is recreated on iterate/kit with the same bypass.
- **Packages:** `iterate` and `@iterate-com/voice` from pkg.pr.new at a pinned iterate/iterate main
  commit (iterate/private after the cutover). Components from the shadcn registry on
  iterate/packages (`iterate-logo`, `log-in-with-iterate`, `posthog`) and shadcn's own (`button`,
  `field`, …). The few files Kit used from `packages/ui/src/apps` and `packages/shared` are copied
  into `src/app/`, each saying where it came from.
- **Kit's own `envs.ts`** holds `preview` and `prd` (the same workers, Doppler project `kit`), and
  the Worker config that `scripts/lib/start-app.ts` used to build. Its `denyZones` is a copy of
  iterate/iterate's `ownZones()` at the move.
- **Deploys:** main pushes deploy `preview` (kit.iterate-dev-preview.workers.dev, signs in against
  os.iterate-dev-preview) and then `prd` (k.iterate.com). Same Worker names, so nothing is created
  or deleted. Per-PR Kit previews are left for later; iterate/iterate's PR previews lose their kit.
- **Paging:** a red main run of the firmware or deploy workflow posts to #error-pulse with the
  Slack bot token in Doppler `kit/prd`. Smaller than iterate's dashboard rows; the same channel.
- **iterate/iterate keeps** `k.iterate.com` in the prd project wildcard's `excludedHostnames`, and
  `kiterate` in the prd fault alarm's workers: it's still a first-party Worker on the prd account.
  Comments in `packages/voice` and `core/os` that point into `apps/kit/firmware` link to iterate/kit.

## Cutover order

Nothing may redeploy k.iterate.com from iterate/iterate once iterate/kit deploys it, or Kit would
go back to listing iterate/iterate's releases.

1. Merge the iterate/iterate PR that removes `apps/kit` (deletes `deploy-kit.yml` and
   `kit-firmware.yml`). k.iterate.com keeps serving its last deploy, still listing iterate/iterate's
   releases, which the archive keeps serving.
2. Merge iterate/kit's PR. Its main push builds and publishes every board's first release on
   iterate/kit and deploys Kit, which then lists iterate/kit's releases.
3. Check k.iterate.com lists the new versions and serves their files (the firmware workflow's last
   step does this).

## Plan

- [ ] iterate/kit: create (public), push the filtered history to main
- [ ] iterate/kit: tag ruleset like iterate/iterate's
- [ ] iterate/kit PR: standalone package (pkg.pr.new, shadcn, `src/app/`, `envs.ts`, deploy script)
- [ ] iterate/kit PR: CI (typecheck, lint, format, vitest, firmware host tests), firmware releases,
      deploy, paging
- [ ] iterate/kit PR: README/AGENTS.md for the new layout; `apps/kit/...` paths in comments fixed
- [ ] Evidence: the PR's CI green, firmware legs build every board, a preview Worker deployed from
      the branch signs in and lists firmware
- [ ] iterate/iterate PR: remove `apps/kit` and its plumbing (workflows, preview set, envs, knip,
      doppler.yaml, docs, tests)
- [ ] Tell the Archive Handover session (draft root-commit message lists `apps/kit`) and the
      apps-into-packages session
- [ ] Note in `tasks/run-this-script.md` that Kit's Prepare card is now an iterate/kit change
