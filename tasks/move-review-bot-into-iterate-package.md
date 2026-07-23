status: fixing-production-smoke
size: large

# Move the GitHub review bot into the iterate package

Status: Both Misha failures now have green regressions: the package ships a physical worker entry point, and alarm-observed source failures survive long enough to park subscribers with the exact error. Package/OS typechecks and 79 focused tests pass; the production workerd smoke remains.

## Plan

- [x] Add a public `iterate/github-ai-linter` module with a declarative `GithubAiLinter.create(...)` app definition. *Implemented in `packages/iterate/src/github-ai-linter/index.ts`.*
- [x] Keep event routing explicit in config while packaging the linter-specific reaction. *The worker keeps a private `#aiLintApp` and calls it from its existing `processEvent` hook; the SDK stays unchanged.*
- [x] Move the review processor, durable host, subscription bootstrap, and GitHub webhook routing from `iterate/config` into the package while preserving durable keys, subscription keys, freshness, and idempotency. *The packaged worker keeps the existing review-bot identities and routing tests.*
- [x] Load review rules from a repo glob descriptor; keep Iterate's canonical rule Markdown under root `rules/**/*.md` for both ordinary coding agents and the hosted linter. *Rule reads are pinned to the commit returned by `Repo.glob`; root agent instructions point to the same files.*
- [x] Export/build/type the package submodule and cover its public behavior with integration-style package tests. *Both public exports build and the focused package suite passes.*
- [x] Update the seeded config template and generated seed to import/register the package app; keep unrelated app routing and schedules out of scope. *The real template and generated file now contain the declaration.*
- [x] Update `iterate/config` from `main` to the same declaration and remove its local review-bot source. *The clean main checkout imports the package and deletes `apps/review-bot`.*
- [x] Run focused tests/typechecks plus config typecheck; record any production-shaped verification that cannot run locally. *Full monorepo typecheck, lint, format check, and tests pass; 29 focused OS tests, the package build, and the preview-10 deployment/E2E suite pass.*
- [x] Repair the production-derived Misha failure and ensure an existing v1 subscription can migrate. *Changed the invalid colon to a hyphen, bumped the subscription config revision to v2, and verified the emitted ref through the OS runtime schema.*
- [ ] Make the packaged worker build through the real worker-bundler contract. *The package now emits a physical configured-worker entry point and worker-bundler accepts the installed path locally; the production workerd smoke remains.*
- [x] Preserve terminal source-build errors for subscribers and stop retrying them. *The keyed coordinator stores a bounded one-shot failure receipt across actor eviction; the loader marks it non-retryable and the stream parks immediately with the exact error.*

## Approved decisions

1. `packages/iterate` owns the generic GitHub AI linter runtime; config only composes it.
2. Root `rules/**/*.md` is the one rule source. Config points the app at `/repos/iterate`; package artifacts do not duplicate the rule text.
3. The package owns dynamic-worker refs and subscription bootstrap; config explicitly routes project events to the configured linter.
4. Existing durable identities and idempotency semantics are migration invariants.
5. PR iterate/config#17 is design input, not code to merge.

## Implementation log

- 2026-07-22: Plannotator rounds approved the generic packaged runtime, root rule files, and the smallest declarative app registry needed for this bot.
- 2026-07-22: Added a commit-pinned repo glob API so all Markdown rules for one webhook come from one repository snapshot.
- 2026-07-22: Verified config against the local package source, then removed the temporary dependency install; no config lockfile was created.
- 2026-07-22: The full OS typecheck passed after temporarily moving an unrelated ignored scratch script out of its include path; the script was restored unchanged.
- 2026-07-22: Ported the implementation onto current `main`; the packaged worker now uses the SDK's newer shared `createProcessorHost` rather than duplicating its host lifecycle.
- 2026-07-22: Full monorepo typecheck, lint, format check, and tests pass on the worktree branch; package build and focused GitHub/template tests also pass.
- 2026-07-22: The first preview exposed one stale E2E fixture assertion for the deleted seeded bot path. Removed that assertion, added the inverse check, and updated the GitHub-agent guide to describe the packaged runtime and Markdown rules; preview rerun pending.
- 2026-07-23: Opened draft PRs iterate/iterate#2259 and iterate/config#18; the config PR consumes #2259's pkg.pr.new artifact until the package change reaches `main`.
- 2026-07-23: Review rejected the generic project-app registry as premature. Restored the SDK's explicit `processEvent` seam and made both workers call their private configured linter directly.
- 2026-07-23: Replaced iterate/iterate#2259 with #2277 after pkg.pr.new lost the reopened PR's workflow mapping. Carried the resolved human review into the replacement PR and updated config#18 to consume its branch artifact.
- 2026-07-23: Preview-10 deployed the exact implementation SHA for all five apps; every E2E lane passed, including OS Playwright and 47 OS Vitest files.
- 2026-07-23: Misha's end-to-end trial exposed `app-review-bot:<connection>` being rejected by the runtime durable-worker-key schema. The existing v1 config event would also conflict with a changed replacement event, so the production-derived regression covers both failures.
- 2026-07-23: Replaced the colon with a runtime-safe hyphen and bumped the subscription event to v2. The production-derived repro, all 162 package tests, and package/OS typechecks pass.
- 2026-07-23: Misha's next smoke reached worker-bundler, which rejected the virtual entry point because virtual modules are import aliases rather than files. Added a real-bundler regression that fails with the exact production error before changing the package layout.
- 2026-07-23: Added `dist/github-ai-linter/configured-worker.mjs` as the physical entry point, kept only the per-install config virtual, and bumped subscription config to v3 so Misha replaces the temporary smoke subscription.
- 2026-07-23: Cloudflare traces showed each build settling as `source-failed` in about 0.6 seconds while the subscriber retained `This worker is still building.` and retried. The follow-up must durably expose that terminal compiler error and park the subscription.
- 2026-07-23: Added a one-shot durable terminal-failure receipt to the keyed build coordinator. The next foreground call consumes it, the loader restores the non-retryable verdict after Workers RPC, and the stream parks on the first exact source error without another alarm; explicit resume can still retry a potentially transient package-install failure.
