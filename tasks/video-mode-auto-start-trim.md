---
status: in-progress
size: small
---

# Video mode: auto-trim the blank startup lead-in

## Executive summary (for humans skimming)

`VIDEO_MODE=1 pnpm spec <file>` records lovely demo videos, but they **start
with a few seconds of blank screen**. The blank frames are the startup: the raw
webm begins at browser-context creation, and nothing meaningful is on screen
until the app navigates, hydrates and paints (the forged-session cookie is set
before any navigation, so there's a dead stretch of `about:blank` + loading
shell up front).

Middlewright already exposes `page.videoMode.setStartTime(ms)` to trim this, and
one spec (`repl-examples.spec.ts`) calls it by hand. This task makes that
trimming **automatic and default** for every spec: right after the first
navigation, once the app reports it has hydrated, we mark that moment as the
default video start. Specs that want a different anchor keep calling
`setStartTime()` themselves — the explicit call runs later and wins.

Net effect: demo videos open on real content instead of a blank screen, with
zero per-spec changes.

**Status:** implemented in the test fixture; before/after demo videos captured
from PR #1768's `repo-ide-markdown-preview.spec.ts` and attached to the PR.

## The concrete repro

PR #1768's demo GIF (`specs/repo-ide-markdown-preview.spec.ts`) opens on a blank
screen. That's the repro to run before/after.

## Approach

Centralise the trim in the shared test fixture (`specs/test-support/test.ts`)
rather than sprinkling `setStartTime()` across specs:

- After a page is wrapped with the middlewright plugins, patch its `goto` so the
  **first** navigation, once resolved, waits (best-effort, bounded) for the app
  to finish hydrating and then calls `page.videoMode?.setStartTime()`.
- The signal for "meaningful content is up" is the existing hydration contract
  the app already renders: `<body data-hydrated="false">` server-side, flipped
  to `"true"` on hydration (`apps/os/src/routes/__root.tsx`). This is the same
  gate `hydrationWaiter` uses, so it's a proven "app is interactive" marker.
- Entirely gated on `page.videoMode` existing (i.e. `VIDEO_MODE=1`); a complete
  no-op otherwise.
- Detection never throws into the test: if the marker never appears it just
  leaves the start untrimmed.

### Why not do it in middlewright itself?

The truly-general home for this is `middlewright`'s video-mode plugin — e.g. a
pixel-based "first non-blank frame" default computed from the raw webm at render
time (works for any app, no hydration contract needed). That's a bigger change
to a separately-versioned dependency (`~/src/middlewright`, shipped here via a
pnpm patch). This task does the self-contained iterate-side version first; the
middlewright default can follow as a proper upstream change.

## Checklist

- [ ] Auto-`setStartTime` on first navigation, in the shared fixture, gated on `VIDEO_MODE`
- [ ] Explicit `setStartTime()` in a spec still wins (last write wins)
- [ ] Detection is best-effort — never fails a test
- [ ] Capture before/after demo videos from `repo-ide-markdown-preview.spec.ts`
- [ ] Attach a real **video** (not GIF) to the PR via the attachment-upload flow
- [ ] `pnpm typecheck && pnpm lint` clean

## Notes / log

- The previous PR-media pattern converted webm→GIF because it embedded a
  **release-asset URL** in a tag, which GitHub sanitises for `<video>`. The
  attachment-upload flow (drag the file into the PR editor →
  `user-attachments/assets/...` URL) renders an inline video player, so we can
  attach a real video. Convert the webm→mp4 for the widest GitHub support.
</content>
</invoke>
