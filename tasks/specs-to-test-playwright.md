---
status: in-progress
size: large
---

# The Playwright specs move to `test/playwright/`

PR 2 of 3 from the e2e plan, stacked on iterate/iterate#3479 (`test/` and the vitest suites). The
09/29 call agreed on one top-level `test/`, never copied to the public repo, with a folder per
runner (`playwright/`, `vitest/`) and `helpers/` beside them, and `playwright.config.ts` inside
`test/`.

Status: not started.

## Moves

| From                                             | To                                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `specs/<app>/**`, `specs/flake-sentinel.spec.ts` | `test/playwright/<app>/**`, `test/playwright/flake-sentinel.spec.ts`                     |
| `specs/test-support/**`                          | `test/helpers/**`, its own `*.spec.ts` beside the helpers they test                      |
| `specs/setup.ts`                                 | `test/playwright/global-setup.ts` (runner-specific, like Misha's note on the vitest one) |
| `playwright.config.ts`                           | `test/playwright.config.ts`                                                              |
| `specs/AGENTS.md`                                | `test/playwright/AGENTS.md`                                                              |
| `test/AGENTS.md` (the vitest suite's)            | `test/vitest/AGENTS.md`; a short new `test/AGENTS.md` says what `test/` holds            |
| `specs/tsconfig.json`                            | a tsconfig for the Playwright program in `test/`                                         |

## Checklist

- [ ] the moves, every relative import and link recomputed from its file's new place
- [ ] `test/package.json` gains `spec` and Playwright's dependencies; root `pnpm spec` runs it
- [ ] typecheck: the vitest and Playwright programs each check what they import (DOM types for
      Playwright, Workers types for vitest); root `typecheck:specs` goes; root `knip.ts` keeps a program
- [ ] CI and scripts: `scripts/os/preview.ts` runs the specs from `test/`, the shard runs, report and
      artifact paths (`test-results/`, `playwright-report/`, blob reports), `specs-shards.ts`
- [ ] lint, knip, `rules/` globs, `.gitignore` entries name the new paths
- [ ] docs, AGENTS.md files, skills and comments name the new paths
- [ ] lint, format, knip, typecheck, the specs' own helper specs locally, and CI's Browser specs
      against the preview

## Out of scope

- `packages/shared/src/test-support` → `test/helpers/` and apps/os's own `failing-test` (PR 3).
- Merging helpers the two runners duplicate (the "one way to get an itx handle"): these PRs only
  move files.

## Implementation notes
