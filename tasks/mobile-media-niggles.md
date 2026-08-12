---
state: in-progress
size: small
---

# Mobile media niggles

Three small fixes for the Media screen, from dogfooding in prod (2026-08-12).

**Status:** spec committed, implementation starting.

## Problems & plan

### 1. HEIC photos fail capture

Picking a photo produced `toMarkdown failed for IMG_3732.heic: Unsupported file type`.

Root cause: `pickImages` (apps/mobile/src/lib/attachments.ts) trusts
`asset.mimeType` (`image/heic` on iOS), `normalizedImageFilename` derives the
extension from that contentType, and server-side `itx.ai.toMarkdown` picks its
converter from the extension — HEIC unsupported. The `quality: 0.8` comment
claims recompression to JPEG/PNG; evidently not reliable.

Constraint: no new native modules (must ship OTA — expo-image-manipulator is out).

- [ ] Add a pure magic-byte sniffing function (JPEG `FFD8FF`, PNG `89504E47`,
      GIF, WebP, HEIC `ftyp` brands at offset 4) that reads the head of the
      base64 payload; use the sniffed format — not `asset.mimeType` — for
      contentType and filename. If iOS re-encoded to JPEG and only mislabeled,
      this alone fixes it.
- [ ] Pass `preferredAssetRepresentationMode: 'compatible'` to
      `launchImageLibraryAsync` so PHPicker transcodes HEIC→JPEG (verify exact
      API in installed expo-image-picker).
- [ ] If the payload is still genuinely HEIC after both, fail that item with a
      clear actionable error instead of uploading bytes doomed to fail
      server-side.
- [ ] Vitest coverage for the sniffing function.

### 2. Pull-to-refresh clears stale pending cards

Errored/skipped pending cards are sticky component state (`pending` in
media.tsx) — verified in prod that items whose cards still showed errors had
been captured fine by later sync passes.

- [ ] Stock iOS `RefreshControl` on the FlatList: on pull, refetch the media
      events query and clear pending cards not actively in flight
      (waiting/analyzing stay).

### 3. Original filename invisible after capture

`payload.filename` (IMG_1234.PNG) appears nowhere on a successful row.

- [ ] Show it as faint small text in the expanded row detail (after the
      transcript); judge whether it also fits the collapsed meta row without
      crowding.

## Implementation log

- (empty)
