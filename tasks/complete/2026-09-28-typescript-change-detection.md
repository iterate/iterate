---
status: done
size: medium
---

# Change detection by TypeScript: nerf a file, see what breaks

**Status:** experiment done; nothing wired into CI.

- **Works:** 1002 of 1010 TS files sit in a tsc program with a clean baseline, so a new error is
  always signal. Whole-file nerfing (the ask) reproduces the import graph, plus ambient/global type
  coupling the graph can't see. Renaming one declaration or member instead gives per-test answers,
  often 3–20× narrower than the file's importers.
- **Main result:** a 2-file Domain Connect fix: CI's globs run everything; the import graph says
  223 files; member-level nerfing says 7 files and 38 tests.
- **Gaps:** non-TS files (4 of 10 real commits were invisible), runtime-string dispatch, deployed
  suites reached over HTTP, `@ts-nocheck`. Rounds are slow (fresh tsc per round). See
  [Verdict](#verdict).

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

- [x] script: enumerate programs, baseline errors, file → programs map, coverage count _`loadRepo` in scripts/ts-affected/engine.ts; `cli.ts programs`_
- [x] script: nerf a file (`empty` / `delete`), re-check only the programs that contain it, diff _`checkWithEdits`/`fileDependents`_
- [x] script: import-graph direct importers + closure from `--explainFiles`, for comparison _`graphImporters`/`graphClosure`_
- [x] script: transitive closure by batched nerf rounds _`fileClosure`, one tsc round per level_
- [x] script: symbol-level nerf for a couple of files _all 11 samples with exports, at declaration and member level (scripts/ts-affected/symbols.ts)_
- [x] results table in this file: per sample file, dependents found by each method, time taken,
      apps/packages/tests reached _Results §1–2, plus §3: 10 real commits replayed (`cli.ts replay`)_
- [x] note where it's blind (runtime coupling TS can't see) and whether knip helps _"What TypeScript can't see", "knip"_
- [x] verdict: is this worth building into CI, and what shape _"Verdict"_

## Results

Machine: 16-core Mac, TypeScript 7.0.2 (tsgo). Times are wall-clock with two experiments sharing
the machine, so read them as upper bounds.

### Setup

- `pnpm typecheck` is **29 tsc programs**. One `--explainFiles` pass over all of them (8 at a time)
  takes **~12 s** and gives the file → programs map, the import graph, and the baseline errors
  (**0**) at once. It is the typecheck CI already runs, plus one flag.
- **1002 of 1010** tracked `.ts`/`.tsx` files are in at least one program. The repo is almost fully
  visible.
- One nerf round costs one re-check of the programs that read the edited files: **~0.5 s** for
  `specs/` alone, **~10–13 s** once `apps/os` is involved. Each round only re-runs the programs that
  read a file edited _that round_ (the others' errors are last round's).

### 1. Whole-file nerf vs the import graph

| sample                                    | kind                    | direct: graph / `export {}` / delete | closure: graph / `export {}` / delete | only nerf / only graph | test files | reaches                                                                                                  | time (delete): direct / closure |
| ----------------------------------------- | ----------------------- | ------------------------------------ | ------------------------------------- | ---------------------- | ---------- | -------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `packages/shared/src/slugify.ts`          | leaf util               | 1 / 1 / 1                            | 21 / 21 / 21                          | 0 / 0                  | 21         | —                                                                                                        | 0.5s / 2s (3 rounds)            |
| `packages/shared/src/platform-retry.ts`   | shared runtime util     | 29 / 29 / 29                         | 369 / 362 / 362                       | 2 / 9                  | 192        | admin, agents, ci-reports, dash, dummy-petshop, kit, notes, os, spa, voice · pkg shared                  | 5.6s / 18s (7 rounds)           |
| `packages/shared/src/app-config.ts`       | cross-app config        | 3 / 4 / 4                            | 283 / 289 / 289                       | 20 / 14                | 147        | admin, agents, dash, kit, notes, os, voice · pkg shared, ui                                              | 4.6s / 22s (6 rounds)           |
| `packages/iterate/src/lib.ts`             | SDK core                | 103 / 103 / 103                      | 490 / 480 / 480                       | 4 / 14                 | 223        | admin, agents, dash, kit, notes, os, voice · pkg agents, ai-linter, cli, github-sync, iterate, ui, voice | 6.3s / 16s (5 rounds)           |
| `apps/os/src/caller.ts`                   | app-internal hub        | 31 / 36 / 36                         | 272 / 271 / 271                       | 1 / 2                  | 159        | agents, os                                                                                               | 5.8s / 12s (4 rounds)           |
| `apps/os/src/secret/contract.ts`          | oRPC contract           | 13 / 14 / 14                         | 246 / 245 / 245                       | 1 / 2                  | 145        | agents, os                                                                                               | 3.6s / 12s (5 rounds)           |
| `packages/ui/src/components/button.tsx`   | shared React component  | 50 / 50 / 50                         | 93 / 87 / 87                          | 2 / 8                  | 2          | admin, agents, dash, kit, notes, os, voice · pkg ui                                                      | 5.9s / 17s (3 rounds)           |
| `apps/dash/src/components/identifier.tsx` | app React component     | 8 / 8 / 8                            | 10 / 11 / 11                          | 3 / 2                  | 0          | dash                                                                                                     | 0.6s / 2s (2 rounds)            |
| `apps/os/e2e/support/client.ts`           | e2e test helper         | 72 / 72 / 72                         | 73 / 73 / 73                          | 0 / 0                  | 63         | agents, os                                                                                               | 3.2s / 11s (2 rounds)           |
| `specs/test-support/auth-config.ts`       | browser-spec helper     | 8 / 8 / 8                            | 23 / 23 / 23                          | 0 / 0                  | 23         | —                                                                                                        | 0.2s / 1s (3 rounds)            |
| `scripts/lib/env-context.ts`              | deploy/CI lib           | 21 / 22 / 22                         | 87 / 87 / 87                          | 0 / 0                  | 31         | admin, agents, ci-reports, dash, dummy-petshop, kit, notes, os, spa, voice                               | 4.8s / 12s (3 rounds)           |
| `apps/os/src/dom.d.ts`                    | ambient globals (.d.ts) | 0 / 4 / 4                            | 0 / 12 / 12                           | 12 / 0                 | 0          | os                                                                                                       | 3.5s / 13s (3 rounds)           |
| `packages/voice/src/markdown.d.ts`        | ambient module (.d.ts)  | 1 / 1 / 1                            | 8 / 2 / 6                             | 0 / 2                  | 1          | agents, voice · pkg voice                                                                                | 3.4s / 14s (4 rounds)           |

"only nerf / only graph" compares the `delete` closure against the graph closure.

- **File-level nerfing is roughly the import graph.** In all 13 samples it finds every direct
  importer the graph lists (plus, in 5, a few more through ambient types); closures are within a
  few percent. `export {}` and delete find the same files (they differ only for a `.d.ts`).
- **It finds coupling the graph can't:** `apps/os/src/dom.d.ts` has no importers, but blanking it
  breaks 12 files that use its DOM globals. `app-config.ts` reaches 20 TanStack route files through
  the router's `declare module … interface Register` augmentation, and `platform-retry.ts` reaches
  `apps/os/__workers-tests__/apply-migrations.ts` through `declare global { namespace Cloudflare {
interface Env … } }`. No import path exists for any of these.
- **It misses what the graph walks through:** every `routeTree.gen.ts` is `// @ts-nocheck`, so a
  broken route never errors there and the chain stops before `router.tsx`. The `.d.ts` files are
  silent too (`skipLibCheck`).
- Errors reach past direct importers through inferred types: a broken import types its binding
  `any`, and noImplicitAny fires downstream (`TS7006: Parameter 'route' implicitly has an 'any'
type`). That's why nerf levels don't line up with graph levels.

Verdict on the ask as posed: it works, but whole-file nerfing mostly costs ~10–30 s to get what the
graph gives in one pass. The graph plus nerfing only ambient `.d.ts` files would cover both.

### 2. One export vs its whole file

Same samples, nerfing one export by **renaming** it (so only code that references it breaks), then
renaming whatever broke, round by round. Errors map to the enclosing top-level declaration, or to a
`test(...)` call, which gives per-test results. **Member-level** goes one step finer: an error
inside a class, interface or object literal takes only that method or property.

| export                                             | whole file (graph): files / test files | declaration-level: files / test files / tests / time | member-level: files / test files / tests / time | member-level reaches                                                       |
| -------------------------------------------------- | -------------------------------------- | ---------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| `slugify` (leaf util)                              | 21 / 21                                | 21 / 21 / 41 / 2s                                    | 21 / 21 / 41 / 1s                               | —                                                                          |
| `CLOUDFLARE_API` (shared runtime util)             | 369 / 191                              | 25 / 3 / 11 / 38s                                    | 25 / 3 / 11 / 54s                               | admin, agents, ci-reports, dash, dummy-petshop, kit, notes, os, spa, voice |
| `dnsName` (cross-app config)                       | 283 / 146                              | 210 / 90 / 609 / 66s                                 | 199 / 88 / 543 / 187s                           | admin, agents, dash, kit, notes, os, voice · pkg shared, ui                |
| `cookieValueOf` (SDK core)                         | 490 / 223                              | 76 / 51 / 310 / 69s                                  | 41 / 17 / 75 / 155s                             | admin, agents, dash, kit, notes, os, voice · pkg iterate, ui               |
| `bytesFromBase64url` (app-internal hub)            | 272 / 159                              | 158 / 87 / 590 / 68s                                 | 141 / 84 / 521 / 289s                           | os                                                                         |
| `LendRevokedReason` (oRPC contract)                | 246 / 145                              | 166 / 89 / 594 / 70s                                 | 149 / 86 / 525 / 260s                           | os                                                                         |
| `buttonVariants` (shared React component)          | 93 / 2                                 | 79 / 1 / 4 / 41s                                     | 79 / 1 / 4 / 94s                                | admin, agents, dash, kit, notes, os, voice · pkg ui                        |
| `Identifier` (app React component)                 | 10 / 0                                 | 11 / 0 / 0 / 4s                                      | 11 / 0 / 0 / 10s                                | dash                                                                       |
| `mcpCall` (e2e test helper)                        | 73 / 63                                | 3 / 3 / 4 / 8s                                       | 3 / 3 / 4 / 16s                                 | —                                                                          |
| `readOsPlaywrightAuthConfig` (browser-spec helper) | 23 / 23                                | 22 / 22 / 39 / 1s                                    | 22 / 22 / 39 / 3s                               | —                                                                          |
| `cloudflareApi` (deploy/CI lib)                    | 87 / 31                                | 21 / 2 / 8 / 26s                                     | 21 / 2 / 8 / 53s                                | admin, agents, ci-reports, dash, dummy-petshop, kit, notes, os, spa, voice |

- **Big wins where nothing hub-like is in the way:** `CLOUDFLARE_API` reaches 25 files instead of
  its file's 369; `cookieValueOf` 41 instead of 490 (75 tests instead of 223 test files); `mcpCall`
  3 instead of 73.
- **What's left is mostly real.** `bytesFromBase64url`, `LendRevokedReason` and `dnsName` still
  reach ~140–200 files at member level, through `IterateContextDurableObject`'s `#builtIns` and
  `#itxExpressionResolver`: the path every context request takes. Most `apps/os` tests exercising
  that is a fair answer. (`CLOUDFLARE_API` and `cloudflareApi` "reach" every app only through its
  `scripts/` deploy code.)
- **Hubs eat the precision at declaration level.** A one-line change inside one method of
  `ProjectDurableObject` nerfs the whole class, and the class is named in the `Env` bindings
  interface that everything in `apps/os` uses. Member-level cuts that case (#3368 below:
  `domainConnectLinkOf` → `ProjectDurableObject.#hostnames` → `.processor`) from **155 files / 586
  tests to 7 files / 38 tests**.
- **Member-level trades soundness for it.** At declaration level that same change reached
  `IterateContextDurableObject` through `FIRST_PARTY_FACET_PUBLIC_METHODS`, a registry the host
  indexes by facet name at runtime. Member-level only nerfs the registry's `.project` entry, so the
  path goes quiet. Registries indexed by computed keys need to stay at declaration level.
- Playwright's extended `test` is a hub of its own: `slugify` → `screenshot` → the `test` fixture →
  every spec. The fixture _properties_ are typed, so renaming the one fixture would reach only the
  specs that destructure it, but that's a member of a call's argument, which this doesn't do yet.

### 3. Real commits from today's main

Each commit checked out in a lab worktree, seeded from its diff's changed lines, beside what
`scripts/ci/preview-paths.ts` decides today.

| commit                                                                                                            | changed (TS can't see) | globs: preview? | import graph: files / test files | declaration-level: files / test files / tests | member-level: files / test files / tests / time | member-level reaches (non-test code)                                                            |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------- | -------------------------------- | --------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [#3371](https://github.com/iterate/iterate/pull/3371) The splice test's fake socket reads a binary frame's first… | 1 (0)                  | yes             | 1 / 1                            | 1 / 1 / 14                                    | 1 / 1 / 14 / 20s                                | —                                                                                               |
| [#3368](https://github.com/iterate/iterate/pull/3368) Domain Connect's provider requests use redirect "manual": … | 2 (0)                  | yes             | 223 / 137                        | 155 / 85 / 586                                | 7 / 3 / 38 / 66s                                | os                                                                                              |
| [#3355](https://github.com/iterate/iterate/pull/3355) The AI linter's no-repeated-explanations rule reads the co… | 2 (2)                  | no              | 0 / 0                            | 0 / 0 / 0                                     | 0 / 0 / 0 / 0s                                  | —                                                                                               |
| [#3364](https://github.com/iterate/iterate/pull/3364) connect-a-service.md teaches an agent to find out what a s… | 1 (1)                  | yes             | 0 / 0                            | 0 / 0 / 0                                     | 0 / 0 / 0 / 0s                                  | —                                                                                               |
| [#3369](https://github.com/iterate/iterate/pull/3369) An agent's secret collection link opens a page of its own:… | 18 (2)                 | yes             | 430 / 199                        | 290 / 127 / 713                               | 164 / 83 / 521 / 224s                           | dash, kit, os, voice · pkg iterate, ui, voice                                                   |
| [#3354](https://github.com/iterate/iterate/pull/3354) A pkg.pr.new dependency loads only at a commit: the loader… | 24 (10)                | yes             | 242 / 141                        | 165 / 89 / 611                                | 148 / 86 / 542 / 261s                           | agents, kit, os, voice · pkg shared                                                             |
| [#3379](https://github.com/iterate/iterate/pull/3379) Every deployment's Artifacts namespace is <resourceNamePre… | 14 (2)                 | yes             | 89 / 30                          | 41 / 12 / 86                                  | 40 / 11 / 49 / 77s                              | admin, agents, dash, kit, notes, os, voice                                                      |
| [#3366](https://github.com/iterate/iterate/pull/3366) iterate/sdk exports only the hosts, processor authors impo… | 74 (12)                | yes             | 498 / 223                        | 374 / 171 / 1138                              | 287 / 142 / 998 / 152s                          | admin, agents, dash, kit, notes, os, voice · pkg agents, ai-linter, github-sync, iterate, voice |
| [#3365](https://github.com/iterate/iterate/pull/3365) Every Kit board keeps its speaker volume across a reboot: … | 15 (15)                | no              | 0 / 0                            | 0 / 0 / 0                                     | 0 / 0 / 0 / 0s                                  | —                                                                                               |
| [#3375](https://github.com/iterate/iterate/pull/3375) The static SPA and the Chrome extension register a public … | 6 (6)                  | no              | 0 / 0                            | 0 / 0 / 0                                     | 0 / 0 / 0 / 0s                                  | —                                                                                               |

- **Test-only change** ([#3371](https://github.com/iterate/iterate/pull/3371)): the globs deploy a
  preview and run both deployed suites. TypeScript: 14 tests in the one changed file, no app code.
- **Small backend fix** ([#3368](https://github.com/iterate/iterate/pull/3368)): the globs say
  everything; the graph says 223 files; member-level says 7 files and 38 tests, all `apps/os`. The
  preview is still needed (app code changed), but TypeScript can name the tests to run first.
- **TypeScript sees nothing in 4 of 10:** AI-linter rules
  ([#3355](https://github.com/iterate/iterate/pull/3355)), a guide the platform serves
  ([#3364](https://github.com/iterate/iterate/pull/3364)), Kit firmware C
  ([#3365](https://github.com/iterate/iterate/pull/3365)), the SPA's plain-JS `public/`
  ([#3375](https://github.com/iterate/iterate/pull/3375)). Two of those ship to users, so non-TS
  paths still need globs.
- **Broad changes stay broad** (#3369, #3354, #3366): member-level trims 40–60% of the graph's
  files but still reaches most apps, which is right for a shared UI or SDK change.
- **Time:** declaration-level 14–95 s per commit, member-level 20 s–4.5 min, plus ~12 s to load.
  Every round is a fresh tsc process re-parsing the program; an in-memory checker (tsgo's API or
  LSP, one edit per round) should take a round from ~10 s to ~1 s.

## What TypeScript can't see

Found while running the experiment, or known from this repo's shape:

- **`// @ts-nocheck` files are opaque.** Every TanStack `routeTree.gen.ts` has it, so a broken
  route file never errors there and the chain stops before `router.tsx` (the app's entry). The
  import graph walks through it. Fix: follow graph edges through `@ts-nocheck` files.
- **`.d.ts` files never report** (`skipLibCheck: true` covers the repo's own too), e.g.
  `apps/os/__workers-tests__/env.d.ts`, `apps/os/src/generated/platform-modules.d.ts`. Their
  _users_ still break through type flow, which is often enough.
- **Deployed-app tests.** `apps/os/e2e/**` and `specs/**` talk to a deployment over HTTP; they
  import helpers, not the app. A change to `apps/os/src/x.ts` reaches them only if you add the edge
  "any non-test file of app W affected → W's deployed suites affected" (the folder names already
  say which app a suite targets: `specs/dash`, `specs/os`, `apps/os/e2e`).
- **Files outside TypeScript:** Markdown the platform serves or reads (`apps/os/public/*.md`,
  `rules/**/*.md` for the AI linter), JSON under `public/`, `wrangler*.jsonc`, `.depot/workflows`,
  CSS, `package.json`/lockfile bumps, Kit firmware C. `?raw`/`*.md` imports resolve to an ambient
  `declare module "*.md"`, so even an imported `.md` has no edge.
- **Runtime strings:** Durable Object class names in wrangler config, env var names, module
  specifiers resolved at runtime (config repos, `apps/os/src/context/module-resolution.ts`).
- **Dynamic member access:** `ns[key]`, `Object.values(ns)` on a namespace import. A renamed
  export errors only at static references.

Dependency bumps are closer than they look: `--explainFiles` also lists `node_modules` files and
who imports them, so "zod changed → importers of zod" is one lookup (this experiment filters
`node_modules` out; it'd be a small addition).

## knip

knip's graph is the same import graph `tsc --explainFiles` gives, so it adds nothing to the
file-level result. `knip --trace-file packages/iterate/src/lib.ts --trace-export cookieValueOf`
returns the same 5 direct importers the symbol engine's round 1 finds, in 7s, but stops there: it
can't say which of `app-server.ts`'s own exports use `cookieValueOf`, which is the step renaming
provides. Where it could help: its plugins know every workspace's entry points (vitest configs,
wrangler `main`, playwright), which is the map from "affected files" to "which runner/deploy runs
them". Not needed for the experiment.

## Verdict

- **The ask, as posed** (blank a file, collect errors): works, but it's the import graph at 10–30 s
  a file. `tsc --explainFiles` gives the graph for the whole repo in the typecheck CI already runs.
  Nerfing earns its keep only for ambient `.d.ts` files and global augmentations.
- **The version worth having** renames declarations (or members) instead. It follows actual
  references, so it answers "which tests" rather than "which files". No import graph can do that,
  and knip's export tracing stops after one hop.
- **It's not sound on its own.** Keep globs for non-TS paths, and keep main running everything
  as the backstop.

If we build it, I'd do:

1. Declaration-level for functions, member-level for classes and interfaces only (object literals
   are often registries indexed at runtime).
2. A deployment edge: if non-test code of app W is affected, deploy W's preview and run its deployed
   suites; if none is, skip the preview. #3371 above would skip it.
3. Run affected Vitest files first (or only), everything else after or on main.
4. Keep `preview-paths.ts`'s globs for what TypeScript can't see.
5. Move rounds in-process (tsgo API/LSP) before this goes anywhere near CI's critical path.

## How to run

```sh
node scripts/ts-affected/cli.ts programs
node scripts/ts-affected/cli.ts file packages/shared/src/slugify.ts
node scripts/ts-affected/cli.ts symbol packages/iterate/src/lib.ts cookieValueOf --granularity member
node scripts/ts-affected/cli.ts diff --base HEAD^ --granularity member
node scripts/ts-affected/cli.ts replay 4d2e7a976 --lab ../lab --granularity member
node scripts/ts-affected/cli.ts experiment && node scripts/ts-affected/cli.ts symbol-samples --granularity member && node scripts/ts-affected/cli.ts table
```

Run it in a checkout you aren't editing: it rewrites files while tsc runs (and restores them, also
on ctrl-c). A stray error you introduce mid-run shows up as a dependent.

## Implementation log

- `scripts/ts-affected/engine.ts`: programs come from each workspace's `typecheck` script. One
  `--explainFiles` pass per program gives file → programs, the import graph and baseline errors.
  `checkWithEdits` writes edits, re-checks the given programs 8 at a time, restores in `finally`
  and on exit.
- `--incremental` didn't help: nerfing changes export signatures, so tsgo re-checked most of
  `apps/os` anyway (9.3 s vs 9.3 s).
- Bug hit: deleting every file a program includes gives a file-less `TS18003`, which read as a
  dependent at the repo root (EISDIR). File-less errors are skipped.
- Each round re-checks only the programs that read a file whose edits changed that round. That
  cut `specs/`-only rounds to ~0.4 s and most rounds to one or two programs.
- `symbols.ts`: items are bindings, import bindings, export specifiers, the default export,
  members, and terminal statements (`test(...)` calls keyed by the call, labelled by title). Each
  found item records the nerfed item its error quotes, or "type flow" when the error came through
  an inferred `any` (noImplicitAny downstream).
- Member-level was added after #3368's closure turned out to be the `ProjectDurableObject` →
  `Env` hub; `--granularity` keeps both.
- Samples and commits ran in two spare worktrees (`ts-change-detection-lab`, `-lab2`) so edits here
  couldn't show up as dependents. Raw results: `scripts/ts-affected/results-*.ignoreme.json`.
