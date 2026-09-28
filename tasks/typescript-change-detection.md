---
status: in-progress
size: medium
---

# Change detection by TypeScript: nerf a file, see what breaks

**Status:** spec only. Experiment not started.

## Ask

> change detection by typescript (maybe knip could be involved?). basically see if we can determine
> what's affected by a given filepath by nerfing the file somehow (like maybe replacing it with
> empty string or `export {}` or something) and seeing which filepaths now get typescript errors.
> you can do some local experimentation to build me up a table of the results. but in theory if we
> have enough type safety in our monorepo this could properly tell us what's affected, spanning
> backend, frontend, apps, libraries, and even tests

Worktreeify, no PR.

## Why it might work here

- Every workspace package exports `.ts` source (`"exports": { "./x": "./src/x.ts" }`), so each tsc
  program already pulls the source of every workspace package it imports. One program sees across
  package boundaries.
- `pnpm typecheck` is ~29 tsc programs (one or more per workspace, plus `specs/` and `configs/*`),
  and TypeScript is 7 (the Go port), so a full re-check is cheap enough to run many times.
- Today's CI change detection is hand-kept globs (`scripts/ci/preview-paths.ts`: `packages/shared/**`
  triggers a full preview even when only a test helper changed).

## Assumptions (made while AFK-ish; correct me)

- **Experiment, not a product.** Output is a script plus a results table in this file. Nothing
  wired into CI.
- **Programs = what `pnpm typecheck` runs.** The tsconfigs from each workspace's `typecheck`
  script, `specs/tsconfig.json` and `configs/*/tsconfig.json`. Files outside all of them are
  invisible to this method; count them.
- **"Affected" = a file that gains a new error** (diffed against a baseline run, not assumed clean).
- **Nerf strategies to compare:**
  1. `empty`: replace the file with `export {};` (the ask's suggestion).
  2. `delete`: remove the file (every import of it fails, including side-effect and type-only
     imports; `noUncheckedSideEffectImports` is on in `tsconfig.base.json`).
  3. `symbol`: nerf one export only, to see whether TS can be more precise than a file-level
     import graph.
- **Baseline to beat: TS's own import graph** from `tsc --explainFiles` (reverse edges =
  "who imports this file"). If nerfing only ever reproduces the import graph, it's a slow import
  graph; the table should show where it differs.
- **Transitive:** nerfing reports only direct dependents (an importer's broken import becomes
  `any`, which silences errors further out). Get the closure by nerfing each level's dependents in
  one batch, one tsc round per level.
- **knip:** look at whether it adds anything the tsc programs don't (entry points, files outside
  tsconfigs, non-TS dependents). Don't force it in.
- Sample ~10 files across layers: a leaf util, a widely used shared module, a contract/schema, an
  app-internal module, a React component, a test helper, a `.d.ts`, a config file.

## Checklist

- [ ] script: enumerate programs, baseline errors, file → programs map, coverage count
- [ ] script: nerf a file (`empty` / `delete`), re-check only the programs that contain it, diff
- [ ] script: import-graph direct importers + closure from `--explainFiles`, for comparison
- [ ] script: transitive closure by batched nerf rounds
- [ ] script: symbol-level nerf for a couple of files
- [ ] results table in this file: per sample file, dependents found by each method, time taken,
      apps/packages/tests reached
- [ ] note where it's blind (runtime coupling TS can't see) and whether knip helps
- [ ] verdict: is this worth building into CI, and what shape

## Implementation log
