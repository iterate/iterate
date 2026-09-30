---
status: done
size: small
---

# pkg-pr-new moves from packages/shared to iterate

Pre-work item 3 for moving apps/os into `core/`, third slice (after iterate/iterate#3466 and
#3470). The default-template decision unblocks it: Copybara will rewrite `@main` to
`@<40-character iterate/iterate sha>` in the copied configs/*/package.json, so the public copy's
templates name an exact pkg.pr.new build. core still needs the module at runtime: apps/os resolves
a config repo's pkg.pr.new dependencies (src/context/module-resolution.ts) and pins them
(src/project/processor.ts), and iterate/iterate's build pins `@main` (scripts/build.ts).

Status: done. apps/os's remaining packages/shared imports are the posthog proxy (goes with the ui registry work) and the test policy helpers (wait on where the e2e suite lives).

## Checklist

- [x] `packages/shared/src/pkg-pr-new.ts` (+ test) → `packages/iterate/src/pkg-pr-new.ts`, exported
      as `iterate/pkg-pr-new` (package `exports`, `publishConfig.exports`, tsdown entry); it imports
      `./platform-retry.ts` there
- [x] every importer repointed: apps/os (5), apps/agents (2), apps/docs, apps/voice, packages/ui,
      specs _13 files with imports and comments, and configs/README.md_
- [x] lint, typecheck, knip, and the tests of every touched workspace _packages/iterate (20 files), packages/shared, packages/ui, apps/agents, apps/voice, apps/os (2443 tests, its build pinning templates through pkgPrNewVersion)_

## Out of scope

- The Copybara transform itself: it goes into the Copybara config, which lives on the experiment
  branch (iterate/iterate#3434) until the copy is set up for real.

## Implementation notes
