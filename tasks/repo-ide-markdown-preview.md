---
status: in-progress
size: small
branch: repo-ide-markdown-preview
---

# Repo IDE: markdown previewer

Spinoff #1 from [repos mini IDE](complete/2026-07-08-repos-mini-ide.md).

## Status summary

Spec committed, implementation not started yet.

## Ask (verbatim, from Misha)

> **Markdown previewer.** Just use marked or one of the other libraries for a
> prettified view of the text. Shown when clicking a tabbed button in the top
> left like vscode's "Preview | Markdown" buttons.

## Design decisions (assumptions marked ⚠️)

- **Renderer: streamdown, not marked/DOMPurify/react-markdown.** `packages/ui`
  already depends on `streamdown` (Vercel's react-markdown wrapper) and wraps
  it as `MessageResponse` in `ai-elements/message.tsx` — the agent feed renders
  chat markdown through it today. Streamdown pipes raw HTML through
  `rehype-raw` → `rehype-sanitize` → `rehype-harden` by default, so
  user-supplied repo content is sanitized without a new dependency or any
  `dangerouslySetInnerHTML`. GFM tables/strikethrough and shiki code
  highlighting come free.
- **Toggle placement**: a vscode-style "Code | Preview" segmented control in
  the top-LEFT of the file header (FileChrome), before the file path — per the
  ask ("tabbed button in the top left"). Only rendered for markdown files.
- **Preview shows the working-tree buffer** (live edit → staged snapshot →
  HEAD, same precedence as the editor), so unsaved edits preview correctly.
- **URL state**: `preview` boolean search param, validated in
  `RepoDetailSearch` alongside `file`/`diff`/`scm`/`staged`, patched via the
  existing `useRepoIdeSearch` helper. ⚠️ Cleared when switching files (same
  behavior as `diff`).
- ⚠️ **Preview and diff are mutually exclusive**: opening the preview clears
  `diff`; the Diff button is hidden while previewing (the preview pane replaces
  the editor entirely, so a diff toggle would be dead weight). Stage/Discard
  stay available in the header.
- ⚠️ **Not offered in the readonly Index (staged) view** — that view exists to
  inspect a diff, and preview would hide the thing it's for. The editable
  working-tree view is one click away.
- **Styling**: add streamdown's dist to the Tailwind `@source` list in
  `packages/ui/src/styles/globals.css` (its built-in components carry Tailwind
  classes that are otherwise never generated). This also fixes heading/list/
  table styling for agent-feed chat markdown. Preview content sits in a
  scrollable, centered `max-w-3xl` column.

## Checklist

- [ ] `preview` search param in `RepoDetailSearch` + `useRepoIdeSearch`
- [ ] Code/Preview segmented toggle in FileChrome's top-left for `.md` files
- [ ] Preview pane rendering the current buffer via `MessageResponse`
      (streamdown), scrollable and prose-styled
- [ ] `@source` streamdown dist in packages/ui globals.css so its built-in
      component classes exist
- [ ] Verify live in local dev (edit an .md, toggle preview, screenshot)
- [ ] typecheck / lint / format / scoped tests green

## Implementation log

(nothing yet)
