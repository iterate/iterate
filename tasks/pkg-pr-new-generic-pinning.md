---
status: in-progress
size: medium
branch: pkg-pr-new-generic-pinning
base: tasks-app-package-bridge
---

# Name-agnostic pkg.pr.new ref pinning

## Status

Spec committed first; implementation follows on this branch. Stacked on
tasks-app-package-bridge (PR #2304); retarget to main when that merges.

## Goal

The OS kernel currently pins previews to the PR's `iterate` build by
hardcoding one package name in five places (config, env, seeding, dynamic
builds, deploy). Replace that with name-agnostic pkg.pr.new *ref* pinning:
parse dependency specs, and if a spec is a pkg.pr.new URL for the
iterate/iterate repo, swap its `@<ref>` for the pinned SHA. Adding
`@iterate-com/tasks` (or any future package) to the template later must
require zero kernel changes.

## Locked decisions

- **Baked-in assumption** (stated in a comment where the URL parsing lives):
  this repo publishes packages via pkg.pr.new in a uniform way, forever. If
  that ever stops being true, we change this code then.
- URL shapes handled, both verified resolving:
  - `https://pkg.pr.new/iterate/iterate/<name>@<ref>` — `<name>` may be
    scoped (`@iterate-com/tasks`), so the ref is split on the *last* `@`
  - `https://pkg.pr.new/iterate/iterate@<ref>` (compact form)
  - refs: `main`, 40-char SHA, or PR number
- The preview knob is a **ref, not a spec**: `iterateRepoPkgRef` /
  `APP_CONFIG_ITERATE_REPO_PKG_REF`, written by deploy from
  `PREVIEW_PULL_REQUEST_HEAD_SHA`. The old spec-shaped
  `APP_CONFIG_ITERATE_SDK_PACKAGE_SPEC` is removed outright — previews
  rewrite secrets atomically every deploy and prod never set it.
- Fail loudly, in spirit of the current guard: a provided ref that matches
  NO spec must throw (a silently unpinned preview is the failure mode).
- Dynamic builds keep the devDependencies→dependencies promotion for
  *matched* packages (worker-bundler ignores devDeps), and the knobs stay in
  the build key so preview builds never collide with main builds.
- Deploy derives the pkg.pr.new URLs to await by scanning the config repo
  template's manifests for matching specs, pinning each, and polling all in
  parallel.
- Net behavior today is identical (only `iterate` exists in the template).

## Assumptions made (delegated-task guesses, clearly delineated)

- **Local dev also sets the old env var** — the brief assumed only previews
  did, but `apps/os/scripts/lib/dev-sdk-tarball.ts` packs the worktree SDK
  and points `APP_CONFIG_ITERATE_SDK_PACKAGE_SPEC` at a
  `http://127.0.0.1:<port>/iterate-<hash>.tgz` URL so dev builds use the
  local SDK. A ref cannot express "this local tarball", and shape-matching
  the *current* spec can't either (a dev repo seeded with tarball-URL-1
  must be rewritten to tarball-URL-2 after an SDK edit — the old tarball is
  deleted). Decision: a second, also name-agnostic-in-the-kernel knob:
  `iterateRepoPkgSpecOverrides` / `APP_CONFIG_ITERATE_REPO_PKG_SPEC_OVERRIDES`,
  a JSON map of dependency name → replacement spec, applied wholesale to
  matching dependency names. The kernel never hardcodes a name; dev.ts
  (which literally packs `packages/iterate`) supplies `{"iterate": <url>}`.
- The shared config env parser (`packages/shared/src/config.ts`) throws when
  an env override carries an object value for a non-`z.object` field, which
  breaks `z.record` config fields. Treating `z.record` as "any keys OK" in
  the unknown-key checker is a no-brainer product fix, done here (small,
  tested) rather than worked around.
- `reset-config-repo.ts` swaps `--sdk-spec` for `--pkg-ref` (same
  deployment-matching default behavior, reading the new env vars).
- Build keys for unpinned builds are preserved (`stableSha256` drops
  undefined fields), so prod's warm artifact cache survives the rename.

## Checklist

- [ ] `apps/os/src/pkg-pr-new.ts`: parse/pin helpers for iterate/iterate
      pkg.pr.new specs (compact + scoped long form, last-`@` ref split), with
      the uniform-usage assumption comment; unit tests.
- [ ] Shared config parser: allow `z.record` fields to receive JSON object
      env overrides; test in `packages/shared/src/config.test.ts`.
- [ ] Config/env: replace `iterateSdkPackageSpec` /
      `APP_CONFIG_ITERATE_SDK_PACKAGE_SPEC` with `iterateRepoPkgRef` and
      `iterateRepoPkgSpecOverrides`; grep proves the old name is gone.
- [ ] Seeding: `projectRepoSeedFiles` rewrites any matching spec in template
      package.json files (ref pin + name overrides), throws when a provided
      knob matches nothing; export template spec scan for deploy.
- [ ] Dynamic builds: generalize `applyIteratePackageSpecOverride` (rename),
      keep devDeps→deps promotion for matched packages; thread both knobs
      through build key, worker-loader, and the build coordinator.
- [ ] Deploy: set the ref from `PREVIEW_PULL_REQUEST_HEAD_SHA`; scan + pin
      template specs and await all pinned URLs in parallel.
- [ ] Local dev: dev.ts/dev-sdk-tarball/vite/generate-wrangler-config move to
      the overrides map; stale-tarball rewrite behavior preserved.
- [ ] Update comments/docs that name the old knob (pkg-pr-new.yml,
      preview.ts, e2e alarm test, separate-iterate-sdk-package task).
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format`, touched test files green.

## Implementation log

- Branched off origin/tasks-app-package-bridge @ 306d85e23.
- Confirmed both URL shapes resolve and that `stableSha256` drops
  undefined object fields (build-key stability for the no-knob case).
