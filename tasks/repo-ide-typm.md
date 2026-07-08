---
status: in-progress
size: large
branch: repo-ide-typm
base: repo-ide-typescript-lsp
---

# typm — like pnpm, but just for types

## Status summary

Spec committed; implementation starting. Stacked on the TypeScript language server branch (#1771), which left a deliberate seam for this work (`setFiles`/`deleteFiles` into the worker vfs).

## Ask (verbatim, from Misha — spinoff 6 of the repos mini-IDE task)

> **`typm` package — like pnpm but just for types** (follow-on to the TS language server). Looks at package.json (lockfiles not respected last time) and recursively pulls npm packages, throwing out everything but the .d.ts files, until everything needed to supply proper types to the types registry/language server is there.

## Prior art (checked)

- **v2025 branch**: `getDTS` tRPC procedure in `apps/os/backend/trpc/routers/estate.ts` ("kinda like pnpm install… only gives you the typescript definition, for usage in an in-browser mini-IDE"). Server-side node: resolves semver ranges via `registry.npmjs.org` (`semver.maxSatisfying`), streams the `.tgz` through gunzip/tar-stream keeping only `.d.ts` + `package.json`, then breadth-first recursion over each pulled package's `dependencies` with a 100-package fuse. That shape (package.json-driven, dts-pruned, dependency-recursive, first-satisfying-version-wins) is the spec here, rebuilt browser-side.
- **The REPL's TS worker** (`itx-repl-typescript.worker.ts`): no npm acquisition — it seeds baked-in generated declarations (`itx-repl-types.ts`). Nothing to reuse for acquisition itself.
- **`@typescript/ata` 0.9.8**: evaluated seriously (read the full source). See decision below.

## Design decisions (assumptions marked ⚠️)

- ⚠️ **Rebuild, don't wrap `@typescript/ata`** — but steal its CDN strategy. ata's entry point is _source code_: it scans a file's imports (`ts.preProcessFile`) and acquires those modules. Our spec is _package.json_-driven. The mismatches are structural, not cosmetic:
  1. ata resolves **transitive references at `latest`** (an explicit `// TODO: Switch from 'latest' to the version from the original tree` sits in its source) — so a repo on react 18 would get `@types/react@latest` (19) and mismatched-version type errors. Version fidelity for transitives is half the point of "like pnpm".
  2. Feeding it a synthesized `import "x" // types: 1.2.3` file per dependency works for the top level only; recursion still goes through d.ts import-scanning at `latest`.
  3. Its per-range resolution shortcut (`toDownload.split(".").length < 2` skips the resolve API) mis-treats `^1.2.3` as an exact version.
  4. No hooks for caps, batching, or caching policy beyond a raw `fetcher`.

  What it proves and we keep (with attribution comments in the source): the jsdelivr dance — `data.jsdelivr.com/v1/package/resolve/npm/<pkg>@<range>` for semver→exact resolution, `…/npm/<pkg>@<version>/flat` for the file listing (with sizes — free budget precheck), `cdn.jsdelivr.net/npm/<pkg>@<version>/<path>` for contents, the `.d.ts`-matching regex incl. `.d.mts`/`.d.cts`, and the `@types/` name mangling (`@scope/name` → `scope__name`). No tarball parsing needed in the browser.

- ⚠️ **Where it lives: `packages/typm`** — the name is the ask, and the core is genuinely package-shaped: pure `fetch`-based (works in browser, worker, or node), zero node APIs, zero react, dependency-injected fetch. Repo packages are private source-consumed workspace packages (`packages/ui` exports straight from `src/`), so the boundary costs one package.json + tsconfig, no build step. First consumer: the repo IDE's TS worker.
- **Algorithm** (browser-side v2025 `getDTS`, essentially):
  1. Parse the repo's package.json; seed queue with `dependencies` + `devDependencies` (⚠️ devDeps included — that's where `@types/*` live in real repos, incl. the project template's `@cloudflare/workers-types`).
  2. Per package: resolve range → exact version (jsdelivr resolve API; **lockfiles deliberately not respected**, per the ask).
  3. Flat-list the package; keep only `.d.ts`/`.d.mts`/`.d.cts` + `package.json`, mapped to `/node_modules/<name>/<path>`.
  4. If the tree ships no declarations: `@types/` fallback — resolve `@types/<mangled-name>@<same major>`, falling back to `latest` (⚠️ major-matching is deliberately better than ata's `latest`-always).
  5. Recurse into the pulled package.json's `dependencies` + non-optional `peerDependencies` (⚠️ peers included: `@tanstack/react-query`'s d.ts imports react, which only appears as a peer; `peerDependenciesMeta.optional` ones skipped).
  6. Cycle-safe and duplicate-safe: ⚠️ flat `/node_modules`, **one version per package name, first resolution wins** (top-level deps enqueue before transitives, so directs beat transitives — same effective behavior as the v2025 loop).
  7. Caps: ⚠️ 120 packages / 25 MB total budget, size-prechecked from flat-listing metadata; a package that would bust the budget is skipped whole (predictable) with a console warning.
- **Concurrency**: package-level fan-out with per-file fetches bounded (~8 in flight) — jsdelivr is a CDN, browsers parallelize fine; the flat listing means one metadata request per package, not N registry roundtrips.
- ⚠️ **Caching: Cache API** (`caches.open("typm-v1")`), wrapped around the injected fetch inside the worker, **only for immutable exact-versioned URLs** (flat listings + file contents). Resolve-API responses are never persisted (ranges move); an in-memory map dedupes within a session. Cache API works in workers, survives reloads, and costs ~15 lines. Failures (e.g. no `caches` in some contexts) degrade to plain fetch.
- **Integration** (the seam #1771 left):
  - The worker gains an `acquireTypes({ packageJsonText })` comlink method that runs the core and writes results straight into its own vfs (no per-file comlink chatter). It snapshots the parsed dep map and no-ops when a retrigger carries identical deps.
  - The host session triggers acquisition after seeding (it already reads package.json into `#headContents`) and re-triggers from `#reconcile` when package.json's effective content changes — debounced ~1s (package.json edits arrive per keystroke) and skipped while the JSON is unparseable mid-edit.
  - Diagnostics refresh: lints are push-cached by the linter extension, so freshly-acquired types don't repaint squigglies on their own. The session exposes an `onTypesAcquired` callback registry (plain closures — comlink proxy stays out of React-visible values per the #1771 hazard note) and the extension bundle adds a tiny plugin calling `forceLinting` when acquisition lands. Hover/completions ask the worker live and need nothing.
- **Failure = today's behavior**: every acquisition error is caught and console-logged; the `declare module "*"` wildcard keeps un-acquired imports `any`, exactly as on the base branch. The editor never blocks on acquisition.
- ⚠️ **Shims kept, not retired**: the TS2347 filter and the permissive global `JSX` namespace only matter in exactly the acquisition-failed/offline mode they were built for; with real types present they're inert (typed calls don't fire TS2347; `react-jsx` resolves JSX from `react/jsx-runtime`'s namespace before consulting the global). Removing them would make degraded mode noisy for zero benefit in the happy path.
- **Progress surfacing**: console-level (`[typm] acquiring types for N packages…` / summary with file+byte counts). No UI chrome, per the guidance.

## Checklist

- [ ] `packages/typm`: core `acquireTypes` module — resolve/list/prune/recurse over injected fetch, caps, cycle safety, `@types` fallback, progress + warning callbacks
- [ ] `packages/typm`: unit tests with a controllable fake registry fetch (no network, no vi.mock) — pruning, semver-range resolution, @types fallback incl. major matching, dependency + peer recursion, first-wins dedupe, caps, malformed package.json
- [ ] Worker: `acquireTypes` comlink method + Cache API fetch wrapper + dep-snapshot no-op + vfs writes
- [ ] Host session: post-seed trigger, debounced package.json-change retrigger, `onTypesAcquired` → `forceLinting` plumbing
- [ ] Live verification (acceptance bar): local dev repo with zod + react deps — real `z.` completions with docs, a zod type error squiggling, @types fallback proven via react JSX typing, and a cross-package case; screenshots in the PR
- [ ] `pnpm typecheck && pnpm lint && pnpm format` + the new tests green; confirm `gh pr checks` shows workflows actually ran

## Follow-ups deliberately left out

- Any UI for acquisition progress/failures beyond the console.
- Nested/workspace package.jsons (root only).
- Multiple versions of one package coexisting (needs non-flat vfs node_modules layout).
- Acquiring from private registries / auth (jsdelivr public npm only).

## Implementation log

- v2025 prior art located and read (`getDTS` in `apps/os/backend/trpc/routers/estate.ts` on `origin/v2025`); ata 0.9.8 source read in full (`src/index.ts`, `src/apis.ts`); base-branch seam files read (`repo-typescript.ts`, `repo-typescript.worker.ts`, the REPL worker trio).
