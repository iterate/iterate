# Fast dependency fingerprint tests

Status: implementation complete; normal CI and final repository checks pending. All 23 replacement tests pass with only Node and Git on PATH, and all 401 scripts tests pass.

User ask: worktreeify the follow-up to #2696 and #2714. Remove real-pnpm tests, whose repeated installs slowed CI and exceeded Vitest's default timeout.

Scope: keep `scripts/depot-ci/dependencies.mjs` unchanged. Exercise its `fingerprint` command and lifecycle rejection through `seal`, using small temporary Git workspaces with no installed dependencies. Drop tests of pnpm's own install behavior and remove the 30-second timeout. Do not replace pnpm with a fake executable or fabricate installed package metadata.

- [x] Replace install-based input checks with fingerprint comparisons, including source-only changes, dependency/config inputs, local binary files and environment changes. *`dependencies.test.ts` compares the existing CLI's fingerprints; also covers workspace config and pnpm hooks.*
- [x] Keep coverage that sealing rejects each unsupported root/workspace lifecycle hook, without executing the hook or package manager. *All 13 root/workspace cases call only `seal` and assert rejection.*
- [x] Remove real installs and the timeout override; measure the replacement suite and run repository checks. *23 tests pass in 3.2–3.5s locally, including with pnpm absent from PATH; full scripts suite has 401 passing tests. Remaining checks tracked below.*
- [ ] Push the implementation, confirm normal CI and review feedback, and update the draft PR with evidence.

## Implementation log

- 2026-09-17: created `ci-deps-fast-tests` from `origin/main` (`8b317a84a6`). The current 23-test file took 35.8 seconds in main's Test job; each fixture installs dependencies, and most tests install again. The replacement will test only the code this repository owns.
- Replaced install assertions with fingerprint comparisons and lifecycle rejection; removed pnpm's frozen-lockfile failure/package-link repair checks. Runtime, image recipe and workflows are unchanged.
- Local setup, format, typecheck and knip pass. The first full repository test run hit an unrelated five-second timeout in `packages/shared/src/test-support/e2e-policy/retry-telemetry-collection-errors.test.ts`; checking it separately before the final full run. No timeouts increased or tests skipped.
