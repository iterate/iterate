---
status: done
size: large
---

# The Playwright specs move to `test/playwright/`

PR 2 of 3 from the e2e plan, stacked on iterate/iterate#3479 (`test/` and the vitest suites). The
09/29 call agreed on one top-level `test/`, never copied to the public repo, with a folder per
runner (`playwright/`, `vitest/`) and `helpers/` beside them, and `playwright.config.ts` inside
`test/`.

Status: done. Browser specs green against the preview after the global setup's path fix; reviewed and approved.

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

- [x] the moves, every relative import and link recomputed from its file's new place _the PR 1 script with a new table; the harness's `skipStackFrames` paths fixed by hand_
- ~~`test/package.json` gains `spec` and Playwright's dependencies; root `pnpm spec` runs it~~ _Playwright stays a root dependency and runs from the root (`--config test/playwright.config.ts`): CI's evidence tooling reads test-results/ there. The config makes its output paths absolute from the root_
- [x] typecheck: the vitest and Playwright programs each check what they import (DOM types for
      Playwright, Workers types for vitest); root `typecheck:specs` goes; root `knip.ts` keeps a program
- [x] CI and scripts: `scripts/os/preview.ts` runs the specs from `test/`, the shard runs, report and
      artifact paths (`test-results/`, `playwright-report/`, blob reports), `specs-shards.ts`
- [x] lint, knip, `rules/` globs, `.gitignore` entries name the new paths _no `rules/` or `.gitignore` entry named specs/_
- [x] docs, AGENTS.md files, skills and comments name the new paths
- [x] lint, format, knip, typecheck, the specs' own helper specs locally, and CI's Browser specs
      against the preview _green on the second round_

## Out of scope

- `packages/shared/src/test-support` → `test/helpers/` and apps/os's own `failing-test` (PR 3).
- Merging helpers the two runners duplicate (the "one way to get an itx handle"): these PRs only
  move files.

## Implementation notes

- Playwright runs from the repository's root, as before, with only its config in `test/`.
  Playwright resolves a config's relative paths against its folder, so the config names
  `testDir`s relative to `test/`, runs the local worker (`webServer`) from the root, and writes
  its output, HTML/blob/JSON reports under the root's `test-results/`.
- Two tsconfigs in `test/`: the vitest program (Workers and Node types) and
  `playwright/tsconfig.json` (DOM and Node), each checking the helpers it imports; the vitest one
  excludes the Playwright harness's files. `test`'s `typecheck` runs both; root `typecheck:specs`
  goes. Root `knip.ts`, which only `specs/tsconfig.json` typechecked, is the lint program's now.
- `.oxlintrc.json`'s spec overrides name the Playwright harness's files in `test/helpers/`, so
  the same files get the same rules as under `specs/`.
- knip: the specs are the `test` workspace's; the root drops `@iterate-com/shared`, `capnweb` and
  `esbuild` (only the specs used them). The lint workspace names `oxlint-plugin-iterate.ts` as an
  entry: knip had reached it only through the root workspace's glob, which the move changed.
- AGENTS.md: the vitest suite's moved to `test/vitest/`, `specs/AGENTS.md` to `test/playwright/`,
  and a short `test/AGENTS.md` says what `test/` holds.
- LOC report counts all of `test/**` as tests (PR 1's helpers had counted as code).
- Left alone: `flake sentinel (specs)` and the flake suite named `specs` are labels, and the CI
  scripts' test fixtures use example paths.
- CI round 1: every Browser specs shard failed in the global setup, which found the repository as
  `new URL("..", import.meta.url)`: one folder deeper, that is `test/`. It and two specs'
  `resolve(import.meta.dirname, "../../apps/…")` reads take one more `..` (the move script
  rewrote specifiers, not bare `..` or `import.meta.dirname` joins). The E2E failures that run
  were the preview's weather (34 lost WebSockets, 24 retried rows; main's run of every row passed).
