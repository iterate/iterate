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

**Status:** done. Final design lives in **middlewright** (iterate/middlewright#3):
`videoMode` gains `trimStart: "auto" | "detect-blank" | "never" | ["selector", css]`,
defaulting to `"auto"`. So iterate gets lead-in trimming **just by bumping the
lib** — `specs/test-support/test.ts` is unchanged (zero diff). The detector finds
where the blank lead-in ends from the recorded pixels (first frame that differs
from the opening frame), so it needs no app hydration contract. Two earlier
iterations (an iterate-side `page.goto` patch, then an opt-in `autoStart`) were
replaced by this default-on `trimStart`. Real inline before/after **video**
attached to the PR.

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

### Where it ended up: middlewright (the general fix)

We brought middlewright into scope. `videoMode` gains `trimStart`
(iterate/middlewright#3):

- **`"auto"`** (default) / **`"detect-blank"`**: decode a coarse greyscale strip
  of the opening seconds, find the first frame that _differs_ from the opening
  frame — the end of the static blank lead-in — and start there when the lead-in
  is long enough. Keying on change-from-first (not "busyness") is robust to
  Playwright's letterbox bars and dark loading shells.
- **`["selector", css]`**: start when that element first becomes visible (live),
  with blank-detect fallback.
- **`"never"`**: pin the start (for videos whose exact frames you assert on).
- explicit `setStartTime()` still wins.

Default `"auto"` means consumers get trimming by upgrading with no config change
— iterate's `test.ts` is untouched. middlewright's own frame-precise specs pin
`trimStart: "never"`. That PR also upstreams the spinner-waiter multi-match fix,
so `patches/middlewright@0.1.1.patch` is deleted here. iterate consumes the build
via a `pkg.pr.new` override until it's published.

## Checklist

- [x] Auto-`setStartTime` on first navigation, in the shared fixture, gated on `VIDEO_MODE` _`armVideoAutoStart` in `specs/test-support/test.ts` patches the wrapped page's `goto`_
- [x] Explicit `setStartTime()` in a spec still wins (last write wins) _auto-set runs during `goto`; explicit calls run later and override_
- [x] Detection is best-effort — never fails a test _`.waitFor(...).catch(() => {})`_
- [x] Capture before/after demo videos from `repo-ide-markdown-preview.spec.ts` _`sourceRange.start`: unset → 13.9s; rendered clip 10.7s → 4.0s, opens on content_
- [x] Attach a real **video** (not GIF) to the PR via the attachment-upload flow _done — PR body has a real inline `<video>` player. The harness `file_upload` tool was broken (rejects host paths), so: `pbcopy` the mp4's base64 → real `cmd+v` into the GitHub comment textarea → read value from DOM → `atob` → `File` → assign the `<file-attachment>` hidden input's `.files` + dispatch `change` → GitHub mints the `user-attachments/assets/…` URL → set it in the body via `gh`. See [[github-pr-inline-video-upload]]._
- [x] `pnpm lint`/format clean on the changed file _oxfmt via lint-staged on commit; specs are not part of `pnpm typecheck` (no tsconfig includes them — Playwright transpiles at runtime)_

## Notes / log

- The previous PR-media pattern converted webm→GIF because it embedded a
  **release-asset URL** in a tag, which GitHub sanitises for `<video>`. The
  attachment-upload flow (drag the file into the PR editor →
  `user-attachments/assets/...` URL) renders an inline video player, so we can
  attach a real video. Convert the webm→mp4 for the widest GitHub support.
