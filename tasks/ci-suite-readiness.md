---
status: in-progress
size: small
---

# Prepare the environment before timing OS test suites

Status: implementation complete; focused tests, typechecks and lint pass.
Fresh-preview validation is in progress before the final push. Work lives on
`codex/ci-suite-readiness`. Push the branch and return a GitHub compare link;
do not open a pull request.

Playwright currently waits for deployment propagation inside project/sign-in
fixtures, so individual test durations include shared deployment setup.
Vitest waits outside the runner. Auth configuration is also loaded lazily in
Playwright workers. Move these shared prerequisites out of individual tests.

- [x] Give Playwright and Vitest one external readiness boundary: the existing
      deployment-age delay and successful agent smoke. Start both suites
      concurrently after readiness; keep Chromium installation concurrent
      with setup and keep readiness visible in CI output.
      *Implemented in `scripts/preview/preview.ts`; readiness failure blocks both suites.*
- [x] Load and validate Playwright auth configuration before workers start,
      for both CI and local `pnpm spec`. Pass prepared settings through the
      environment; keep test identities, tokens and projects isolated.
      *`specs/setup.ts` prepares auth before workers; fixture readers are synchronous.*
- [x] Remove Playwright's deployment sleeps and associated timeout extensions.
      *Removed from project and email-signup helpers, including unused TestInfo plumbing.*
- [x] Cover readiness ordering, setup failure, concurrent suite execution and
      auth setup with behavior tests; update affected documentation.
      *Actual preview shell is exercised with controlled commands; real Playwright workers prove auth inheritance. 193 preview tests pass.*
- [ ] Run focused tests, type/lint/format checks and available runtime proof;
      record any validation limitations explicitly.
- [ ] Commit and push the completed branch; return the compare link only,
      without creating a PR.

## Scope decisions

- Keep the 90-second deployment-age rule. Replacing it with a better readiness
  signal is separate work.
- Preserve Vitest's existing agent-smoke prerequisite and apply it to
  Playwright as well. Readiness failures must prevent both suites from starting.
- No test-selection changes, concurrency increases, timeout increases, or
  changes to resource cleanup.
- The normal preview workflow requires a PR. Do not create one merely for
  validation, or borrow another PR's preview lease.

## Implementation log

- 2026-09-14: created worktree from `origin/main` at `3a5ea998e1`.
