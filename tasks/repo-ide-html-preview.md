---
status: in-progress
size: small
branch: repo-ide-html-preview
---

# Repo IDE: HTML preview

## Status summary

Implemented and verified live; awaiting review on PR #1767. Code/Preview
toggle on `.html`/`.htm` files renders the current buffer in a sandboxed
iframe (`allow-scripts` only, opaque origin — verified in-frame:
`origin: null`, `document.cookie` throws SecurityError). No known missing
pieces; follow-up ideas listed at the bottom.

## Ask (verbatim, spinoff #2 from the repos mini-IDE task)

> **HTML renderer.** Similar [to the markdown previewer — a toggle like
>
> > vscode's "Preview | Markdown" buttons in the top left]. Initially just
> > renders html and assumes inline styling.

## Design decisions (assumptions marked ⚠️)

- **Where**: the repo IDE editor pane (`repo-editor-pane.tsx`). `.html`/`.htm`
  files get a compact Code/Preview segmented toggle at the left of the file
  header, vscode-style. Other text files are untouched. ⚠️ `.svg` opens as
  html-highlighted text today but does NOT get the toggle — it's an image
  format, and previewing repo SVGs is a different (image-renderer) feature.
- **What renders**: the CURRENT buffer — live working edit, else staged
  snapshot, else HEAD — exactly what the editor shows. No fetch, no save
  required.
- **How**: `<iframe srcdoc>` with `sandbox="allow-scripts"` and NO
  `allow-same-origin`, so the document runs in an opaque origin: no cookies,
  no localStorage, no same-origin reads against the OS app. Style isolation is
  free (nothing leaks in or out).
  - ⚠️ Stance on `allow-scripts`: allowed. Repo HTML is user-supplied but the
    viewer is the same user who can already run this file anywhere; an opaque
    origin means a script can't touch the app's session, DOM, or storage.
    Interactive previews (a canvas demo, a little form playground) are half
    the point of an HTML renderer. NOT allowed: `allow-same-origin`,
    `allow-top-navigation`, `allow-popups`, `allow-forms`, `allow-modals` —
    default-deny everything else.
  - `referrerPolicy="no-referrer"` so subresource requests don't leak the
    dashboard URL.
  - srcdoc (not a blob URL): the Chrome data:-URL restriction that forced the
    PDF renderer onto blob URLs is specific to the PDF viewer; srcdoc is the
    simplest live-buffer channel and keeps no object-URL lifecycle.
- **View state**: a `preview` boolean URL search param on the repo detail
  route, same shape as `diff`/`scm`/`staged`. Preview and diff are mutually
  exclusive — turning one on turns the other off. Selecting a different file
  resets preview, like diff.
- **White canvas**: the iframe gets a white background — standalone HTML
  assumes a browser-default white page, and the surrounding app may be dark.
- **Out of scope**: the readonly Index (staged) pseudo-file view keeps no
  preview toggle; markdown preview is a parallel task on its own branch.

## Checklist

- [x] `preview` search param on the repo detail route + `useRepoIdeSearch` —
      _`RepoDetailSearch` in the `$` route + `useRepoIdeSearch`/`patchSearch`
      in `repo-ide.tsx`; diff and preview clear each other, file selection
      clears both_
- [x] `HtmlPreview` sandboxed-iframe component + html-path predicate —
      _`html-preview.tsx` (component + sandbox rationale);
      `isHtmlPreviewPath` lives in `repo-file-kinds.ts` beside the other
      path→kind logic (also keeps the component file fast-refresh-clean)_
- [x] Code/Preview toggle in the file header for html files —
      _`CodePreviewToggle` in `repo-editor-pane.tsx`, rendered through a new
      `leading` slot on `FileChrome`; header shows a "(Preview)" suffix like
      "(Index)"/"(Working Tree)"_
- [x] Preview renders the live working buffer (unsaved edits included) —
      _preview shows the same `value` the editor edits (working → staged →
      HEAD precedence)_
- [x] Verify live in local dev: create an html file with inline styles and a
      script tag, toggle preview, confirm sandboxing stance, screenshot —
      _seeded `/repos/demo` with `hello.html` via the itx CLI; headless
      Chrome walkthrough: toggle, live unsaved edit re-render, in-frame
      script printed `origin: null` + cookie SecurityError, Diff↔Preview
      exclusion; screenshots in the PR body_
- [x] typecheck / lint / format / scoped tests — _all green; lint forced the
      predicate move noted above_

## Implementation log

- View state follows the existing URL-param pattern (`diff`/`scm`/`staged`);
  no new state store, no useState.
- The toggle renders only for `.html`/`.htm`; a stale `preview=true` param on
  a non-html file is simply ignored by the pane.
- Follow-up ideas (out of scope): markdown preview lands the same toggle
  shape (parallel task); a preview for the readonly Index/staged view;
  auto-refresh preview while typing is moot today because preview replaces
  the editor — a side-by-side split would change that.
