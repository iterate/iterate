---
status: in-progress
size: medium
branch: mobile-camera-filters
base: mobile-chat-attachments (PR #2554 — retarget to main when it merges)
---

# Mobile: 2020-era Zoom filters for the camera

POC. A ✨ button in the full-screen camera (the one reached from the
attachment sheet, currently flip / shutter / video) opens a filter picker.
Picking a filter swaps the plain `expo-camera` preview for a live filtered
pipeline. Photos and clips captured while a filter is active come back as
normal composer attachments, filter baked in.

High-level status: implemented and pushed — picker, pipeline, all four
filters, both capture paths; typecheck/lint/knip/tests green. Remaining:
Misha tries it on a real phone (the getUserMedia-in-DOM-component claim is
the thing to verify first).

## Why this shape (assumptions made while AFK)

- **No new native modules.** A native module means a new EAS dev-client build
  (see mobile-native-build-economy); `react-native-vision-camera` + Skia is
  the "proper" way to do live filters but is exactly that kind of module. So
  the pipeline lives in a WebView instead: an Expo DOM component
  (`"use dom"`, same pattern as `code-editor.tsx`) running
  `getUserMedia` → hidden `<video>` → canvas draw loop.
- **This is the vibe-code seam.** Each filter is a plain-JS draw function
  over `(canvas ctx, video frame, face geometry, tap state)` — data, not
  native code. The obvious follow-up is loading filter modules from project
  streams (`/filters/...`) so an agent can write "make me a carrot in a
  verdant meadow" as userland code. Not in this PR; the interface is shaped
  for it.
- **Face tracking = MediaPipe FaceLandmarker** (Google, Apache-2.0), the OSS
  engine behind most 2020-era filter apps. Loaded at runtime from the
  jsdelivr CDN inside the WebView (wasm + model). The phone talks to a
  backend anyway, so runtime network is acceptable for a POC; if the CDN is
  unreachable the filters fall back to a fixed centered face oval rather
  than dying. Follow-up: vendor/bundle the wasm + model as app assets.
- **Backdrops = AI-generated images** (gpt-image-1, via the Doppler OpenAI
  key), generated once by `apps/mobile/scripts/generate-filter-backdrops.mjs`
  and committed as data URIs in `backdrops.generated.ts` (~300KB for 9).
  Face art stays emoji.
- **Captured clips are re-encoded in the WebView** via
  `canvas.captureStream()` + `MediaRecorder` (mp4 on iOS WebKit), then
  base64 across the bridge and written to a cache file. Filtered recordings
  are capped at 30s to keep the bridge payload sane (plain camera stays 60s).

## Checklist

- [x] ✨ button in the camera top bar; horizontal filter picker (None + 4
      filters) _in `camera-capture.tsx`_
- [x] WebView filter pipeline DOM component _`filter-camera.tsx`, driven by a
      marshaled `command` prop (snap / start / stop), results come back as
      base64 via async props_
- [x] Face geometry from MediaPipe FaceLandmarker, with a no-face/no-CDN
      fallback oval _`src/lib/filters/face-geometry.ts`_
- [x] Filter: **potato-in-the-dirt** — giant 🥔 over the face, your real
      eyes + lips composited on top, dirt/field scene behind
- [x] Filter: **just-eyes-and-lips** — only your eyes and lips float over
      the scene
- [x] Filter: **cat** — full 🐱 face ("I'm not a cat"), real eyes + lips
      showing through
- [x] Filter: **toddler flashcards** — eyes-and-lips over a giant flashcard
      (dog, ball, banana, cow, colors, ~40 words an 18-month-old might
      know); tapping advances the card
- [x] Every filter: tap the background mid-stream to cycle it (flashcards:
      tap = next card) — proof the pipeline is interactive
- [x] Photo capture with filter baked in → `ComposerAttachment` (photo)
- [x] Video capture with filter baked in (incl. mic audio) →
      `ComposerAttachment` (video, mp4)
- [ ] Human test on a real phone (Misha)

## Out of scope / follow-ups

- Vibe-coding filters from chat (`/filters/...` streams feeding the same
  `FilterDefinition` interface) — the whole point of the seam, next PR.
- Bundling MediaPipe wasm/model offline.
- Background *segmentation* (real virtual backgrounds behind your whole
  body) — MediaPipe ImageSegmenter drops into the same pipeline later.
- Android (WebView getUserMedia needs different permission plumbing; iOS
  only for now, like the rest of the app).

## Implementation log

- Worktree created off `mobile-chat-attachments` (d58fec3f3). Watching PR
  #2554; when it merges, update this branch from main (merge, or cherry-pick
  reapply if the squash makes the merge ugly).
- Implementation: `src/lib/filters/face-geometry.ts` (landmarks → face box +
  eye/lip ellipses, unit-tested), `src/lib/filters/definitions.ts` (the four
  filters; scenes are gradient sky + hill + emoji props, faces are giant
  emoji + feathered video cutouts), `src/components/filter-camera.tsx` (the
  `"use dom"` pipeline: getUserMedia, rAF draw loop, MediaPipe via injected
  <script type="module"> because Metro must not see the CDN import,
  MediaRecorder for filtered clips), `camera-capture.tsx` (✨ + picker +
  command/promise bridge).
- Filtered-clip flow: native mutation parks a promise, sends `{seq, type}`
  command prop; DOM records canvas.captureStream + mic, base64 → onVideo →
  file written via expo-file-system/legacy → video attachment. 30s hard cap
  both sides.

## Feedback round 1 (Misha, mid-flight)

- Potato redone as **buried in the dirt** (reference image): the backdrop is
  an underground soil cross-section, the potato sits fixed in it, and your
  tracked eyes + lips are **remapped onto the potato** (cutouts gained a
  source→dest mapping; cat/eyes-lips remain in-place masks).
- Emoji-art scenes replaced with AI-generated backdrops (see above).
- Flashcards no longer print the word — picture only; the grown-up says it.
- The desktop "filter harness" screenshotted in the PR is a throwaway test
  rig in the session scratchpad (bundles the real filter modules against a
  synthetic camera); it is not part of the app.

## Feedback round 2 (on-device: tracker never loaded)

Root causes found (no device needed): the CDN pin `@0.10.22` doesn't exist
(404), remote ESM imports are unreliable from the `file://` pages release
builds host DOM components on, and the "loading" pill never distinguished
loading from failed.

- Face tracking now ships **fully bundled, zero network**:
  `@mediapipe/tasks-vision` (0.10.35, exact) bundles through Metro (with a
  pnpm patch neutralizing a non-literal dynamic `import()` Metro can't
  parse); wasm + face_landmarker model ride as gzipped base64 in
  `mediapipe-assets.generated.ts` (~6.5MB, regenerate with
  `scripts/generate-mediapipe-assets.mjs`), decompressed at runtime via
  `DecompressionStream` (iOS 16.4+) into blob URLs / model bytes.
- The pill now reports the actual tracker error on failure.
- Verified end-to-end in the harness: tracker goes live offline and detects
  even the synthetic cartoon face — which exposed and fixed a real bug: the
  front-camera mirror swaps the eye rings, flipping the roll ~180°
  (upside-down potato); roll now wraps into ±90°, with a regression test.
- Flip-camera choice persists across restarts (AsyncStorage-backed query,
  `iterate.cameraFacing.v1`) — and replaced a `useState` in the process.
- Follow-up: the filter DOM bundle is now ~10MB; if that hurts open time,
  move the model/wasm to native assets or lazy-load per filter.

## Feedback round 3 (on-device: filters work; polish)

- Potato eyes were swapped: the front-camera mirror puts the anatomical
  left-eye ring on the canvas right, so `FaceGeometry.leftEye/rightEye` now
  always mean canvas-left/right (regression-tested). Potato's fixed base
  tilt removed — it aligns to your head roll only.
- Flashcards: your face stays pinned in the top half (eyes/lips remapped to
  fixed spots, patches still roll with your head); the card shows an
  AI-generated cartoon picture (gpt-image-1,
  `scripts/generate-flashcard-images.mjs` → `flashcards.generated.ts`)
  instead of an emoji; color cards keep drawn swatches.
- All cutouts tightened (eye expansion 2.4/3.2 → 1.8/2.4, lips 1.35/1.7 →
  1.15/1.5).
- Module split: `picker.ts` (ids/labels/emoji + clip cap — what the native
  ✨ picker imports) vs `definitions.ts` (draw functions + generated image
  data, DOM-bundle only). This also stops the backdrops riding into the
  native Hermes bundle.
- Unrelated CI red on the Cloudflare preview lane:
  `userspace-facet-source-version.e2e.test.ts` is a `failing()`-pinned bug
  test whose bug didn't reproduce that run — not caused by this branch; the
  next push re-runs it.

## Feedback round 4 (styles + dynamic masks)

- Flashcard picture **styles**, cycled by a new mode button (bottom-left of
  the filter view): 🖍️ Cartoon and 📷 Encyclopaedia (photo-real gpt-image-1,
  quality medium, `generate-flashcard-images.mjs encyclopaedia`, ~1.3MB).
  🌍 Real photos (Unsplash) is wired but hidden: `flashcards-photo
  .generated.ts` is empty until `UNSPLASH_ACCESS_KEY` exists in Doppler —
  add a free demo key from unsplash.com/developers and run
  `generate-flashcard-images.mjs photo`.
- Cutout masks are now **your feature's landmark-ring polygon** (feathered
  by drawing the polygon small and upscaling — no ctx.filter), and remapped
  patches scale **uniformly**, so eyes keep their real aspect instead of
  squashing into canned ellipses.
- **Swipe on a feature to tune its mask**: drag starting on an eye or the
  lips — right/left widens/narrows, up/down heightens/flattens (eyes adjust
  together; lips separate). A pill shows the multipliers; values persist in
  the WebView's localStorage. Plain taps still cycle background/card.
- The generic mode/mask machinery (FILTER_MODES, featureHits hit-testing,
  maskStretch) is part of the vibe-code filter interface, not
  flashcards-specific.
