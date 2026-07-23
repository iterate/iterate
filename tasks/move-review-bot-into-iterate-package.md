status: needs-preview
size: large

# Move the GitHub review bot into the iterate package

Status: The implementation and config migration are ported onto current `main`. All local checks and package publication pass; the preview rerun remains.

## Plan

- [x] Add a public `iterate/github-ai-linter` module with a declarative `GithubAiLinter.create(...)` app definition. *Implemented in `packages/iterate/src/github-ai-linter/index.ts`.*
- [x] Teach `IterateWorkerEntrypoint` to dispatch project events to registered apps, so config declares the linter once and keeps no bot-specific event plumbing. *The SDK dispatches its protected `apps` list through `project-apps.ts`.*
- [x] Move the review processor, durable host, subscription bootstrap, and GitHub webhook routing from `iterate/config` into the package while preserving durable keys, subscription keys, freshness, and idempotency. *The packaged worker keeps the existing review-bot identities and routing tests.*
- [x] Load review rules from a repo glob descriptor; keep Iterate's canonical rule Markdown under root `rules/**/*.md` for both ordinary coding agents and the hosted linter. *Rule reads are pinned to the commit returned by `Repo.glob`; root agent instructions point to the same files.*
- [x] Export/build/type the package submodule and cover its public behavior with integration-style package tests. *Both public exports build and the focused package suite passes.*
- [x] Update the seeded config template and generated seed to import/register the package app; keep unrelated app routing and schedules out of scope. *The real template and generated file now contain the declaration.*
- [x] Update `iterate/config` from `main` to the same declaration and remove its local review-bot source. *The clean main checkout imports the package and deletes `apps/review-bot`.*
- [x] Run focused tests/typechecks plus config typecheck; record any production-shaped verification that cannot run locally. *Full monorepo typecheck, lint, format check, and tests pass; 29 focused OS tests and the package build pass. Preview proof awaits both PRs.*

## Approved decisions

1. `packages/iterate` owns the generic GitHub AI linter runtime; config only composes it.
2. Root `rules/**/*.md` is the one rule source. Config points the app at `/repos/iterate`; package artifacts do not duplicate the rule text.
3. The package owns dynamic-worker refs, subscription bootstrap, and event dispatch behind one declaration.
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
