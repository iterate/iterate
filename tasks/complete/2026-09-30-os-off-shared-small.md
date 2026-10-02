---
status: done
size: medium
---

# apps/os stops importing four small pieces of packages/shared

Pre-work item 3 for moving apps/os into `core/` (the packages/shared question), first slice. Core
builds from a clone of itself, so what apps/os needs has to be in core.

Status: done. Two helpers are deleted outright; the two modules the platform shares with the apps
move into the `iterate` package.

## Checklist

- [x] `dev/is-main-module` deleted _every user swept: a guard around `createCli({ ...import.meta })`
      goes (trpc-cli checks the entry point itself); any other guard is `import.meta.main`; the nine
      hand-rolled `process.argv[1]?.endsWith(...)` checks went the same way except the two that run
      on the stock image's Node before setup (preview-paths.ts, preview-tested-commit.ts)_
- [x] `test-support/temporary-directory` deleted _Node 24.4's `fs.mkdtempDisposableSync` returns
      the same `{ path, [Symbol.dispose] }` shape; 37 files switched; packages/cli lost its only
      use of @iterate-com/shared_
- [x] `app-config` (the APP_CONFIG mechanism) moves to `iterate/app-config`, with its test
- [x] `compatibility-date` moves to `iterate/compatibility-date`
- [x] docs: typescript-conventions.md and depot-ci.md describe the new entry-point idiom
- [x] housekeeping: iterate/iterate#3456's task file moves to tasks/complete/

## Decisions

- **Why `iterate`, not apps/os.** Nothing outside apps/os may import apps/os
  (`import-js/no-restricted-paths`, packages/iterate/README.md "The SDK/platform line"), and the
  first-party apps use the platform through `iterate/*`. app-config and the compatibility date are
  needed by the platform and by the apps on top (start-app-config.ts, the deploy scripts), so the
  one home both sides may import that is inside core is `iterate`. A first attempt that moved them
  into apps/os was refused by that lint rule.
- **Node versions.** `import.meta.main` needs Node 24.2 and `mkdtempDisposableSync` 24.4. CI runs
  .nvmrc's Node 24 (24.19.0 on 2026-09-30): after the setup action, `toolchain.sh node` (Kit
  Firmware) or `setup-node` (merges-with-main). Only preview-paths.ts and preview-tested-commit.ts
  run before any of those, so they keep comparing `process.argv[1]`.

## Implementation notes

- packages/shared and apps/spa now depend on `iterate` (workspace); deploy-spa.yml redeploys when
  packages/iterate changes (depot-workflows.test.ts requires it).
- Checked: every changed CLI prints its usage when run and nothing when imported; importing
  apps/os/scripts/build.ts leaves src/generated untouched. Tests: packages/iterate, packages/shared,
  packages/cli, apps/kit, apps/agents, scripts (all but the macOS-bash toolchain and tracing tests,
  which fail on main too), apps/os (139 files).
