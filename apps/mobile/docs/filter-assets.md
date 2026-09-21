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

## Updating art

Git stores the prompts/settings in `scripts/generate-filters.ts` and small JSON
manifests in `src/lib/filters/*.generated.json`. Images live only in R2.
From `apps/mobile`:

```sh
pnpm generate-filters all
pnpm generate-filters all --slug cartoon-dog
pnpm generate-filters all --slug animal-cat --force
```

The script loads `os/prd` credentials through Doppler. Each selected image:

1. Checks its manifest URL directly in R2. If present, it does nothing: no
   local file, AI key or generation charge is needed.
2. If missing (or `--force`), generates from the checked-in recipe, uploads
   under `<slug>-<sha256>.<ext>`, then atomically updates the manifest.
3. Keeps successful progress if a later image fails. Authentication/network
   failures stop the run; they do not count as missing images.

Commit the changed prompts/manifests and review the new art before publishing
an app update. Changing a prompt alone does not replace approved art; use
`--force`. Regeneration is nondeterministic and costs AI credits.
Image resizing currently uses macOS `sips`. Run one generator at a time in a
checkout; it updates that checkout's manifests.

Animal entries keep their eye/mouth coordinates beside the URL. Regeneration
runs the vision pass before publishing that entry. Verify new coordinates with
the harness `?annotate=1` view and correct them in the JSON manifest as needed.
The current hand-corrected coordinates were preserved during migration.

Individual commands still work: `backdrops`, `animals`, and
`flashcards --style cartoon|encyclopaedia|photo`, each with `--slug`/`--force`.
The optional Unsplash `photo` deck stays empty unless explicitly generated;
it needs `UNSPLASH_ACCESS_KEY`. Other art uses `OPENAI_API_KEY`.

## Updating MediaPipe and deploying

For a MediaPipe upgrade, update the package and its patch together, then run
`pnpm exec tsx scripts/generate-mediapipe-assets.ts` from `apps/mobile`.
It reads the installed loader/WASM and pinned Google model, uploads missing
compressed data, then updates the TypeScript manifest. JavaScript stays bundled.

Before publishing an app update with changed manifests, run
`pnpm generate-filters verify` from `apps/mobile`. It checks every image and
tracker URL directly in R2 without generating or uploading anything.

General website deployment is independent of filter assets: a missing flashcard
must not block an installer-site fix. The worker route must be deployed before
releasing the first app build using these URLs; subsequent artwork changes need
only the manual upload, verification and manifest update.

Retain published R2 hashes indefinitely: older app versions still use them.
The scripts never delete objects. Prompts let us replace lost art, not reproduce
identical bytes or restore an old URL; protect the bucket accordingly.

The one-time migration verified all 218 existing objects byte-for-byte before
removing the binaries from Git. All current URLs and artwork are unchanged.
