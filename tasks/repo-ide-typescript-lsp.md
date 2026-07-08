---
status: in-progress
size: large
branch: repo-ide-typescript-lsp
---

# Repo IDE: TypeScript language server

## Status summary

Spec committed, implementation not started yet. Plan: reuse the itx REPL's proven `@valtown/codemirror-ts` + `@typescript/vfs` web-worker setup, extended to multi-file repo buffers. No monaco.

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
- **Ongoing sync — reconcile, don't event-chase**: the host-side manager subscribes to the repo's `WorkingTreeStore` and, on every change, computes the desired vfs contents (effective entry per path, else cached HEAD content) and diffs against what it last pushed — updates via `updateFile`, removals via `deleteFile`. Creates, edits, discards, deletes, and renames all fall out of the same reconciliation. The active buffer additionally syncs through the stock `tsSyncWorker()` (the library's designed pairing with its linter/hover extensions); pushes are idempotent so the overlap is harmless.
- **Commit / HEAD moves**: the manager survives commits — on a new HEAD oid it refetches head contents, re-subscribes to the new oid's working-tree store, and reconciles. No worker churn, keeps the language service warm.
- **Lifecycle**: a module-level registry holds ONE active manager; acquiring a different repo's manager terminates the previous worker (same pattern as `workingTreeStore`'s module-level map, and satisfies "don't leak workers when navigating between repos"). React reaches it through a tanstack `useQuery` (no useEffect/useState) — editors render immediately and squigglies attach when the worker is ready.
- **Compiler options**: bundler-ish defaults matching how these repos are actually built (`moduleResolution: Bundler`, `allowImportingTsExtensions`, `strict`, `lib: es2022 + dom`, `jsx: react-jsx`, `allowJs`, `resolveJsonModule`, `noEmit`). ⚠️ Stretch: honor a whitelist of type-level options from the repo's own `tsconfig.json` (`strict`, `jsx`, `target`, `lib`, …) parsed with TS's own jsonc parser at worker init; options are read once per IDE load, not live-edited.
- **JSX without react types**: with `jsx: react-jsx` and no real react in the vfs, TS wants `JSX.IntrinsicElements`. The seed prelude declares a permissive global `JSX` namespace so `.tsx` stays quiet-but-untyped until typm brings the real react types (whose own JSX namespace then wins).
- **Empty files**: `@typescript/vfs` treats empty-string content as a missing file (`getScriptSnapshot` falsiness bug — likely the reason the REPL seeds `"\n"`). The worker normalizes every write of `""` to `"\n"`.
- **Readonly Index view**: no TS extensions on the staged-snapshot pseudo-file — it's an inspection surface; working-tree buffers are where the language server lives.

## The typm seam (for the follow-up agent)

The worker exposes `setFiles(files: Record<string, string>)` / `deleteFiles(paths: string[])` over comlink, and the vfs uses real resolution (`moduleResolution: Bundler`) with the `declare module "*"` wildcard as the _lowest-priority_ fallback. typm therefore needs no protocol changes: acquire types for the repo's `package.json` dependencies, then `setFiles({ "/node_modules/<pkg>/package.json": …, "/node_modules/<pkg>/**/*.d.ts": … })` — resolution starts finding real types and the wildcard stops matching. The host manager (`repo-typescript.ts`) is the natural place to hang the acquisition trigger (it already sees `package.json` content during seeding).

## Checklist

- [ ] Worker: `repo-typescript.worker.ts` — vfs env from CDN default lib map + seed files, `createWorker` surface, `initializeRepo` / `setFiles` / `deleteFiles` / `getAutocompletionWithDocs` comlink methods, empty-file normalization
- [ ] Worker: bundler-flavored default compiler options + permissive `JSX` global + `declare module "*"` prelude
- [ ] Host: `repo-typescript.ts` manager — seed (listFiles + capped readFile fan-out + working-tree overlay), store subscription reconciliation, HEAD-move resync, single-active-worker registry
- [ ] Host: `useRepoTypeScriptExtensions` hook (tanstack query, no useEffect) returning the per-path extension bundle (facet, sync, linter, autocomplete override with docs, hover)
- [ ] Editor integration: merge TS extensions into `RepoEditorPane`'s editable editor (plain and diff modes; not the readonly Index view)
- [ ] Reuse `getAutocompletionWithDocs` / `itxReplAutocompleteWorker` from the REPL rather than duplicating
- [ ] Stretch: honor whitelisted `tsconfig.json` compilerOptions from the repo (skip if it drags)
- [ ] `pnpm typecheck && pnpm lint && pnpm format && pnpm test` clean
- [ ] Live verification on local dev (the acceptance bar): repo with two `.ts` files where one imports the other — diagnostic squiggly, hover type info, autocomplete, cross-file import resolving (edit exported signature in file B, see the error in file A). Screenshots for the PR.

## Follow-ups deliberately left out

- **typm** (spinoff 6): type acquisition for npm deps — stacked PR on this branch; seam above.
- Diagnostics for non-open files (a Problems panel / tree annotations for type errors across the repo) — the worker can already compute them; surfacing is a product decision.
- Live tsconfig edits re-configuring the language service (options are fixed per worker init).
- Go-to-definition / find-references (needs editor UI beyond what `@valtown/codemirror-ts` ships).

## Implementation log

- Studied the REPL worker trio (`itx-repl-typescript.worker.ts`, `itx-repl-autocomplete*.ts`) and `@valtown/codemirror-ts` 2.3.1 + `@typescript/vfs` 1.6.4 internals before writing anything. Notable vfs findings baked into the design: `getScriptSnapshot` drops empty-string files; `createFile`/`updateFile` maintain the root-file list so files created after env construction participate fully; `deleteFile` is safe on missing files.
- The itx `Repo` surface has `listFiles()` + per-path `readFile()` only (no bulk snapshot on the public surface), so seeding is a capped parallel readFile fan-out.
