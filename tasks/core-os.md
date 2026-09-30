---
status: in-progress
size: large
---

# `mkdir core && mv apps/os core`

Pre-work PR 2 for the public `iterate/os` copy. `core/` is what goes public: today apps/os and the
project templates; `packages/iterate` joins it as `core/lib` next (PR 3). The rule this PR sets up
and enforces is that **core builds from a clone of itself**: outside code may import core, core
imports nothing outside core.

Status: implemented, waiting on CI. Everything moved; the lint rule and its test are in; every
local check passes (typecheck, lint, knip, format, core/os's and test/'s suites, scripts' tests but
the macOS-only bash failures, a real build). Left: CI green, including the preview deploy.

## Layout

```text
core/
├── AGENTS.md          # the rule, in three lines
├── os/                # was apps/os (workspace package `os`, unchanged)
│   └── scripts/
│       ├── vite-build.ts        # was scripts/lib/vite-build.ts
│       └── wrangler-config.ts   # OBSERVABILITY, registrableDomainOf, from scripts/lib/wrangler-config.ts
└── configs/           # was configs/ (the project templates the Worker bakes in)
```

## Decisions

These are my calls (Misha asked for the move plus `configs/`, the two `scripts/lib` helpers and a
lint rule; the details below are guesses where he didn't say).

- **`core/os`, not `core/` as the app root.** `mkdir core && mv apps/os core` gives `core/os`, and
  `core/lib` sits beside it in PR 3, as the copybara experiment's notes planned (os/ plus lib/).
- **`configs/` → `core/configs/`, a sibling of `os/`**, not `core/os/configs/`: the templates are
  their own folders with their own `package.json` (not workspace packages), and nesting them in the
  os package would put them under its tsconfig, knip and Vite scans. The Worker's build reads them
  from `../configs`.
- **The template reference follows the files:** `github:iterate/iterate#<sha>&path:core/configs/<name>`.
  A reference made before the move names an older sha, whose tree still has `configs/`, so it keeps
  working.
- **The two helpers split by who needs them.** `vite-build.ts` moves whole (core's build is its
  main user; `scripts/lib/{deploy-app,deploy-helpers,start-app}.ts` import it from core). From
  `wrangler-config.ts`, core takes `OBSERVABILITY` and `registrableDomainOf`; `plainWorkerConfig`
  (ci-reports, dummy-petshop) stays in `scripts/lib/wrangler-config.ts` and imports
  `OBSERVABILITY` from core.
- **The lint rule** is `import-js/no-restricted-paths` on `core/**`: nothing outside `core/` may be
  imported, except `packages/iterate` until it becomes `core/lib` in PR 3. `test/` stays outside
  and keeps importing core.
- **Plain text replace for `apps/os` → `core/os`.** Both are two levels deep, so every relative
  path into or out of apps/os keeps its `../` count. Only `configs/` changes depth.
- **History is left alone:** `tasks/complete/` and the AI linter's fixtures keep their old paths.
- **Doppler:** `doppler.yaml` maps `core/os/` to the `os` project. A developer's existing
  `doppler setup` for apps/os must be re-run once (noted in the PR).

## Checklist

- [x] `git mv apps/os core/os`, `git mv configs core/configs`, the helpers into `core/os/scripts/`
      _(a move script: relative imports and markdown links recomputed, path mentions rewritten)_
- [x] every mention rewritten: code, workflows (path filters), docs, AGENTS.md files, skills,
      `doppler.yaml`, `pnpm-workspace.yaml`, knip, oxlint, `rules/` globs, loc-report groups
      _(no `apps/os` left outside `tasks/`, the AI linter's fixtures and one patch's comment)_
- [x] globs and dynamic paths that meant apps/os implicitly (`apps/**`, `apps/!(os)`, `apps/${app}`)
      _(loc-report's Product group, the platform-line target, depot-workflows.test's deploy dirs,
      three `configs` path joins)_
- [x] the lint rule, with a test that it fires _(`lint/oxlintrc-core-boundary.test.ts`)_
- [x] `build.test.ts`: the build and core's imports reach nothing outside core and `packages/iterate`
      _(the build reaches nothing outside `core/`; the per-file import scan is gone, the lint rule does
      it)_
- [x] `core/AGENTS.md`
- [ ] typecheck, lint, knip, format, apps' tests, `pnpm install` clean; CI green, including the
      preview deploy and the Browser specs

## Out of scope

- `packages/iterate` → `core/lib` and the CLI merge (PR 3).
- The copybara config (the experiment PR is not merged).
- A root `package.json`/lockfile for the public copy.

## Implementation notes

- The move script is the e2e moves' one with a new move list. Two things it got wrong, fixed by hand:
  it rewrote an import string inside a test fixture (`"./.platform/chunk-a.js"`, because the
  target's first segment starts with a dot it dropped the `./`), and it prefixed `./` to plain
  relative markdown links. A check over every renamed file (old content with only the paths
  rewritten, compared with the new) found no others.
- The dash picked a built-in template by comparing its whole path to `configs/<name>`; it now
  compares the folder's name, so a dash and a platform deployed on either side of this move agree.
- `pnpm install` re-resolved the lockfile and dropped a duplicate `@babel/generator`/`parser`
  7.29.7 for 7.29.8; nothing else changed version.
- The `@cloudflare/vitest-plugin` patch keeps its `apps/os` comment: editing a patch changes its
  hash in the lockfile, for a comment.
