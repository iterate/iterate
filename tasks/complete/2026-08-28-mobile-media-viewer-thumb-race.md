---
status: done
size: small
---

# Mobile media: full-screen tap dead while the signed URL loads

**Status summary**: done. Fix landed on PR #2545; the previously-failing spec
passed on the PR's own Cloudflare preview run first-attempt (28.0s). Spec
unchanged.

`specs/mobile/media.spec.ts` ("renders, searches, and views seeded media")
fails deterministically on Cloudflare-preview CI at line 81 — after clicking
"View full screen", `getByLabel("Full screen media")` never appears — while
passing against local dev.

## Diagnosis

The failure screenshot + accessibility snapshot from the preview run show the
media row **expanded** (transcript, filename, Re-analyze visible) and no
viewer. `MediaRow`'s thumbnail pressable wears
`accessibilityLabel="View full screen"` from first render but is
`disabled={imageUri === null}` while the signed-URL query
(`project.files.get(path).url()`) is in flight. A tap in that window is
swallowed by the disabled pressable and falls through to the outer row
pressable, which expands the row instead. No spinner exists in that window, so
the middlewright spinner-waiter has no loading UI to extend on ("Timeout 1ms
exceeded"). Local dev resolves the URL fast enough that the click wins the
race; preview deployments (real network, cold worker, KV + R2 head) lose it.

`NoteThumb` in notes.tsx has the identical pattern
(`disabled={imageUrl.data === undefined}`).

Not relevant: the forged-session fixture helpers — signup succeeded in both
failing runs, and mobile specs authenticate through the app's own OAuth popup,
not an OS-origin cookie.

## Fix

- [x] `MediaRow` (media.tsx): render the "View full screen" pressable only
      once `imageUri` exists; while the URL query is pending, show the
      placeholder thumb with an `ActivityIndicator accessibilityLabel="Loading"`
      — real loading UI, and the spinner-waiter cue that keeps the spec's
      wait budget extended until the label appears. _Done in media.tsx; the
      label is now a promise the control works._
- [x] `NoteThumb` (notes.tsx): same gating for `View <filename>`. _Same
      change shape._
- [x] Spec untouched — no timeout bumps. _The spinner-waiter picks up the new
      spinner via its `[aria-label="Loading"]` selector._
