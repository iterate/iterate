---
status: in-progress
size: small
---

# A preview's test project starts from the Default preset

Every preview deploy creates its test person's project `pr<N>` (scripts/os/preview.ts
`seedSignIn`) with `projects.create({ project })`, naming no template. Before #3492 that seeded
`configs/default`, which installs agents; since #3492 a creation naming no template gets core's
minimal config. So every preview's Agents `Sign in ↗` now lands on "Agents are not installed".

Status: spec only.

## Decisions

- **The project starts as the dash starts one when the person picks nothing:** from the preset
  whose folder is `default`, found in `projects.templates()` the way the consent page finds it
  (core/os `consent-page.server.ts`).
- **No Default preset is the seed's failure, not a silent minimal project.** Every iterate build
  bakes core/configs/default, so a missing one is a bug worth seeing; `seedSignIn` already logs a
  failure and the PR body's section says the seed failed. (My call: Misha didn't say.)
- Also: the stale second docstring above `configTemplateFolders` in scripts/os/preview-config.ts,
  left by #3496.

## Checklist

- [ ] `seedSignIn` creates `pr<N>` from the Default preset
- [ ] the stray docstring in preview-config.ts
- [ ] typecheck, lint, format; the PR's own preview: the Agents link lands on an installed app
