---
status: in-progress
size: large
---

# `mkdir core && mv apps/os core`

Pre-work PR 2 for the public `iterate/os` copy. `core/` is what goes public: today apps/os and the
project templates; `packages/iterate` joins it as `core/lib` next (PR 3). The rule this PR sets up
and enforces is that **core builds from a clone of itself**: outside code may import core, core
imports nothing outside core.

Status: not started.

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

- [ ] `git mv apps/os core/os`, `git mv configs core/configs`, the helpers into `core/os/scripts/`
- [ ] every mention rewritten: code, workflows (path filters), docs, AGENTS.md files, skills,
      `doppler.yaml`, `pnpm-workspace.yaml`, knip, oxlint, `rules/` globs, loc-report groups
- [ ] globs and dynamic paths that meant apps/os implicitly (`apps/**`, `apps/!(os)`, `apps/${app}`)
- [ ] the lint rule, with a test that it fires
- [ ] `build.test.ts`: the build and core's imports reach nothing outside core and `packages/iterate`
- [ ] `core/AGENTS.md`
- [ ] typecheck, lint, knip, format, apps' tests, `pnpm install` clean; CI green, including the
      preview deploy and the Browser specs

## Out of scope

- `packages/iterate` → `core/lib` and the CLI merge (PR 3).
- The copybara config (the experiment PR is not merged).
- A root `package.json`/lockfile for the public copy.

## Implementation notes
