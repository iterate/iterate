---
state: in-progress
size: small
---

# Mobile media niggles

Three small fixes for the Media screen, from dogfooding in prod (2026-08-12).

**Status:** all three fixes implemented with tests; running repo checks.
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

## Implementation log

- Sniffing lives in a new pure module (image-format.ts) rather than media.ts:
  it's about picked payloads, not the capture pipeline, and attachments.ts
  (chat composer) benefits too — both callers of `pickImages` now get
  bytes-derived contentTypes.
- Deliberately NOT gating chat attachments on HEIC: chat has no toMarkdown
  step; mislabeling was the shared bug and that part is fixed for both.
- media-sync.ts (screenshots album) untouched — screenshots are PNGs and its
  filename-extension trust has not misfired.
