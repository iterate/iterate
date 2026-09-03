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

## Feedback round 5 (tracking + polish)

- The attachment sheet's live camera tile now respects the persisted
  front/back choice (shared `useCameraFacing()` in `lib/camera-facing.ts`).
- Mask swipes now reshape ONLY the hole: remapped cutouts scale from the
  unstretched feature size, so growing the mask no longer zooms the imagery
  underneath.
- The mode (card-style) button hides while recording.
- Potato fully tracks the head: position, roll, and z-depth (face-width
  ratio) relative to a baseline captured on the first tracked frame after
  the filter starts; flashcard features scale with lean-in while staying
  pinned top-half.
- Deck grown to 81 picture words + 4 colors (body parts, animals, vehicles,
  foods, toys — 1.5yo vocabulary guesses) for both styles; generation
  script is merge-mode (keeps approved art, generates only missing words);
  order shuffles each camera session. Unsplash dropped per Misha.

## Feedback round 6 (two game filters + vibe-coded filters for real)

- 🎤 **Sing** filter: autocorrelation pitch detection on the live mic
  (WebAudio AnalyserNode → `lib/filters/pitch.ts`, unit-tested), solfège
  ladder do→do′, a wall slides in with its hole at the target note's
  height, and the ball (your actual mouth, cutout-sampled) rides your sung
  pitch folded to any octave — ±a quarter tone counts; miss and the wall
  resets. `args.pitchHz` is now part of the filter surface.
- 🫥 **Face drop**: your eyes and lips are skinned over (patches sampled
  from cheek/chin), then fall one at a time down the screen; blinking
  (eye-ring openness with hysteresis) locks each wherever it is, stuck to
  your face box — misplace them for Mr. Potato Head. Tap resets.
- **Dynamic (vibe-coded) filters**: any repo file `filters/<name>.filter.js`
  in the project shows up in the ✨ picker. The file is ONE object
  expression `({ label, emoji, modes?, draw(args) })`, evaluated in the
  WebView, drawing with `args.helpers` (featureCutout / ellipseFeature /
  emoji / cachedImage / imageCover / naturalWidth — the same primitives the
  built-ins use, shaped by the two game filters above). Native side fetches
  sources via `project.repos` (session already there), regex-sniffs
  label/emoji for the picker chips, and a throwing filter shows an error
  pill over the plain camera instead of killing the pipeline. Contract
  spec'd by `dynamic-filter.test.ts`, which runs an agent-shaped filter
  headlessly.
- Removed the 30s filtered-clip cap (bridge payload is unbounded now — on
  Misha's call).
- Media viewer gained a ⬇ save-to-camera-roll button (remote/data uris go
  through a cache file; expo-media-library was already in the build).

## Feedback round 7 (nose, skin, 3D sing, paper toss, agent docs)

- Face drop: nose added (built from bridge/subnasale/alae landmarks as an
  ellipse feature — the mesh has no canonical nose ring); skin fill now
  layers two soft samples from either side of each feature (softness 2.2,
  alpha-blended) so stubble/shading blend instead of one stamped patch.
- Sing: pitch stabilised (parabolic interpolation in the autocorrelator +
  a 700ms median window; passing requires holding the note ~500ms);
  redrawn as a 3/4-perspective road — the wall slides in from the vanishing
  point with a yellow-outlined hole at the target note's height, the ball
  can't go below the road (do = rolling on the ground, silence = resting
  hop). Solfège column stays left; tapping a note name PLAYS it, cycling
  low→mid→high→off octaves (`helpers.playTone`, WebAudio).
- 🗑️ Paper toss: open your mouth to throw — wider = further; random bin
  distance/position + wind per attempt; score HUD; tap resets. Written
  strictly against the args/helpers surface as the reference project
  filter.
- Filter surface grew: `args.tap {x,y,seq}` (positional taps),
  `args.face.nose`, `helpers.playTone`, cutout `softness`/`alpha`;
  mask-swipe tuning covers the nose (stored stretch merges over defaults).
- **Agent context**: `apps/mobile/docs/project-filters.md` is the full
  standalone contract (args, helpers, patterns, thresholds for
  blink/mouth-open) written to be copied into a project repo as
  `filters/README.md` — that's the missing piece for "add a paper toss
  game" prompts to work; without it the project agent has nothing to go on.

## Feedback round 8

- Flashcards: the face now fills nearly all the space above the card (eyes
  ~0.26w each, lips ~0.36w around an anchor at 0.24h), still scaling with
  lean-in; sliding up/down starting on the card scales the whole face
  (persisted in localStorage). New generic surface: `args.drag` for drags
  that don't start on a feature cutout — documented in project-filters.md.

## Feedback round 9 (adjust modes)

- New adjust-mode button (bottom-right, persisted): cycles what drags do —
  ✏️ **holes** (drag on a feature reshapes its mask; other drags reach
  `args.drag`), 🔍 **features** (any drag scales every cutout in place,
  centers fixed), 😐 **face** (any drag scales the whole face, centers
  spread). Scales persist as `args.adjust {featureScale, faceScale}` — the
  cutout helper applies them generically; layout-owning filters
  (flashcards, potato) multiply their layout by faceScale. Replaces the
  flashcards-only card-slide zoom.
- Flashcards default face: eyes closer together and lips tucked up — no
  gap for a nose that isn't there.

## Feedback round 10 (video preview chrome)

- Fullscreen video preview rebuilt: swipe down to dismiss (no ✕), tap
  toggles minimal chrome — ⬇ save-to-Photos and play/pause (native
  controls off; this chrome is where basic video editing will grow).
  Composer chip previews get it too (same component).
- Save-to-camera-roll extracted to `lib/save-to-camera-roll.ts`, shared by
  the photo viewer's ⬇ and the video chrome; remote/data uris round-trip
  through a cache file.

## Bug: recorded-video playback freezes partway (round 11 hardening)

Reported twice on-device; not reproducible headless. Two likely WebKit
MediaRecorder mechanisms, both hardened:
- The raw mic track can carry timestamp gaps; AVPlayer slaves video to the
  audio clock on playback, so a gappy/short audio track freezes the
  picture. Recordings now mix the mic through a WebAudio
  MediaStreamDestination (continuous timestamps).
- Single-blob finalization of long recordings (the 30s cap is gone) is
  fragile; the recorder now runs timesliced (1s chunks) and surfaces
  recorder.onerror. Observe on-device — if it still freezes, next lever is
  re-muxing on the native side.

## Feedback round 12 (flashcards is a hit)

- Background button (second mode group, own button above the style cycler):
  🎨 per-card colours / ⬜ white / ⬛ black / 📜 cream / 🌈 rainbow — chrome
  (swatch outlines, chips) flips dark on light backgrounds. Generic
  mechanism: FILTER_MODES_2 + args.modeIndex2.
- Seeded deck: order comes from a visible 3-digit seed (Date.now()%1000);
  on-canvas chips top-left — ↺ replays the same order from card one, 🎲
  rolls a new seed. Chips are filter-drawn + args.tap hit-tested (the
  pattern project filters can copy).
- Card set: smiling child removed; door reopened, book/pasta/bus
  regenerated (open door, picture book, bowl of pasta, red London
  double-decker); added honey, toast, peanut butter, broccoli, ice lolly,
  ice cream, pear, kiwi, eye, chin, penguin, giraffe, piano, taxi (black
  cab), scooter, digger, fire engine, motorbike — 98 pictures + 4 colours
  per style, London-appropriate vehicles.
- Mask jaggedness question answered (fixable by sampling at destination
  resolution; not done this round).

## Feedback round 13 (settings row)

- All filter controls collapse into ONE horizontal settings row (bottom,
  above the capture bar, centered, scrolls if it ever overflows): style
  cycler, background cycler, filter action buttons, adjust-mode cycler.
  Fixes the stacked buttons covering each other and the ↺/🎲 canvas chips
  hiding under the clock.
- ↺/🎲 became generic settings-row **action buttons** (FILTER_ACTIONS /
  `actions` on dynamic filters, presses arrive as `args.action {id, seq}`);
  the deck seed is now a display-only readout drawn below the status bar.

## Feedback round 14 (no whole AI faces)

- The photo-style cards that rendered whole AI-generated faces are gone:
  doll regenerated as an obvious button-eyed rag doll (was an uncanny
  lifelike child with pigtails), nose and chin regenerated as strict
  close-ups with no eyes visible. Eye/ear were already proper close-ups;
  cartoon-style cards are stylized drawings and stay. Prompts updated so
  future regenerations stay face-free. (403s parked per Misha — ignoring
  until mentioned.)

## Feedback round 15 (realistic animal masks)

- The cat filter became the Animal filter: 11 photorealistic
  transparent-background portraits (cat, dog, goat, tiger, bear, monkey,
  gorilla, lion, horse, fox, mouse — `generate-animal-faces.mjs`, ~2.5MB),
  cycled by the settings-row mode button. The mask tracks the head, and
  your eyes/mouth are remapped onto the ANIMAL's eye/mouth positions via
  hand-tuned per-image anchors (ANIMAL_FACES in definitions.ts —
  re-check anchors after regenerating art).
- Preview 403s fixed on main (#2567, repo-name casing) — PR fully green;
  known-red note removed, preview-8/17 unparked.

## Feedback round 16 (talking animals, friendlier cast)

- The animal's mouth now moves with YOURS: the portrait splits at the mouth
  line, the jaw band drops with your smoothed mouth openness, and a dark
  mouth interior shows in the gap (talking-pet warp). Human eyes stay
  pasted into the animal's sockets; your lips are no longer pasted on.
- All 11 portraits regenerated with species-specific friendliness cues
  ("friendly" is species-specific: no bared teeth for primates, slow-blink
  for the cat, big pupils + forward ears for the big cats). Dog became a
  labrador. Horse reshot twice to get the mouth in frame (zoomed-out
  framing + scale 1.6 compensation). All anchors re-tuned against the new
  art. CDN/R2 for image weight: suggested not for now (canvas-taint would
  break capture; core infra).

## Feedback round 17 (real mouths, verified anchors)

- Mouth rework: no more South-Park head split — the portrait stays intact;
  opening your mouth draws a dark interior + tongue at the animal's mouth
  point and drops a feathered chin patch sampled from the portrait itself
  (drawImageEllipsePatch). Reads as the animal's own mouth opening.
- Anchors: tried vision-model detection (detect-animal-anchors.mjs) — it
  returned prior-driven boilerplate (five animals identical, three nulls),
  kept as the generated base. The reliable loop is the harness's
  ?annotate=1 grid (all portraits + crosshairs) reviewed visually;
  corrections live in ANIMAL_ANCHOR_OVERRIDES. Two rounds pinned all 22
  eyes + 11 mouths (the lion no longer wears its eyes on its cheeks).
- Harness gained ?open=<ratio> to force mouth openness (the synthetic face
  can't open its own).

## Review round (Misha, on the PR)

- Patch file: explanatory // comment now lives inside the diff itself.
- The four generation .mjs scripts consolidated into
  `scripts/generate-filters.ts`, a trpc-cli module CLI (`pnpm
  generate-filters backdrops|flashcards|animals|animal-anchors`), shared
  merge-mode/OpenAI/sips plumbing, TypeScript. Smoke-tested as a no-op
  merge run.
- The ✨ toggle is gone: the filter chip row is always visible above the
  capture bar (None chip for a normal photo).
