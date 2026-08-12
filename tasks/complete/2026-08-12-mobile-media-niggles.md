---
state: in-progress
size: small
---

# Mobile media niggles

Three small fixes for the Media screen, from dogfooding in prod (2026-08-12).

**Status:** done pending review — PR #2481 now ALSO carries the pipeline
split from tasks/media-uploaded-event.md (branch media-uploaded-event merged
in here; PR #2482 closed as superseded). This file covers only the niggles +
toolbar rework. Original three fixes plus Misha's follow-up (declutter the
controls: ⋯ options button, no inline Sync now, clearer delete-all copy).
Typecheck, lint, knip, format, and the full apps/mobile vitest suite pass
locally.
Main pieces: byte-sniffing (`lib/image-format.ts`) + `compatible` picker
representation + phone-side HEIC gate; stock RefreshControl on the list;
filename in expanded row detail. Nothing known missing.

## Problems & plan

### 1. HEIC photos fail capture

Picking a photo produced `toMarkdown failed for IMG_3732.heic: Unsupported file type`.

Root cause: `pickImages` (apps/mobile/src/lib/attachments.ts) trusts
`asset.mimeType` (`image/heic` on iOS), `normalizedImageFilename` derives the
extension from that contentType, and server-side `itx.ai.toMarkdown` picks its
converter from the extension — HEIC unsupported. The `quality: 0.8` comment
claims recompression to JPEG/PNG; evidently not reliable.

Constraint: no new native modules (must ship OTA — expo-image-manipulator is out).

- [x] Add a pure magic-byte sniffing function (JPEG `FFD8FF`, PNG `89504E47`,
      GIF, WebP, HEIC `ftyp` brands at offset 4) that reads the head of the
      base64 payload; use the sniffed format — not `asset.mimeType` — for
      contentType and filename. If iOS re-encoded to JPEG and only mislabeled,
      this alone fixes it. _`sniffImageContentType` in
      apps/mobile/src/lib/image-format.ts; wired into `pickImages` as
      `sniffed || asset.mimeType || "image/jpeg"`._
- [x] Pass `preferredAssetRepresentationMode: 'compatible'` to
      `launchImageLibraryAsync` so PHPicker transcodes HEIC→JPEG (verify exact
      API in installed expo-image-picker). _expo-image-picker 17.0.11:
      `UIImagePickerPreferredAssetRepresentationMode.Compatible` enum, iOS 14+._
- [x] If the payload is still genuinely HEIC after both, fail that item with a
      clear actionable error instead of uploading bytes doomed to fail
      server-side. _`unsupportedImageReason` (heic/heif/avif) checked in the
      capture mutation before hashing; the pending card shows the message._
- [x] Vitest coverage for the sniffing function. _image-format.test.ts —
      magic-byte matrix, ftyp brands, short/garbage/whitespace payloads._

### 2. Pull-to-refresh clears stale pending cards

Errored/skipped pending cards are sticky component state (`pending` in
media.tsx) — verified in prod that items whose cards still showed errors had
been captured fine by later sync passes.

- [x] Stock iOS `RefreshControl` on the FlatList: on pull, refetch the media
      events query and clear pending cards not actively in flight
      (waiting/analyzing stay). _`refreshing={events.isRefetching}` — no new
      state; the spinner is the query's own refetch._

### 3. Original filename invisible after capture

`payload.filename` (IMG_1234.PNG) appears nowhere on a successful row.

- [x] Show it as faint small text in the expanded row detail (after the
      transcript); judge whether it also fits the collapsed meta row without
      crowding. _Expanded detail only (textFaint, 11pt, selectable) — the
      collapsed meta row already carries tags + right-aligned date; a
      filename there fights the date for the same edge._

### 4. Follow-up: declutter the control area (Misha, after first review)

The Off/On settings row, "+ Add", and "Sync now" sat too close together.

- [x] Replace the full-width "Auto-collect screenshots … ›" row with a ⋯
      "more options" button in the toolbar (same height as + Add, bordered,
      quiet); it opens the existing dialog. _`moreButton` next to + Add;
      accessibilityLabel "Media options"._
- [x] Fold the row's information into the status line: sync summary now ends
      with "· back to <date>", and shows "Auto-collect on · back to <date>"
      before the first pass. No line at all when off. _`syncSummary(result,
      sinceIso)`; window info last so truncation drops it first._
- [x] Remove the inline "Sync now" button; pull-to-refresh now ALSO kicks a
      sync pass when auto-collect is on (reverses the earlier
      deliberate exclusion), and the dialog gains an explicit "Sync now"
      button. _RefreshControl handler refetches syncPass; spinner still
      tracks only the event reread since a pass can run minutes and reports
      through the status line._
- [x] Make delete-all clearly project-only. _Link: "Delete all media from
      this project…"; warning adds "Photos on your phone are untouched."_

## Implementation log

- Sniffing lives in a new pure module (image-format.ts) rather than media.ts:
  it's about picked payloads, not the capture pipeline, and attachments.ts
  (chat composer) benefits too — both callers of `pickImages` now get
  bytes-derived contentTypes.
- Deliberately NOT gating chat attachments on HEIC: chat has no toMarkdown
  step; mislabeling was the shared bug and that part is fixed for both.
- media-sync.ts (screenshots album) untouched — screenshots are PNGs and its
  filename-extension trust has not misfired.
- Post-merge with media-uploaded-event: pending cards say "Uploading…" (the
  slow analysis half moved server-side), the pull-to-refresh filter keeps
  waiting/uploading cards, and the HEIC gate's "doomed server-side" rationale
  still holds — the server analysis pipeline calls toMarkdown the same way.
- Post-review nit (Misha): rows re-sorted as parallel uploads landed (list
  was offset-ordered = upload-completion order). deriveMediaList now sorts
  by the ORIGINAL image's date — payload.capturedAt, falling back to the
  event's stream time for dateless picker items — with offset as the exact-
  tie break; pending cards sort by the same key (capturedAt threaded through
  SyncCandidate/PendingItem; dateless picks count as newest), so a card
  resolving into a row keeps its place.
- Ordering round 2: date-sorting each zone wasn't enough — the pending
  header block above the rows meant every upload completion jumped the item
  across the zone boundary. deriveMediaFeed (lib/media.ts) now interleaves
  cards and rows into ONE FlatList on the shared original-date key; cards
  carry their stableKey so the derived row takes over the card's position
  AND React key in place (no vanish-reappear gap — the removal-on-success
  callbacks are gone, visibility is derived), while terminal skipped/error
  cards keep their own preview-keyed entries alongside rows.
- Ordering round 3 (on-device feedback): positions were stable but the
  card→row morph degraded content — blank thumbnail (signed URL still
  loading), no filename, "mostly empty" rows. A session-scoped
  stableKey→previewUri map (ref in media.tsx) now outlives the card so the
  row shows the local preview until the signed URL loads, and analyzing rows
  show the filename line in the card's own style. Height audit: card and row
  are both bound by the 96pt thumb — the "tall empty" read was those two
  content holes, not reserved space.
