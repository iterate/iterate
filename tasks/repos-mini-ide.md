---
status: in-progress
size: large
branch: repos-mini-ide
---

# Repos view → mini IDE

## Status summary

Implementation complete and verified live against local dev (edit → dirty annotation → diff → commit landed at HEAD; images, context menu, events sheet all exercised via playwright). Tree pinned to light theme per Misha's feedback. Remaining: review feedback, and a noted pre-existing gap around the project repo at path `/` not being addressable by the detail route.

## Ask (verbatim-ish, from Misha)

Change the `/repos` view on the OS dashboard to a mini IDE:

- Use pierre file tree (https://trees.software/docs) to render the file tree.
- Use CodeMirror to render source files, with language extensions for at least `.js`, `.ts`, `.tsx`, `.json`, `.yaml`, `.md`, `.html`, `.sql`.
- Renderers for files like images and PDFs; images and PDFs should have a "replace" button.
- The first-class view should take up the whole main panel (everything right of the sidebar on desktop). The events feed is relegated to a popover behind a button.
- CodeMirrors are _editable_. Changing a file makes it dirty — surface this via the pierre tree git status / row annotations (https://trees.software/docs#show-git-status-and-row-annotations).
- Right-click context menu to add files, delete files, rename, etc.
- The "backend" is just `itx.repos.whatever()` to commit files.
- A diff view to see what's changed in a file, similar to vscode/cursor.

## Design decisions (assumptions marked ⚠️)

- **Where**: the repo detail route `/_app/projects/$projectSlug/repos/$` becomes the IDE. ⚠️ The repos index route keeps its list/create UI but gets the same full-width + events-popover treatment so the two pages feel consistent.
- **Staging model**: edits, adds, renames, and deletes are staged in the browser (a per-repo "working tree" keyed by HEAD commit). Nothing hits the backend until you hit **Commit**, which sends one `itx.repos.get(path).commitFiles({ message, changes })` batch. This is what makes dirty markers, the diff view, and discard possible. ⚠️ No persistence of staged state across reloads in v1.
- **Dirty markers**: pierre tree `setGitStatus` drives row annotations — `modified` for edited files, `added` for new/renamed-to paths, `deleted` for deleted/renamed-from paths.
- **Diff view**: `@codemirror/merge` unified/side-by-side diff of the staged buffer vs HEAD content, toggleable per file like vscode's gutter/diff editor.
- **Events popover**: the stream feed (currently a permanent right-hand pane via `ProjectStreamView`) moves behind an "Events" button in the header. ⚠️ Implemented as a wide popover/sheet reusing the existing feed components; the browser-hosted stream processors only mount when opened.
- **Binary lane (small backend addition)**: repo content is string-only today (`readFile` → utf8 `content`, `RepoFileChange.content: string`), which corrupts binaries. The repo DO's filesystem (`@cloudflare/shell` `InMemoryFs`) already has `readFileBytes`/`writeFileBytes`, so:
  - `readFile({ path, encoding?: "utf8" | "base64" })` — base64 lane for binary reads.
  - `RepoFileChange` gains a `{ path, contentBase64 }` variant for binary writes (used by image/PDF "Replace" and file-drop upload).
  - Matches the `files.put` base64 convention established in #1755.
- **Language extensions**: `@codemirror/lang-javascript` (js/ts/tsx via config), `lang-json`, `lang-yaml` already in `packages/ui`; add `lang-markdown`, `lang-html`, `lang-sql`.
- **File tree**: `@pierre/trees@1.0.0-beta.5` (`/react` entry: `useFileTree` + `<FileTree/>`), paths from `itx.repos.get(path).listFiles()` merged with staged adds/deletes.
- **Context menu**: shadcn `ContextMenu` wrapping tree rows — New file, Rename (pierre's `renaming` flag + `onRename`), Delete, plus Upload file. All staged, not immediate commits.
- **Data loading**: tanstack query for `listFiles`/`readFile` keyed by repo path + HEAD oid; staged buffers in a small external store (no useEffect/useState sprawl per repo conventions).

## Checklist

- [x] Backend: base64 read lane on repo DO + `RepoRpcTarget.readFile` (`encoding` option) — _`#checkout` helper extracted so both read lanes share the read-your-write retry_
- [x] Backend: `contentBase64` variant in `RepoFileChange` accepted by `commitFiles` — _`writeFileBytes` in `commitFilesToArtifactRepo`; parse validation in `parseCommitFilesInput`_
- [x] Backend: tests for the binary round trip — _unit tests in `utils.test.ts`, e2e in `repo-binary.itx.e2e.test.ts`; also verified live against local dev via the CLI_
- [x] UI: full-width layout — _`ProjectStreamView layout="fullPanel"`; feed (filter row, tabs, composer, overlays) in a right Sheet behind the header Events button; `events` URL param_
- [x] UI: pierre file tree with git-status row annotations — _`repo-file-tree.tsx`; incremental `model.add/remove` sync preserves expansion_
- [x] UI: editable CodeMirror with all languages — _`SourceCodeBlock` language surface extended in packages/ui (`sourceCodeLanguageExtension`)_
- [x] UI: image + PDF renderers with Replace — _`repo-editor-pane.tsx`; PDF uses a blob URL (Chrome refuses data: URLs in iframes)_
- [x] UI: context menu — new file, rename, delete, upload — _pierre `renderContextMenu` + inline-rename; new-file uses a placeholder + `startRenaming(removeIfCanceled)`_
- [x] UI: diff view via `@codemirror/merge` — _`CodeDiffBlock` in packages/ui; right side editable, revert arrows, collapsed unchanged regions_
- [x] UI: commit flow — _uncontrolled message input + single `commitFiles` batch; invalidates the listFiles query (content queries key off HEAD oid)_
- [x] UI: discard changes — _per file (editor + context menu + changes popover) and Discard all_
- [x] Repos index route: same full-width + events-popover treatment
- [x] Verify in local dev against a real project repo — _playwright walkthrough: open, edit (dirty M annotation), diff, image, context menu, events sheet, commit landed at HEAD (`a3956d5`)_
- [x] Tree forced to light theme — _Misha: dark mode theming was broken; pinned `color-scheme: light` on the tree host (the CodeMirror pane is vsCodeLight-only too)_
- [x] Feedback: vscode-style change gutter outside the diff view — _`change-gutter.ts` over `presentableDiff`; bar is a child element so active-line gutter themes can't hide it_
- [x] Feedback: Files/Source-control activity strip with dirty-count badge — _commit box + changes list moved into the SCM panel (vscode shape); top toolbar removed; `scm` URL param_
- [x] Feedback: full-height tree hitbox — _root New file/Upload context menu on the empty area; cancels itself (base-ui `eventDetails.cancel`) when the composedPath shows a pierre row_
- [x] Feedback: inline diff as the default, always-available Diff toggle — _`unifiedMergeView` layered on the same editable editor; zero changes = plain view, so discard doesn't snap; side-by-side `CodeDiffBlock` deleted_
- [x] Feedback: discard uses an undo arrow, not a bin
- [x] Feedback: working tree persists to localStorage — _keyed by repo + HEAD oid so a moved HEAD orphans stale state (swept on load) instead of producing weird diffs; quota errors degrade to memory-only_
- [x] Feedback: staging area — _working + staged slots per path (`staged-changes.ts`); `+`/`−` on SCM rows/headers/editor; file in both sections after post-stage edits; Commit = staged-only when anything is staged; post-commit migration of surviving working edits to the new oid's store (verified across reload)_
- [x] Feedback: block-level staging — _inline diff baselines on the staged snapshot; its `+` chunk control IS accept-chunk, whose updated original doc writes back as the staged snapshot; `⨯` discards the block_
- [x] Feedback: SCM row hover no longer changes row height — _action buttons reserve space (invisible→visible) and fit the row (size-5)_
- [x] Feedback: staged rows open a readonly HEAD↔staged diff — _`staged=true` URL param; no chunk controls, editor rejects input, Diff button disabled (no non-diff version exists), Unstage returns to the editable view_

## Spinoffs (from Misha, more or less verbatim — each is its own future task)

1. **Markdown previewer.** Just use marked or one of the other libraries for a prettified view of the text. Shown when clicking a tabbed button in the top left like vscode's "Preview | Markdown" buttons. _Straightforward — the FileChrome header already has an actions slot for the toggle. I'd reach for `marked` + `DOMPurify` (repo content is user-supplied, so sanitize before `dangerouslySetInnerHTML`) or `react-markdown` which skips raw-HTML injection entirely._
2. **HTML renderer.** Similar. Initially just renders html and assumes inline styling. _A sandboxed `<iframe srcdoc>` (no `allow-same-origin`) rather than injecting into the page — free style isolation and script containment in one move._
3. **Git history.** Show commits similar to the "Git Graph" vscode extension — a list, and an individual commit expanded by clicking (commit metadata + changed files with +/- counts; clicking those filepaths opens a readonly diff view). _The itx surface has no history read today — needs a backend lane like `repo.log({ limit, branch })` (git log over the DO's `#checkout`, easy) and per-commit file stats (diff two trees). `getFilesSnapshot({ commitOid })` already exists for pinned reads, so the readonly diff view is HEAD-vs-commit content through the existing `CodeDiffBlock`. Graph edges are simple while repos are effectively single-branch._
4. **JSON and YAML json-schema support.** Support the `"$schema"` top-level prop, apply it to get red squigglies. Have certain well-known schemas like tsconfig.json and package.json. _codemirror-json-schema exists and pairs with `@codemirror/lint`; well-known filename → schemastore.org URL mapping covers package.json/tsconfig.json without any `$schema` prop. Needs an egress decision: fetch schemas client-side from schemastore or vendor the top handful._
5. **TypeScript language server.** Run the typescript compiler somehow or other. Given we need a language _server_ this could be tricky — maybe monaco has it built in? Some clever person has likely got this working with codemirror though. Worst case open to using monaco just for typescript. (tswasm allows TS compilation in the browser but wouldn't help for language-server things like autocomplete.) _The repl already does this in this codebase: `@valtown/codemirror-ts` + a TS environment in a web worker (`itx-repl-typescript.worker.ts`, `itx-repl-autocomplete.ts`). Extending that setup to multi-file repo buffers is the natural path — no monaco needed, and the worker/vfs plumbing is already written and proven._
6. **`typm` package — like pnpm but just for types** (follow-on to 5). Looks at package.json (lockfiles not respected last time) and recursively pulls npm packages, throwing out everything but the .d.ts files, until everything needed to supply proper types to the types registry/language server is there. _Prior art in the v2025 branch. The repl's TS worker already fetches type acquisition for the generated sdk; typm would generalize that to arbitrary package.json deps. Worth checking `@typescript/ata` (typescript-playground's automatic type acquisition) before rebuilding — it does exactly this dance over unpkg/jsdelivr._

## Implementation log

- Backend lane + regenerated `itx-api.generated.ts` / `types-source.generated.ts` / template `sdk.ts` snapshot (the template test compares them verbatim).
- The oxlint `codegen/codegen` fix didn't regenerate `project-repo-template.generated.ts`; ran the codegen preset manually via node.
- Verified live on local dev (project `ide-demo`, repo `/repos/demo`): binary PNG commit + base64 read round-trip via CLI; full IDE walkthrough via playwright (screenshots in the PR).
- Known gap (pre-existing on main): the project repo lives at path `/` but the detail route maps splats to `/repos/*`, so the `/` repo's detail page shows a nonexistent `/repos/` stream. Left alone here — needs a routing decision (sentinel splat or a dedicated route).
- Staged changes live in a module-level per-repo store; they survive client-side navigation but not reloads (v1).
