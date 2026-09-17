# Fast dependency fingerprint tests

Status: specified; implementation and validation pending. Replace the dependency tests' real pnpm installs with checks of the fingerprint and lifecycle policy.

User ask: worktreeify the follow-up to #2696 and #2714. Remove real-pnpm tests, whose repeated installs slowed CI and exceeded Vitest's default timeout.

Scope: keep `scripts/depot-ci/dependencies.mjs` unchanged. Exercise its `fingerprint` command and lifecycle rejection through `seal`, using small temporary Git workspaces with no installed dependencies. Drop tests of pnpm's own install behavior and remove the 30-second timeout. Do not replace pnpm with a fake executable or fabricate installed package metadata.

- [ ] Replace install-based input checks with fingerprint comparisons, including source-only changes, dependency/config inputs, local binary files and environment changes.
- [ ] Keep coverage that sealing rejects each unsupported root/workspace lifecycle hook, without executing the hook or package manager.
- [ ] Remove real installs and the timeout override; measure the replacement suite and run repository checks.
- [ ] Push the implementation, confirm normal CI and review feedback, and update the draft PR with evidence.

## Implementation log

- 2026-09-17: created `ci-deps-fast-tests` from `origin/main` (`8b317a84a6`). The current 23-test file took 35.8 seconds in main's Test job; each fixture installs dependencies, and most tests install again. The replacement will test only the code this repository owns.
