---
status: in-progress
size: large
branch: mobile-chat-attachments
---

# Mobile: richer chat attachments (photos, video, files, audio, location)

## Status summary

Fleshed-out spec, implementation starting. Nothing merged yet.

- Done: spec below (assumptions delineated), worktree + PR open
- Missing: everything else

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

- [ ] `ComposerAttachment` union (photo | video | file | audio | location) in
      a new `lib/composer-attachments.ts`, replacing `PickedImage[]` state in
      chat; bytes read lazily at send
- [ ] Attachment chips above input: thumbnail per kind (image preview, video
      preview + ▶, 📎 name, 🎤 duration, 📍); tap → "Remove attachment?"
      OK|Cancel
- [ ] "+" opens attachment sheet (not the picker directly)
- [ ] Sheet carousel: last ~10 camera-roll photos+videos, horizontal; extends
      `recent-photos` lib to videos
- [ ] Carousel tile 1: live `expo-camera` preview with box-camera icon → tap
      opens full-screen capture (photo snap + video record)
- [ ] Sheet rows: All photos (picker with videos enabled), Files
      (document picker), Audio (recorder modal), Location (one-tap attach)
- [ ] Mic button replaces dimmed ↑ when composer is empty; tap toggles
      mic ↔ box-camera with transient tooltip
- [ ] Hold-to-record gesture: pure state machine in
      `lib/record-gesture.ts` (+ unit tests) — hold records, release
      finishes→attach, slide left cancels, slide up locks
- [ ] Recording UI: red dot + elapsed timer + "slide to cancel"; locked mode
      with Cancel / stop button
- [ ] Video record mode: front camera, Telegram-style circular viewport
      while recording
- [ ] Location XML part composing + send-path merge into message text
- [ ] `addFiles` send path handles the new kinds (contentType/filename per
      kind); video/file size guard
- [ ] app.json: camera/mic/location/photo permission strings + plugins
- [ ] Graceful degradation when native module missing (old dev client, web)
- [ ] Masonry/mosaic layout for multi-photo MESSAGE BUBBLES (scope added
      mid-flight): today multiple photos stack full-width on top of each
      other; instead lay them out Telegram-style. Pure justified-rows
      algorithm (flickr/justified-layout-inspired, attributed) in
      `lib/mosaic-layout.ts` + unit tests; bubble component uses cached
      image sizes and falls back to squares while they load
- [ ] Unit tests: gesture machine, attachment model, location xml, size guard
- [ ] typecheck + lint + knip + format + test green

## Follow-ups (explicitly out of scope)

- Map renderer for received location parts (mobile + web)
- Rendering audio/video attachments inline in the thread (playback UI) —
  today they open via the signed URL in the browser like other files
- Note composer adopting the same sheet
- True background/lazy upload with retry (upload-at-send is v1)

## Implementation log

(appended as work happens)
