---
status: in-progress
size: small
branch: repo-ide-markdown-preview
---

# Repo IDE: markdown previewer

Spinoff #1 from [repos mini IDE](complete/2026-07-08-repos-mini-ide.md).

## Status summary

Implemented and verified live: Code | Preview toggle on `.md` files in the
repo IDE, previewing the live working-tree buffer through streamdown
(sanitized). Playwright spec covers the toggle, sanitization, and
unsaved-buffer rendering. Remaining: nothing known; PR review.

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

- [x] `preview` search param in `RepoDetailSearch` + `useRepoIdeSearch` — _same
      shape as `diff`; toggling preview on clears `diff`; selecting a file
      clears `preview`_
- [x] Code/Preview segmented toggle in FileChrome's top-left for `.md` files —
      _new `leading` slot on FileChrome + `CodePreviewToggle` (design-system
      Tabs) in `repo-editor-pane.tsx`; Diff button hidden while previewing_
- [x] Preview pane rendering the current buffer via `MessageResponse`
      (streamdown), scrollable and prose-styled — _`MarkdownPreview` renders
      the same `value` the editor edits (working → staged → HEAD precedence)_
- [x] `@source` streamdown dist in packages/ui globals.css so its built-in
      component classes exist — _also fixes heading/list/table styling for
      agent-feed chat markdown, which silently relied on class overlap_
- [x] Verify live in local dev (edit an .md, toggle preview, screenshot) —
      _playwright walkthrough on `test` project's `/repos/demo`: code view,
      preview of HEAD README, unsaved-edit preview with GFM table + code
      block; screenshots in the PR_
- [x] typecheck / lint / format / scoped tests green — _apps/os + packages/ui
      typecheck, oxlint, oxfmt, apps/os vitest (578 passed), new spec passes_
- [x] Playwright spec — _`specs/repo-markdown-preview.spec.ts`: seeds a repo
      with hostile markdown (`<script>`, `onerror`), asserts prose renders,
      scripts don't run, and the preview shows the unsaved buffer_

## Implementation log

- Renderer decision: `marked`+DOMPurify and `react-markdown` both rejected in
  favor of streamdown, which was already in packages/ui (agent feed chat).
  Streamdown pipes raw HTML through rehype-raw → rehype-sanitize →
  rehype-harden by default (confirmed in its dist), so no
  `dangerouslySetInnerHTML` anywhere and no new dependency.
- Streamdown's built-in components carry Tailwind classes that were never
  scanned (`@source` only covered our own src) — headings/lists/tables in chat
  markdown only looked right where classes happened to overlap with app code.
  Added `@source "../../node_modules/streamdown/dist/*.js"` per streamdown's
  install docs; verified the preview's h1/table/code styling live.
- First screenshot attempt typed markdown with `keyboard.type`, which fights
  CodeMirror's list auto-continuation; `keyboard.insertText` is the way to
  seed buffer text in specs/scripts.
- Local dev workerd crashed once with `kj::Exception ... wrappable.wrapper !=
nullptr` (pre-existing flake, not this change); `pnpm dev restart --detach`
  recovered it.
- Review round 1 (agent review on the PR): fixed a real mutual-exclusivity
  hole — the SCM panel's `onOpen`/`onOpenStaged` (and `onToggleDiff`) did not
  clear `preview`, so clicking a modified file from Source Control while
  previewing showed the preview instead of the diff. All three handlers now
  clear it; spec extended with the SCM→file-click path (selector gotcha: the
  activity-strip button's accessible name is its badge count, so
  `getByTitle("Source control")`). Also sharpened the MarkdownPreview security
  comment (rehype-sanitize's default schema is the real guard — streamdown's
  harden config is wide open; the invariant is "no `rehypePlugins` prop"), and
  verified agent-feed chat markdown live after the `@source` change (assistant
  message with headings/list/table/code seeded via
  `events.iterate.com/agents/web-message-sent`; screenshot in the PR).
