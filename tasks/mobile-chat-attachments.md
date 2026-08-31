---
status: in-progress
size: large
branch: mobile-chat-attachments
---

# Mobile: richer chat attachments (photos, video, files, audio, location)

## Status summary

Implementation largely complete; verified on the web build via browser specs.
Native (camera/mic/location) paths compile and degrade gracefully but need a
new dev-client build + a phone to try for real.

- Done: attachment model + chips + remove dialog, + sheet (carousel, camera
  tile, All photos/Files/Audio/Location rows), hold-to-record gesture machine
  + record button (mic + circular video), mosaic bubbles, unit tests, two
  browser specs (mosaic, sheet)
- Missing: on-phone verification of camera/audio/location (needs new EAS dev
  client), audio *recorder* UI in the sheet (row currently picks audio files;
  the mic button records), locked-mode pause, map rendering for locations

## Ask (verbatim gist)

The "+" button in chats only selects photos. It should open a Telegram-style
attachment sheet: a horizontally scrollable carousel of the last ~10 camera
roll items (photos OR videos), whose first tile is a live camera feed with a
box-camera icon. Below the carousel, a row of other sendable stuff:

- All photos (native photo picker)
- Files (pdfs etc.)
- Audio recordings
- Location (attach as html/xml in the message; maybe a map renderer later)

Also: when there's no text, the disabled send button becomes a microphone for
hold-to-record voice clips. Tapping it once switches it to a box-camera icon
(with a transient tooltip) for recording video instead. Hold-to-record follows
Telegram: release to finish, slide left to cancel, slide up to lock into
hands-free recording mode (with stop/cancel controls).

Attachments appear as thumbnails above the input — never auto-sent. Tapping a
thumbnail asks "Remove attachment?" OK|Cancel.

Attachments send as xml/html parts pointing at the thing; audio stays local
and uploads lazily.

## Decisions & assumptions (made while Misha was AFK)

1. **Scope: the chat composer** (`src/app/project/[projectId]/chat.tsx`). The
   note composer keeps its current strip/+ but shares the new lib code where
   free.
2. **Telegram screenshots arrived mid-flight** (a follow-up message). Details
   to mimic: tooltip text "Hold to record video. Tap to switch to audio."
   (mirrored for the other direction); while holding — red dot + timer +
   "‹ Slide to cancel" bar, lock icon with chevron above the button; locked
   mode — bar becomes red dot + timer + a Cancel text button, and the button
   becomes send/stop. Video records into a circular viewport overlaid on the
   screen with camera-flip + flash controls. Telegram's locked-mode *pause*
   control is a follow-up, not v1.
3. **Release-to-finish attaches, doesn't send.** Telegram sends on release;
   Misha's blanket rule here is "don't automatically send", so a finished
   recording becomes an attachment chip like everything else.
4. **Transport follows the platform grain** (per push-back memory): anything
   with bytes (photo, video, file, audio) goes through the existing
   `agent.addFiles` lane — one event, signed URLs, web + LLM rendering for
   free. "Lazily" = bytes are read/uploaded at *send* time, not at attach
   time (attach just holds a local uri). Only **location** — which has no
   bytes — is sent as an inline XML part appended to the message text:
   `<user-location latitude=".." longitude=".." accuracy-meters=".."
   captured-at=".."/>`. If Misha really wants file-attachments-as-xml-parts
   instead of addFiles, that's a follow-up conversation — the addFiles lane
   is strictly more capable today.
5. **New native modules** (`expo-camera`, `expo-audio`, `expo-location`,
   `expo-document-picker`) mean a new dev-client build (EAS cloud; no local
   Xcode needed). Until then the new UI degrades: modules are loaded lazily
   and missing ones hide their tiles/rows (README precedent: the camera-roll
   strip is "simply absent" on older clients).
6. **Caps**: video records at 720p max 60s; library videos > ~32MB are
   refused with a friendly alert (websocket frame sanity). Audio records
   AAC/m4a, no hard cap (voice clips are small).
7. **Map renderer**: skipped for v1 (follow-up below). Location renders as its
   XML → the agent sees coordinates; mobile/web render is the raw text for
   now.
8. **Web build** (where browser specs run): camera/audio/location tiles hide;
   the carousel uses the existing `__ITERATE_WEB_PHOTO_LIBRARY__` boundary so
   specs can still drive attach flows.

## Checklist

- [x] `ComposerAttachment` union (photo | video | file | audio | location) in
      a new `lib/composer-attachments.ts`, replacing `PickedImage[]` state in
      chat; bytes read lazily at send
- [x] Attachment chips above input: thumbnail per kind (image preview, video
      preview + ▶, 📎 name, 🎤 duration, 📍); tap → "Remove attachment?"
      OK|Cancel
- [x] "+" opens attachment sheet (not the picker directly)
- [x] Sheet carousel: last ~10 camera-roll photos+videos, horizontal; extends
      `recent-photos` lib to videos
- [x] Carousel tile 1: live `expo-camera` preview with box-camera icon → tap
      opens full-screen capture (photo snap + video record)
- [x] Sheet rows: All photos (picker with videos enabled), Files
      (document picker), Audio (recorder modal), Location (one-tap attach)
- [x] Mic button replaces dimmed ↑ when composer is empty; tap toggles
      mic ↔ box-camera with transient tooltip
- [x] Hold-to-record gesture: pure state machine in
      `lib/record-gesture.ts` (+ unit tests) — hold records, release
      finishes→attach, slide left cancels, slide up locks
- [x] Recording UI: red dot + elapsed timer + "slide to cancel"; locked mode
      with Cancel / stop button
- [x] Video record mode: front camera, Telegram-style circular viewport
      while recording
- [x] Location XML part composing + send-path merge into message text
- [x] `addFiles` send path handles the new kinds (contentType/filename per
      kind); video/file size guard
- [x] app.json: camera/mic/location/photo permission strings + plugins
- [x] Graceful degradation when native module missing (old dev client, web)
- [x] Masonry/mosaic layout for multi-photo MESSAGE BUBBLES (scope added
      mid-flight): today multiple photos stack full-width on top of each
      other; instead lay them out Telegram-style. Pure justified-rows
      algorithm (flickr/justified-layout-inspired, attributed) in
      `lib/mosaic-layout.ts` + unit tests; bubble component uses cached
      image sizes and falls back to squares while they load
- [x] Unit tests: gesture machine, attachment model, location xml, size guard
- [x] typecheck + lint + knip + format + test green

## Follow-ups (explicitly out of scope)

- Map renderer for location parts + audio/video players on the WEB dashboard
  (mobile has them now)
- Note composer adopting the same sheet
- True background/lazy upload with retry (upload-at-send is v1)

## Implementation log

- Pure cores first, all unit-tested: `lib/composer-attachments.ts` (model,
  lazy uploads, location XML), `lib/record-gesture.ts` (hold/slide/lock
  machine), `lib/mosaic-layout.ts` (justified rows,
  flickr/justified-layout-inspired).
- `lib/native-modules.ts` guards requires of expo-camera/audio/location/
  document-picker/file-system so old dev clients hide features instead of
  crashing (native-markdown precedent).
- Components: `attachment-chips.tsx` (remove dialog; window.confirm on web),
  `attachment-sheet.tsx` (carousel + rows), `camera-capture.tsx` (full-screen
  photo/video), `record-controls.tsx` (mic/video hold-to-record; expo-audio
  hook used via a component only mounted when the module loads).
- Audio row = document picker filtered to audio/* (recording lives on the mic
  button); revisit if a dedicated recorder modal is wanted there.
- Timer displays use refetchInterval queries, not effect hooks.
- The chips flow + carousel toggle + mosaic verified end-to-end by browser
  specs `specs/mobile/chat-attachment-sheet.spec.ts` and the updated
  `specs/mobile/chat-photos.spec.ts` (mosaic assertions; solo-photo message
  keeps the blurred-backdrop coverage).
- Feedback round 1 (Misha, in-chat): sheet moved ABOVE the input row so the
  composer never shifts; action rows became a horizontal Telegram-style
  icon bar; the "Camera is not ready" crash on mic→video switch fixed by
  pre-warming an invisible CameraView the moment video mode is armed
  (recordAsync only ever runs after onCameraReady); photo/video pixel
  dimensions now ride the message as `<attachment filename w h />` XML parts
  so mosaics lay out exactly right on first paint (parts are stripped from
  the visible caption); `<user-location/>` renders as a real map card — OSM
  raster tiles stitched by pure Web Mercator math (lib/location-map.ts, no
  native module, no API key), pin overlay, tap → Apple Maps | Google Maps
  chooser.
- Feedback round 2: inline PLAYERS. Audio attachments (m4a/mp3/wav) render a
  play/pause + scrubbable waveform row (deterministic bars —
  lib/waveform.ts; expo-audio playback; fixed height, full media width) with
  the length underneath. Videos join the photo mosaic as first-frame
  thumbnails (expo-video-thumbnails) with a play badge → full-screen
  expo-video player. Tapping photos now opens the existing MediaViewer
  (pinch/zoom/swipe-dismiss) on the cached uri — instant — instead of the
  slow in-app browser page. Two more native modules: expo-video,
  expo-video-thumbnails (same new-build boat).
- Feedback round 3 (on-device testing): ripped out ALL old-client
  degradation (guarded loaders, availability checks, fallback branches) —
  the fingerprint runtime policy already keeps this JS off old binaries, and
  every module ships a web implementation, so the guards protected nobody
  but an outdated Metro dev client (crash-and-rebuild is the repo's
  precedent). Waveform recolored to the neutral theme palette (tone-aware
  per bubble). ROOT CAUSE of dead m4a playback / missing duration / broken
  scrub / blank video thumbnails / black fullscreen video: the file-serving
  plane ignored HTTP Range headers, which iOS AVPlayer requires — fixed
  server-side (parseRangeHeader + 206/416 in serveProjectFileRequest, unit
  tested + live 206 asserted in the chat-photos spec). Image viewer opens
  with animationType none (no more black-fade flash). The 10MB-PDF
  "RPC session was shut down" was Cloudflare's ~1MiB websocket message cap:
  attachments over 512KB now ride as chunked ReadableStreams (capnweb
  multiplexes them with flow control; web-streams-polyfill fills Hermes's
  gap).
- Optimistic sends (feedback item a): tapping ↑ renders the predicted
  bubble immediately from phone-local data — the SAME MessageBubble the echo
  will render, fed local uris (previews, mosaic, players, location cards all
  work locally) — dimmed with "sending…" while the upload runs, hidden when
  its event offset echoes back over the live connection. Failures keep the
  bubble with Retry / Edit instead of dumping the draft back. Sends can
  queue (the button no longer locks while one is in flight). Eager upload
  (item b) stays a follow-up: needs an addFiles-by-reference platform seam.
- Feedback round 4: "sending…" under a pending bubble now renders in the
  SAME WorkingCard box that replaces it — no layout jump. Voice notes record
  as 16kHz mono LPCM WAV (transcription models' native diet; the AAC m4a
  came back "no recognizable speech" from the platform transcriber) and
  announce themselves with a `<voice-note filename duration-seconds />` part
  — the agent's cue to transcribe, stripped from the visible caption along
  with the server's default "[Files attached: …]" note, so a voice-only
  message renders as just the player. On-device transcription
  (expo-speech-recognition) noted as a possible follow-up.
- Feedback round 5: ON-DEVICE TRANSCRIPTION. expo-speech-recognition
  (SFSpeechRecognizer) transcribes a recorded clip starting the moment the
  recording lands; the send path waits up to 4s for a straggler and stamps
  the result as `<voice-note transcript="…" />`. Best-effort: permission
  refused / no speech / slow → attribute simply absent, and the agent can
  still run a model transcription. New native module → another build.
- Feedback round 6 (UI niggles): the + sheet dismisses on any tap outside
  it (transparent backdrop over the conversation — drawer semantics);
  carousel now 50 items with ❤️ badges (per-asset info lookups,
  no-network); carousel tiles and pending-attachment thumbnails sit flush
  with a 1px background line between them; file attachments render as a
  media row matching the voice note's geometry (glyph / filename / size +
  type; page count would need PDF parsing — skipped); the
  All photos|Files|Audio|Location bar is centered. EAS plan upgraded, so
  this push's workflow run should produce the transcription build.
- Feedback round 7: chips render ABOVE the attachment sheet (chat and note
  composer), so attaching never shifts the sheet or input. The ambient note
  composer now uses the SAME AttachmentSheet + AttachmentChips as chat —
  full surface (camera tile, 50-item carousel, files, audio, location),
  destination /notes; locations fold into the note text as xml lines,
  byte attachments convert to inline base64 (pendingNoteAttachments) so the
  offline pending-note store keeps its never-lose-data guarantee with an
  UNCHANGED schema; the /media analysis double-append is now images-only.
  recent-photos-strip.tsx deleted (readRecentPhotos/RECENT_PHOTOS_LIMIT
  pruned with it); its spec now drives the shared sheet.
- Feedback round 8: chips grew to 84px flush tiles with a corner ✕
  (removal, still behind the confirm dialog) — tapping the tile previews it
  full screen via the SAME MediaViewer sent photos use (pinch/zoom,
  swipe-down dismiss; markup tools can hang off it one day); videos preview
  in the shared fullscreen player. The note composer's empty-state send slot
  now shows the hold-to-record mic/video button (was a dimmed ↑), and a
  spoken note's on-device transcript rides into the note text as a
  <voice-note transcript /> line — for a note, the words are the point.
- Gotcha found while running specs: wrapping `dev.ts` in an outer
  `doppler run` exports DOPPLER_PROJECT/DOPPLER_CONFIG, which the INNER
  `doppler run` (apps/os scope) honors over doppler.yaml — the dev server
  then reads the wrong project's secrets and /api/health 500s. Run
  `node ./apps/os/scripts/dev.ts restart --detach` bare.
