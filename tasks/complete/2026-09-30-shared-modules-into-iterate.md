---
status: done
size: medium
---

# integration-scopes, config-repo-template and platform-retry move from packages/shared to iterate

Pre-work item 3 for moving apps/os into `core/`, second slice (the first was iterate/iterate#3466:
`iterate/app-config`, `iterate/compatibility-date`). Core must not import packages/shared, and
nothing outside apps/os may import apps/os (packages/iterate/README.md "The SDK/platform line"), so
a module both the platform and the apps need lives in `iterate`.

Status: done. All three are `iterate` subpaths; apps/os's remaining packages/shared imports are posthog, pkg-pr-new and the test policy helpers.

## What moves

| Module                                                                                       | Lines | Used by                                                                                           | New path                       |
| -------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------- | ------------------------------ |
| `integration-scopes.ts` (+ test): `missingScopes`, what a connected account lacks            | 23    | apps/os (2), apps/dash (1)                                                                        | `iterate/integration-scopes`   |
| `config-repo-template/reference.ts` (+ test): the `github:…#<ref>&path:…` template reference | 154   | apps/os (3), apps/dash (1)                                                                        | `iterate/config-repo-template` |
| `platform-retry.ts` (+ test): the failure model and the one retry loop                       | 355   | apps/os (24), scripts (10), apps/ci-reports (1), packages/shared's depot-api.ts and pkg-pr-new.ts | `iterate/platform-retry`       |

## Checklist

- [x] ~~one commit per module~~ one commit for the three: `git mv` into packages/iterate/src, register
      the subpath (package `exports`, `publishConfig.exports`, tsdown entry), repoint every importer,
      drop the shared export _they share package.json and tsdown.config.ts, so per-module commits
      bought nothing; importers repointed: 4, 4 and 39_
- [x] apps/ci-reports depends on `iterate`; deploy-ci-reports.yml watches `packages/iterate/**`
- [x] comments and docs that name the old paths (engineering-invariants.md, platform-failures.ts,
      apps/os comments)
- [x] lint, typecheck, knip, and the tests of every touched workspace _packages/iterate (19 files, the three moved tests among them), packages/shared, apps/ci-reports, scripts (all but the macOS-bash toolchain and tracing tests), apps/os (2443 tests)_

## Assumptions (made without asking)

- `integration-scopes` gets its own subpath rather than joining `iterate/oauth-scopes`, which is the
  platform's own OAuth scopes, not a third-party provider's.
- The reference module is named for what it is, `config-repo-template`, not its old file name.
- Publishing the failure model in the SDK is acceptable: loaded code meets the same platform
  failures (Durable Object resets, lost connections).

## Out of scope

- posthog (with the ui item), pkg-pr-new (waits on the default-template decision), the test
  policy helpers (wait on where the e2e suite lives).

## Implementation notes

- packages/shared's depot-api.ts and pkg-pr-new.ts import `iterate/platform-retry` (shared already
  depends on iterate since #3466).
