# Filter assets

JavaScript stays in the app bundle: JavaScriptCore on iPhone, Expo DOM in the
browser/Android camera. Artwork, the pinned browser MediaPipe WASM, and its
face model live at `https://mobile.iterate.com/filter-assets/<slug>-<sha256>.<ext>`.
The existing mobile website worker serves only that public prefix from its
R2 bucket. No new runtime dependency or OS service is involved

iPhone uses Apple's Vision tracker and does not download the MediaPipe files.
The browser/Android tracker downloads when filters open (~6.6 MB compressed).
Images load when the current filter/card draws them. Flashcards preload the next
three cards in the current shuffled deck and style through the same cache;
colour swatches need no download. Preloads do not delay capture or show errors
until their card is selected. iPhone decodes images up to
1,024 pixels on the longest side. A spinner stays outside the captured image.
The normal shutter waits for those images; failed downloads expose Retry,
with a 30-second download limit. Browser HTTP caching and decoded image
reuse help repeat use; a fresh install or evicted cache needs a connection.

Prefixes describe the art (`animal-cat`, `backdrop-potato-dirt`,
`cartoon-dog`, `encyclopaedia-dog`) or tracker (`mediapipe-vision`,
`face-landmarker`). The full SHA-256 remains the version identifier.
Hash-only URLs from older app builds stay served.

URLs never change their contents. The worker sends anonymous CORS headers so
file-origin WebViews can fetch data and save canvases containing remote images.
Gzip binaries have `application/gzip`, without `Content-Encoding`: the app
explicitly decompresses them before passing bytes/blob URLs to MediaPipe.

## Updating art or MediaPipe

1. Run `pnpm generate-filters <command>` from `apps/mobile` (see the script for
   credentials). Existing art is kept. New binary files go in
   `website/filter-assets/`; generated TypeScript records contain URLs only.
2. For a MediaPipe upgrade, update the package and its patch together, then
   run `node scripts/generate-mediapipe-assets.mjs` from `apps/mobile`.
   It reads the installed package's loader/WASM and the pinned Google model.
3. Commit the binary files and generated manifests together.
4. **Before publishing an OTA with new URLs**, run
   `pnpm --dir apps/mobile/website run deploy --env prd` from the repo root.
   Deployment verifies hashes, uploads missing files, deploys the worker, and
   smoke-tests an asset. Main's existing website deploy workflow does this too.

Retain published R2 hashes indefinitely: older app versions still use them.
The publisher never deletes objects. Files can be removed from the checkout
when no current manifest uses them; that does not remove their hosted copies.
