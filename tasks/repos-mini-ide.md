---
status: in-progress
size: large
branch: repos-mini-ide
---

# Repos view → mini IDE

## Status summary

Spec fleshed out, implementation not started yet. Main pieces: full-width IDE layout on the repo detail page (events feed demoted to a popover), Pierre file tree + editable CodeMirror editors with dirty tracking, image/PDF renderers with replace, right-click file ops, diff view, and a small base64 lane on the repo backend for binary files.

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

- [ ] Backend: base64 read lane on repo DO + `RepoRpcTarget.readFile` (`encoding` option)
- [ ] Backend: `contentBase64` variant in `RepoFileChange` accepted by `commitFiles` (validation + artifact commit implementation)
- [ ] Backend: unit tests for the binary round trip (commit base64 → readFile base64 byte-identical)
- [ ] UI: full-width layout for repo routes — panel takes the whole main pane, events feed behind a header "Events" button (popover/sheet)
- [ ] UI: pierre file tree fed from `listFiles` + staged changes, with git-status row annotations
- [ ] UI: editable CodeMirror editor with language extensions (js/ts/tsx/json/yaml/md/html/sql), dirty tracking into the staged store
- [ ] UI: image renderer (png/jpg/jpeg/gif/svg/webp/ico) + PDF renderer (iframe/object), each with a Replace button (stages a base64 change)
- [ ] UI: context menu — new file, rename, delete, upload
- [ ] UI: diff view (staged vs HEAD) via `@codemirror/merge`, per-file toggle
- [ ] UI: commit flow — message input, summary of staged changes, single `commitFiles` batch, staged state cleared and tree/queries refreshed on success
- [ ] UI: discard changes (per file + all)
- [ ] Repos index route: same full-width + events-popover treatment
- [ ] Verify in local dev against a real project repo (screenshots/video in PR)

## Implementation log

(nothing yet)
