---
status: in-review
size: large
branch: repo-ide-typescript-lsp
pr: https://github.com/iterate/iterate/pull/1771
---

# Repo IDE: TypeScript language server

## Status summary

Implemented and live-verified end to end (diagnostics, hover, autocomplete, cross-file propagation, repo-tsconfig honoring — screenshots in the PR). Main pieces: a per-repo web worker hosting a `@typescript/vfs` environment, a host session that seeds it from HEAD + the working tree and keeps it synced by reconciliation, and the `@valtown/codemirror-ts` extension bundle attached in `RepoEditorPane`. Nothing known missing within scope; npm type acquisition is the stacked `typm` follow-up.

## Ask (verbatim, from Misha — spinoff 5 of the repos mini-IDE task)

> **TypeScript language server.** Run the typescript compiler somehow or other. Given we need a language _server_ this could be tricky — maybe monaco has it built in? Some clever person has likely got this working with codemirror though. Worst case open to using monaco just for typescript.

The mini-IDE task file already answered the "how": the REPL in this codebase does exactly this — `@valtown/codemirror-ts` extensions talking over comlink to a web worker that hosts a `@typescript/vfs` virtual TypeScript environment (`itx-repl-typescript.worker.ts`, `itx-repl-autocomplete.ts`). This task extends that single-file setup to the repo IDE's multi-file working tree.

## Scope (v1)

- Diagnostics (red squigglies), hover type info, and autocomplete for `.ts` / `.tsx` / `.js` / `.jsx` (and `.mts`/`.cts`/`.mjs`/`.cjs`) buffers in the repo IDE editor.
- Multi-file awareness: the worker's virtual fs is seeded with the repo's TypeScript-relevant files (sources + `.json` for `resolveJsonModule`), overlaid with the in-browser working tree, so relative imports between repo files resolve and an edit in one buffer is visible from another.
- ⚠️ **Type acquisition for external npm imports is OUT OF SCOPE.** That's the `typm` follow-up (spinoff 6, a stacked PR on this branch). Until then, bare-specifier imports are typed `any` via a `declare module "*"` ambient wildcard — the same trick the REPL uses. TS only consults ambient wildcards for _non-relative_ specifiers and real resolved files always win, so typm dropping `.d.ts` files into `/node_modules/...` in the same vfs later Just Works with no seam changes. See "The typm seam" below.

## Design decisions (assumptions marked ⚠️)

- **Worker, not monaco**: one web worker per repo (`repo-typescript.worker.ts` alongside the other repo-ide modules), built with `createWorker` from `@valtown/codemirror-ts/worker` exactly like the REPL, plus repo-specific comlink methods for seeding and multi-file sync.
- **Extensions attach from the IDE side (apps/os), not packages/ui**: the TS extensions need repo context — a per-repo worker, itx reads for seeding, the working-tree store subscription. `SourceCodeBlock` stays a dumb editor that accepts `codeMirrorExtensions`; the repo IDE passes the TS bundle in, the same split the REPL already uses.
- **Seeding**: at worker init the host lists HEAD files, reads every TypeScript-relevant path (⚠️ capped at 500 files — project repos are small; a bigger repo gets the first 500 sorted paths and a console warning), applies the working-tree overlay (write entries override HEAD, deletes drop), and ships the map to the worker. Repo path `src/x.ts` maps to vfs path `/src/x.ts`.
- **Ongoing sync — reconcile, don't event-chase**: the host-side session subscribes to the repo's `WorkingTreeStore` and, on every change, computes the desired vfs contents (effective working/staged entry per path, else cached HEAD content) and diffs against what it last pushed — updates via `updateFile`, removals via `deleteFile`. Creates, edits, discards, deletes, and renames all fall out of the same diff, and it doubles as the per-keystroke buffer sync (the editor writes every change into the store), so the stock `tsSyncWorker` extension is deliberately unused — one sync path instead of two racing ones.
- **Commit / HEAD moves**: the session survives commits — on a new HEAD oid it refetches head contents, re-subscribes to the new oid's working-tree store, and reconciles. No worker churn, keeps the language service warm.
- **Lifecycle**: a module-level registry holds ONE active session; acquiring a different repo's session terminates the previous worker (same pattern as `workingTreeStore`, and satisfies "don't leak workers when navigating between repos"). React reaches it through a tanstack `useQuery` (no useEffect/useState) — editors render immediately and squigglies attach when the worker is ready. `gcTime: 0` so a cached query can never hand a later visit a terminated session.
- **Compiler options**: bundler-ish defaults matching how these repos are actually built (`moduleResolution: Bundler`, `allowImportingTsExtensions`, `strict`, `lib: es2022 + dom + dom.iterable`, `jsx: react-jsx`, `allowJs`, `resolveJsonModule`, `noEmit`), overridable by a whitelist of type-level options from the repo's own `tsconfig.json` (see checklist — the stretch landed).
- **JSX without react types**: with `jsx: react-jsx` and no real react in the vfs, TS wants `JSX.IntrinsicElements`. The seed prelude declares a permissive global `JSX` namespace so `.tsx` stays quiet-but-untyped until typm brings the real react types (whose own JSX namespace then wins).
- **Empty files**: `@typescript/vfs` treats empty-string content as a missing file (`getScriptSnapshot` falsiness bug — likely the reason the REPL seeds `"\n"`). The worker normalizes every write of `""` to `"\n"`.
- **Readonly Index view**: no TS extensions on the staged-snapshot pseudo-file — it's an inspection surface; working-tree buffers are where the language server lives.
- **TS2347 filtered**: "Untyped function calls may not accept type arguments" is guaranteed noise while every npm import is `any` (e.g. the template's `kv.get<number>(…)`); typm's real types silence it naturally, at which point the filter can go.

## The typm seam (for the follow-up agent)

The worker exposes `setFiles(files: Record<string, string>)` / `deleteFiles(paths: string[])` over comlink, and the vfs uses real resolution (`moduleResolution: Bundler`) with the `declare module "*"` wildcard as the _lowest-priority_ fallback. typm therefore needs no protocol changes: acquire types for the repo's `package.json` dependencies, then `setFiles({ "/node_modules/<pkg>/package.json": …, "/node_modules/<pkg>/**/*.d.ts": … })` — resolution starts finding real types and the wildcard stops matching. The host session (`repo-typescript.ts`) is the natural place to hang the acquisition trigger (it already sees `package.json` content during seeding). Two related cleanups typm unlocks: drop the TS2347 diagnostic filter and the permissive global `JSX` namespace (real react types supersede both).

⚠️ One hazard the follow-up MUST respect: never let the comlink proxy become reachable from React-visible values (props/state/query data). React 19's dev-mode component performance logging stringifies changed props, and `String(comlinkProxy)` throws, aborting the entire React commit — this presented as the editor silently unmounting. `workerFacade` in `repo-typescript.ts` exists for exactly this; extend the facade rather than handing out the proxy.

## Checklist

- [x] Worker: `repo-typescript.worker.ts` — vfs env from CDN default lib map + seed files, `createWorker` surface, `initializeRepo` / `setFiles` / `deleteFiles` / `getAutocompletionWithDocs` comlink methods, empty-file normalization — _also `ensurePathExists` so lint/hover on a just-created path can't throw before the sync lands_
- [x] Worker: bundler-flavored default compiler options + permissive `JSX` global + `declare module "*"` prelude — _`lib` must use full filenames (`lib.dom.iterable.d.ts`); dotted short names parse as filenames and env creation throws TS6054_
- [x] Host: `repo-typescript.ts` session — seed (listFiles + capped readFile fan-out + working-tree overlay), store subscription reconciliation, HEAD-move resync, single-active-worker registry — _`RepoTypeScriptSession#ensureSynced` serialized on a promise chain; `#pushed` map is the diff baseline_
- [x] Host: `useRepoTypeScriptExtensions` hook (tanstack query, no useEffect) returning the per-path extension bundle (facet, linter, autocomplete override with docs, hover) — _plus a `.cm-tooltip` z-index theme; `gcTime: 0` per the lifecycle note; failures logged to console (editor works without the service by design)_
- [x] Editor integration: merge TS extensions into `RepoEditorPane`'s editable editor (plain and diff modes; not the readonly Index view) — _also on never-committed files, which previously short-circuited to no extensions_
- [x] Reuse `getAutocompletionWithDocs` / `itxReplAutocompleteWorker` from the REPL rather than duplicating — _imported from `../itx-repl-autocomplete-worker.ts` / `../itx-repl-autocomplete.ts`_
- [x] Stretch: honor whitelisted `tsconfig.json` compilerOptions from the repo — _`repoCompilerOptions` in the worker, `ts.parseConfigFileTextToJson` + `convertCompilerOptionsFromJson`, whitelist of type-level options; verified live: the demo repo's `noUnusedLocals: true` produced "'wrong' is declared but its value is never read"_
- [x] `pnpm typecheck && pnpm lint && pnpm format && pnpm test` clean — _apps/os lane: 76 files / 584 tests passed post-merge; repo-ide has no unit suite (same as the mini-IDE PR — verified live instead)_
- [x] Live verification on local dev (the acceptance bar) — _playwright-style walkthrough on project `test`, repo `/repos/demo` (`src/greet.ts` + `src/main.ts`): squiggly + tooltip on a type error, hover showing `(alias) greet(name: string): Greeting`, autocomplete listing `message`/`loud` from the imported interface, and a signature edit in greet.ts producing TS2554 in the untouched main.ts buffer. Screenshots in the PR._
- [x] Merge origin/main (post-#1763/#1765) — _clean merge, no conflicts; IDE re-verified live on the merged head_

## Follow-ups deliberately left out

- **typm** (spinoff 6): type acquisition for npm deps — stacked PR on this branch; seam above.
- Diagnostics for non-open files (a Problems panel / tree annotations for type errors across the repo) — the worker can already compute them; surfacing is a product decision.
- Live tsconfig edits re-configuring the language service (options are fixed per worker init; a reload picks up changes).
- Go-to-definition / find-references (needs editor UI beyond what `@valtown/codemirror-ts` ships).
- The dev server's first hit on the worker route pays a one-time vite bundling cost for the `typescript` package (~tens of seconds cold, then cached). Fine for dev; production serves a prebuilt chunk.

## Implementation log

- Studied the REPL worker trio (`itx-repl-typescript.worker.ts`, `itx-repl-autocomplete*.ts`) and `@valtown/codemirror-ts` 2.3.1 + `@typescript/vfs` 1.6.4 internals before writing anything. Notable vfs findings baked into the design: `getScriptSnapshot` drops empty-string files; `createFile`/`updateFile` maintain the root-file list so files created after env construction participate fully; `deleteFile` is safe on missing files.
- The itx `Repo` surface has `listFiles()` + per-path `readFile()` only (no bulk snapshot on the public surface), so seeding is a capped parallel readFile fan-out.
- Live verification flushed out three genuinely nasty integration bugs, each invisible without driving the real app (commit 41692c54d):
  1. **TS6054 on dotted lib short names** — `lib: ["dom.iterable"]` parses as a file named `/dom.iterable`; env creation throws. Full lib filenames fix it.
  2. **React 19 dev perf-logging vs comlink proxies** — `logComponentRender` stringifies changed props; `String(comlinkProxy)` throws "Cannot convert object to primitive value", aborting the commit and unmounting the editor with no stack pointing anywhere useful. Fixed with a plain delegating facade (`workerFacade`).
  3. **vite mid-session dep re-optimization** — the IDE's lazy `import("@codemirror/view")` was a never-before-discovered dep; re-optimization split `@codemirror/state` into two instances, so `state.facet(tsFacetWorker)` read a foreign facet's default (`undefined.getLints` errors). Fixed by pre-bundling the lazy codemirror family in `optimizeDeps.include` — which also hardens the REPL's identical lazy-import pattern.
- Dropped `tsSyncWorker` deliberately: every editor change already lands in the `WorkingTreeStore` synchronously, so the store-subscription reconcile IS the buffer sync; two push paths would race and double-post every keystroke.
- Merged origin/main (#1763 GitHub panel, #1765 root-repo hack et al.) cleanly; no conflicts, re-verified live and re-ran the gates on the merged head.
