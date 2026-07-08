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

## Implementation log

- Backend lane + regenerated `itx-api.generated.ts` / `types-source.generated.ts` / template `sdk.ts` snapshot (the template test compares them verbatim).
- The oxlint `codegen/codegen` fix didn't regenerate `project-repo-template.generated.ts`; ran the codegen preset manually via node.
- Verified live on local dev (project `ide-demo`, repo `/repos/demo`): binary PNG commit + base64 read round-trip via CLI; full IDE walkthrough via playwright (screenshots in the PR).
- Known gap (pre-existing on main): the project repo lives at path `/` but the detail route maps splats to `/repos/*`, so the `/` repo's detail page shows a nonexistent `/repos/` stream. Left alone here — needs a routing decision (sentinel splat or a dedicated route).
- Staged changes live in a module-level per-repo store; they survive client-side navigation but not reloads (v1).
