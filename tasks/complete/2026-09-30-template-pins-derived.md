---
status: done
size: small
---

# The build pins only templates' `@main` packages, found from the manifest

Pre-work for moving apps/os into `core/`, from the Copybara experiment (iterate/iterate#3434,
which never merges). `apps/os/scripts/build.ts` embeds the config templates with their
`@iterate-com/*` packages pinned to this checkout's pkg.pr.new build. Today it:

- names the packages by hand (`["@iterate-com/agents", "@iterate-com/voice"]`), so a template
  that adds another `@iterate-com/*` package at `@main` ships that moving `@main`
- pins those two whatever version the template names, so a copy made by Copybara, whose
  templates already name the copied commit's build, has them overwritten with a lookup of the
  copy's own commits, which pkg.pr.new never built
- looks up the commit even when no template needs it (in a shallow clone, that fetches history)

Status: done. The build pins what it pinned before for today's templates, and leaves a sha-pinned template alone.

## Checklist

- [x] `build.ts` pins each `@iterate-com/*` dependency whose version is a pkg.pr.new `@main` URL,
      and nothing else _the `ours` filter over `manifest.dependencies`, as on the experiment branch_
- [x] the commit lookup (`checkoutPublishedPackageCommit`) runs only when a template needs it _`packagesCommit ||=` inside the filter_
- [x] `apps/os/docs/integrations.md` names `iterate/integration-scopes` (moved in #3470) _line 147_
- [x] lint, typecheck, and apps/os's tests (templates.test.ts covers the `@main` case) _oxlint, oxfmt, apps/os tsc (app and scripts), templates/build/published-package-commit tests (20)_

## Out of scope

- The Copybara transform that pins the copy's templates: it lives in the Copybara config on the
  experiment branch until the copy is set up for real.

## Implementation notes

- Checked the copy case by hand: with both templates' agents and voice set to
  `@435de99…` (what the Copybara transform writes), `node scripts/build.ts` embeds them unchanged.
  With `@main`, it embeds main's build (`5292d07…`, the merge base), as before.
