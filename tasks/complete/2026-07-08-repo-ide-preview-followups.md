---
status: done
size: small
branch: repo-ide-preview-followups
---

# Repo IDE: preview follow-ups (SVG + Index view)

## Status summary

Implemented and verified live; PR #1773 (stacked on #1767). `.svg` files get
the same Code/Preview toggle via the existing sandboxed srcdoc iframe (an
svg with an embedded `alert`/`window.top` script rendered inert — no dialog,
top title untouched), and the readonly Index view gets the identical toggle
over the staged snapshot (header flips to `(Index Preview)`). Review pass
done (docs-only fix: two empirically false claims trimmed from the
img-vs-iframe rationale). No missing pieces.

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
  - `<img>` suppresses scripts entirely, so script-driven animation and
    interactivity (a legitimate thing to preview) never run. (Review-
    verified: sizing and SMIL animation behave the _same_ in both lanes —
    earlier claims to the contrary were wrong and have been removed.)
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

- [x] `.svg` joins `isHtmlPreviewPath`; comment updates in
      `repo-file-kinds.ts` and `html-preview.tsx` — _one-line regex change
      (`/\.(html?|svg)$/i`); the img-vs-iframe rationale lives on the
      predicate's doc comment_
- [x] Code/Preview toggle + `HtmlPreview` in the readonly Index view branch
      of `repo-editor-pane.tsx`, rendering `staged.content` — _same
      `CodePreviewToggle` in the same `leading` slot; suffix flips
      `(Index)` ↔ `(Index Preview)`; content stays the staged snapshot_
- [x] Verify live in local dev: an `.svg` with an embedded `<script>alert`
      renders inert in preview; a staged `.html` shows preview in the Index
      view; screenshots in the PR body — _Playwright walkthrough against
      `pnpm dev` + `getin`-minted session: svg with `alert("pwned")` +
      `window.top.document.title` hijack rendered animated but inert (no
      dialog, top title still "OS", `sandbox="allow-scripts"`); staged
      hello.html edit previewed in the Index view_
- [x] typecheck / lint / format / scoped tests — _all green; no tests
      exist for the repo-ide components (matching the parent PR)_

## Implementation log

- Seeding gotcha for future verifiers: `itx.repos.get("demo")` creates
  `/demo`, but the IDE lives at `/repos/demo` — pass the full
  `/repos/demo` path to `get()`.
- The Chrome-extension browser wasn't connected, so verification ran as a
  root-level Playwright script (repo's own `playwright` dep) against the
  detached dev server; sign-in via `pnpm getin --print`'s one-shot URL.
- The Source-control activity button's accessible name is the pending-change
  badge count (the `title` attr loses to text content), so scripts must
  select it by `button[title="Source control"]`.
