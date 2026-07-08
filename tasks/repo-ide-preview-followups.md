---
status: in-progress
size: small
branch: repo-ide-preview-followups
---

# Repo IDE: preview follow-ups (SVG + Index view)

## Status summary

Spec committed; implementation starting. Two follow-ups the HTML preview PR
(#1767) deliberately left out: the Code/Preview toggle for `.svg` files, and
the same toggle on the readonly Index (staged) pseudo-file view. Stacked on
`repo-ide-html-preview`.

## Ask

Follow-up work identified in `tasks/repo-ide-html-preview.md` / PR #1767:

1. **SVG preview.** `.svg` currently opens as html-highlighted text with no
   toggle. Give it the same Code/Preview toggle.
2. **Preview in the readonly Index view.** The staged pseudo-file view
   (`staged=true`, header `path (Index)`) has no preview toggle for
   html/svg. Add it, rendering the staged snapshot readonly.

## Design decisions (assumptions marked ⚠️)

- **SVG renders through the same sandboxed `<iframe srcdoc>` lane as html.**
  Raw `.svg` file content is valid in an HTML body — the parser switches to
  foreign-content mode at `<svg>`, and an XML prolog/DOCTYPE degrade to
  ignored bogus comments — so `HtmlPreview` needs no changes. Why not an
  `<img>` with a blob URL (which also neuters scripts)?
  - `<img>` changes sizing/behavior: percentage-sized or height-less SVGs
    collapse to the 300×150 replaced-element default, and animations driven
    by scripts (a legitimate thing to preview) never run.
  - User-supplied SVG can embed `<script>`; the iframe's existing stance —
    `sandbox="allow-scripts"` with NO `allow-same-origin`, so an opaque
    origin — makes that inert against the dashboard while still letting
    animated/interactive SVGs actually work, same rationale as html.
  - One lane, one sandbox stance to reason about, zero new code.
  - ⚠️ Trade-off accepted: the preview shows the svg as a document on a
    white canvas with default 8px body margin, not pixel-identical to
    opening the raw `.svg` URL. It's a preview, and white beats the app's
    dark background for typical light-first icons; the binary image lane's
    checkerboard stays an image-lane thing.
- **Predicate**: `isHtmlPreviewPath` grows `.svg` and keeps its name — it
  answers "does this path render through the html preview lane", and svg
  does. Keeping the name also keeps the diff minimal for the parallel
  markdown-preview branch touching the same header area.
- **Index view toggle**: identical `CodePreviewToggle` in the same `leading`
  slot, over the staged snapshot (`staged.content`) — content stays
  readonly, nothing editable sneaks in. The `preview` URL param is already
  wired through `RepoEditorPane`; opening an Index file resets it like any
  file selection.
- ⚠️ **Header suffix in Index preview**: `(Index Preview)` — keeps the
  pseudo-file identity visible while matching the working view's
  `(Preview)` suffix behavior.
- **Out of scope**: markdown preview (parallel branch); previewing HEAD
  content inside the Index view (the Index view is only reachable for
  staged snapshots); any svg-specific chrome like checkerboard/zoom.

## Checklist

- [ ] `.svg` joins `isHtmlPreviewPath`; comment updates in
      `repo-file-kinds.ts` and `html-preview.tsx`
- [ ] Code/Preview toggle + `HtmlPreview` in the readonly Index view branch
      of `repo-editor-pane.tsx`, rendering `staged.content`
- [ ] Verify live in local dev: an `.svg` with an embedded `<script>alert`
      renders inert in preview; a staged `.html` shows preview in the Index
      view; screenshots in the PR body
- [ ] typecheck / lint / format / scoped tests

## Implementation log

(append as work happens)
