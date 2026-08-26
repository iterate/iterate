---
status: ready
size: medium
---

# Camera-roll strip on the note-capture composer

## Status

**Done.** The strip ships, the browser spec drives it end to end (tap →
attach → note on /notes carrying the photo), and every lane is green:
`pnpm typecheck`, `lint`, `knip`, `format`, `pnpm --dir apps/mobile test`,
`pnpm spec --project=mobile` (both the new spec and the existing notes one),
plus `expo export --platform ios` and an `expo config --type introspect`
showing the new `NSPhotoLibraryUsageDescription`.

The one thing left for a human: this needs a native rebuild to reach a phone
(see "Cost" below). Nothing about that is broken — it is the documented path
and CI triggers the preview build — but nobody has installed it yet.

## What

The global note-capture composer (`NoteCaptureOverlay`,
`apps/mobile/src/components/note-composer.tsx` — the docked sheet that is the
reason the app exists when you open it) currently offers exactly one way to
attach a photo: the `+` button, which opens the full-screen system picker.
That is two taps and a modal for the thing you most often want — the photo you
took thirty seconds ago.

Add a **single-row, horizontally scrollable strip of the most recent camera
roll items** directly above the text field. Tap a tile to attach it; tap again
to un-attach. The `+` stays where it is for the full-screen picker.

## Decisions

- **D1 — Tile size 100×100.** As asked. One row, `horizontal` ScrollView,
  `showsHorizontalScrollIndicator={false}`. Total added height ≈ 108px
  including the gap. The strip only renders when there is something to show,
  so a composer with no library access looks exactly as it does today.
- **D2 — `+` stays in the composer row.** It is the full-screen escape hatch
  and it already reads as one. The strip is purely additive; nothing moves.
- **D3 — Never prompt for photo permission on composer open.** The composer
  auto-expands on cold start and on foreground-after-a-while; a permission
  dialog on app open would be obnoxious. So: read permission with the
  *non-prompting* `getPermissionsAsync()`. Granted (`all` or `limited`) → load
  and show the strip. Otherwise → show ONE tile, "Recent photos / Allow", and
  the prompt fires on tap. Denied-after-asking → the strip disappears
  entirely (iOS will not re-prompt; the `+` picker still works because
  PHPicker needs no permission).
- **D4 — 24 most recent, photos only.** Newest first, all albums (not just
  screenshots — that is the sync engine's job). 24 is ~3 screens of sideways
  scroll at 100px; more is a scroll nobody does inside a composer.
- **D5 — Bytes are read at TAP time, not at send time.** The tile shows a
  spinner while reading, so a tap always resolves to a real attachment
  thumbnail in the existing attachment strip (which already exists and
  already handles remove). Reading at send time would mean a send that can
  fail for a reason you cannot see.
- **D6 — Transcode to JPEG on read (`expo-image-manipulator`).** The `+`
  picker path gets this for free: PHPicker's
  `preferredAssetRepresentationMode: Compatible` transcodes HEIC camera
  photos to JPEG at pick time, which is why `pickImages` produces analyzable
  bytes. Reading a `MediaLibrary` asset gives you the **original**, which on a
  default iPhone ("High Efficiency") is HEIC — and
  `unsupportedImageReason()` exists precisely because the server's
  `toMarkdown` has no HEIC converter. So a strip that attached raw asset
  bytes would produce un-analyzable notes for most real camera photos.
  `expo-image-manipulator` re-encodes to JPEG at `compress: 0.8` — the same
  quality the picker uses — and also keeps 12MP originals from becoming
  10MB websocket frames.

  **This is a native dependency: existing builds will not receive this
  feature over the air.** The fingerprint policy means CI notices the new
  fingerprint and triggers a preview build automatically; a dev client needs
  `pnpm --dir apps/mobile build:development:ios`. See "Cost" below.
- **D7 — Update the photo-permission string.** `app.json`'s
  `photosPermission` currently says "Iterate syncs the screenshots you choose
  into your project". The strip reads the whole roll to *display* it, so the
  string has to say so. This alone would bump the fingerprint even without
  D6.
- ~~**D8 — cap attachments at 4.**~~ Dropped while building it: the `+`
  path has no total cap today (each pick appends), so a cap enforced only on
  the strip would be an inconsistency the user feels rather than a limit that
  protects anything. Attached tiles do show a check, and tapping a checked
  tile removes it — the toggle is the whole interaction.
- **D9 — Selection identity is the asset id**, so the strip and the existing
  attachment strip stay in sync when you remove a thumbnail from either side.
  The `PickedImage` gains an optional `assetId` for exactly this.

## Cost / what a reviewer should know

Merging this makes the next mobile bundle require a **new native build**
(one new native module + an `Info.plist` string). That is the documented
normal path (`apps/mobile/README.md` "Dev ↔ preview"), and CI triggers the
preview build itself, but it means this feature is not instantly OTA-visible
on an installed app. Reverting D6+D7 would restore OTA delivery at the cost
of most camera photos being un-analyzable.

## Checklist

- [x] `apps/mobile/src/lib/recent-photos-core.ts` — pure *tell me what this
      permission answer means* — `photoLibraryAccessFrom` — plus the tile
      count. _The strip-model derivation the spec imagined turned out to be
      one `.some()` call over the attachments, so it stayed inlined in the
      component where a reader can see it._
- [x] `apps/mobile/src/lib/recent-photos.ts` — Expo-welded: non-prompting
      permission read, request-on-tap, recent-asset listing, and
      asset → `PickedImage` (JPEG transcode)
- [x] ~~`recent-photos.web.ts`~~ — _the web seam lives at the bottom of
      `recent-photos.ts` instead. Metro only substitutes a `.web.ts` sibling
      for **extensionless** imports (`resolveSourceFile` tries the exact path
      before any platform variant), and this repo writes every relative
      import with its `.ts` extension — so a `.web.ts` file would have been
      silently dead code._
- [x] `apps/mobile/src/components/recent-photos-strip.tsx` — the row
- [x] Wire it into `note-composer.tsx` above the text field, sharing
      selection state with the existing attachment strip
- [x] `expo-image-manipulator` dependency + `app.json` permission string
      _(verified landing in the Info.plist via `expo config --type
      introspect`)_
- [x] `apps/mobile/src/lib/recent-photos-core.test.ts`
- [x] `specs/mobile/note-composer-camera-roll.spec.ts` — browser spec:
      tiles render, tap attaches, tap again removes, and the note on /notes
      carries the photo under its library filename
- [x] README verification-table / layout-table rows _(plus the native-rebuild
      paragraph, which now names this strip as the second such module)_

## Implementation log

**`PickedImage` gained `assetId`.** The strip needs to know which tiles are
already in the note, and asset id is the only identity a camera-roll photo
and a composer attachment share. `ImagePicker` reports the same id, so a
photo added through the **+** button also shows up checked in the strip —
one model, not two.

**Bytes are read on tap, not on send.** `getAssetInfoAsync` can trigger an
iCloud download, so the tile spins until real bytes exist and only then joins
the attachment row. Reading at send time would have made a send fail for a
reason that happened minutes earlier and nowhere the user was looking.

**`readPhotoAsAttachment` still sniffs the result's magic bytes** even though
`saveAsync({format: JPEG})` promises JPEG. Same scar tissue as
`lib/attachments.ts`: the label picks the uploaded file's extension, and the
server's converter picks by extension.
