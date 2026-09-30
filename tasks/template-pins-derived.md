---
status: ready
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

Status: not started.

## Checklist

- [ ] `build.ts` pins each `@iterate-com/*` dependency whose version is a pkg.pr.new `@main` URL,
      and nothing else
- [ ] the commit lookup (`checkoutPublishedPackageCommit`) runs only when a template needs it
- [ ] `apps/os/docs/integrations.md` names `iterate/integration-scopes` (moved in #3470)
- [ ] lint, typecheck, and apps/os's tests (templates.test.ts covers the `@main` case)

## Out of scope

- The Copybara transform that pins the copy's templates: it lives in the Copybara config on the
  experiment branch until the copy is set up for real.

## Implementation notes
