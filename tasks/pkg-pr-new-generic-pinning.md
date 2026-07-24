---
status: done-pending-review
size: medium
branch: pkg-pr-new-generic-pinning
base: main
---

# Name-agnostic pkg.pr.new ref pinning

## Status

Implemented and verified (typecheck, lint, format, full apps/os unit suite,
shared package suite all green). #2304 merged, so this now targets main
directly; its preview ran clean on os-preview-5 (including the retired-secret
path). Bugbot review handled: merge-artifact comment dedupe + switching the
retired-Worker-secret assert to a verified delete. PR: #2307.

Main pieces: a single URL-grammar module (`apps/os/src/pkg-pr-new.ts`), the
two knobs (`iterateRepoPkgRef` preview ref + `iterateRepoPkgSpecOverrides`
local-dev tarball map) threaded through seeding, dynamic builds, build keys,
deploy, and local dev. Nothing missing; net behavior today is identical.

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
  - refs: `main`, a 40-char SHA, or a PR number
- The preview knob is a **ref, not a spec**: `iterateRepoPkgRef` /
  `APP_CONFIG_ITERATE_REPO_PKG_REF`, written by deploy from
  `PREVIEW_PULL_REQUEST_HEAD_SHA`. The old spec-shaped
  `APP_CONFIG_ITERATE_SDK_PACKAGE_SPEC` is removed outright — prod never set
  it, and stale preview-worker bindings are retired via the established
  `RETIRED_WORKER_SECRETS` path (see assumptions).
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
- **The brief's "previews rewrite secrets atomically" isn't quite true** —
  `wrangler deploy --secrets-file` deliberately preserves omitted secrets, so
  removed env vars linger on preview Workers (and would trip the config
  parser's loud unknown-key warning). `APP_CONFIG_ITERATE_SDK_PACKAGE_SPEC`
  is added to `RETIRED_WORKER_SECRETS`, and — per bugbot's correct
  high-severity catch — deploy now DELETES retired Worker secrets (loudly,
  verified) instead of assert-failing. The original assert-only version was
  sticky: lease RENEWALS deliberately skip the erase-on-acquire, and every
  failed deploy renews the lease, so an open PR whose slot carried the old
  binding would have failed `assertWorkerSecretAbsent` forever. Deploy
  scripts are the only writers of Worker secrets, so a lingering retired name
  can only mean "last deployed by older code" — convergence is safe. The
  Doppler-side retirement (`assertDopplerSecretAbsent`) stays fail-closed
  because Doppler is human-edited. Prod never carried the var.
- The shared config env parser (`packages/shared/src/config.ts`) threw when
  an env override carried an object value for a non-`z.object` field, which
  breaks `z.record` config fields. Treating `z.record` as "any keys OK" in
  the unknown-key checker is a no-brainer product fix, done here (small,
  tested) rather than worked around.
- `reset-config-repo.ts` swaps `--sdk-spec` for `--pkg-ref` (same
  deployment-matching default behavior, reading the new env vars).
- Build keys for unpinned builds are preserved (`stableSha256` drops
  undefined fields), so prod's warm artifact cache survives the rename.

## Checklist

- [x] `apps/os/src/pkg-pr-new.ts`: parse/pin helpers for iterate/iterate
      pkg.pr.new specs (compact + scoped long form, last-`@` ref split), with
      the uniform-usage assumption comment; unit tests.
      _`parseIterateRepoPkgSpec` / `pinIterateRepoPkgRef` /
      `parseIterateRepoPkgSpecOverridesEnv`, covered by `pkg-pr-new.test.ts`._
- [x] Shared config parser: allow `z.record` fields to receive JSON object
      env overrides; test in `packages/shared/src/config.test.ts`.
      _ZodRecord short-circuits the unknown-key walk; new record-field test._
- [x] Config/env: replace `iterateSdkPackageSpec` /
      `APP_CONFIG_ITERATE_SDK_PACKAGE_SPEC` with `iterateRepoPkgRef` and
      `iterateRepoPkgSpecOverrides`; grep proves the old name is gone.
      _config.ts + env.ts; the old env name survives only in
      `RETIRED_WORKER_SECRETS` (deliberate) and historical task docs._
- [x] Seeding: `projectRepoSeedFiles` rewrites any matching spec in template
      package.json files (ref pin + name overrides), throws when a provided
      knob matches nothing; export template spec scan for deploy.
      _Parse-based rewrite; unchanged files stay reference-identical;
      `templateIterateRepoPkgSpecs()` feeds deploy._
- [x] Dynamic builds: generalize `applyIteratePackageSpecOverride` (rename),
      keep devDeps→deps promotion for matched packages; thread both knobs
      through build key, worker-loader, and the build coordinator.
      _`applyIterateRepoPkgOverrides` in build-backend.ts; knobs hash into
      `workerBuildKey` and ride `WorkerBuildRequest`._
- [x] Deploy: set the ref from `PREVIEW_PULL_REQUEST_HEAD_SHA`; scan + pin
      template specs and await all pinned URLs in parallel.
      _`previewPackageSpecsToAwait(ref)` + per-URL `waitForPreviewPackage`,
      joined in the existing concurrent-build-work Promise.allSettled._
- [x] Local dev: dev.ts/dev-sdk-tarball/vite/generate-wrangler-config move to
      the overrides map; stale-tarball rewrite behavior preserved.
      _dev.ts sets `{"iterate": specUrl}`; the vite-side server finds the
      loopback URL among the override values._
- [x] Update comments/docs that name the old knob (pkg-pr-new.yml,
      preview.ts, e2e alarm test, separate-iterate-sdk-package task).
- [x] `pnpm typecheck`, `pnpm lint`, `pnpm format`, touched test files green.
      _Plus the full apps/os unit suite (237 files / 2341 tests) and the
      whole packages/shared suite._

## Implementation log

- Branched off origin/tasks-app-package-bridge @ 306d85e23.
- Confirmed both URL shapes resolve and that `stableSha256` drops
  undefined object fields (build-key stability for the no-knob case).
- Seed rewrite is parse-based (JSON.parse + 2-space stringify, byte-identical
  for the template's formatting) instead of the old exact-string replaceAll;
  unchanged manifests return the original file objects so the no-knob path
  stays `toBe`-identical to the template.
- Dynamic-build promotion semantics narrowed deliberately: only *matched*
  dependencies (pkg.pr.new-spec'd or overridden) are promoted from
  devDependencies; an arbitrary non-pkg.pr.new `iterate` spec no longer is.
  Template-derived repos are unaffected (their specs are pkg.pr.new URLs).
- Kept `waitForPreviewIteratePackage`'s poll internals; renamed to
  `waitForPreviewPackage` (messages now name the spec, not "iterate").
- Discovered `--secrets-file` preserves omitted secrets → retired the old
  env name via `RETIRED_WORKER_SECRETS` instead of assuming atomic rewrite.
- Post-review (#2304 merged, PR retargeted to main): fixed a duplicated
  comment block in pkg-pr-new.yml from the main merge, and — after bugbot's
  high-severity catch about lease renewals skipping the erase — switched
  deploy from asserting retired Worker secrets absent to deleting them
  (shared `removeWorkerSecrets` helper, same one erase-data uses;
  `assertWorkerSecretAbsent` deleted as now-unused). Coverage lives with the
  helper (`scripts/lib/deploy-helpers.test.ts`, incl. new shape/error
  propagation cases) plus a deploy-kernel convergence test in
  `deploy.test.ts` (present → deleted+verified; absent → read-only no-op).
