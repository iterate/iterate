// Filter metadata that is safe to import from the NATIVE bundle: the ✨
// picker needs ids, labels and chip emoji — and must not pull in the draw
// functions, which carry megabytes of generated image/wasm data that belongs
// only in the filter-camera DOM (WebView) bundle. definitions.ts asserts
// every picker id has a drawer.

export const FILTER_PICKER = [
  { id: "potato", label: "Potato", emoji: "🥔" },
  { id: "eyes-lips", label: "Eyes & lips", emoji: "👄" },
  { id: "cat", label: "Cat", emoji: "🐱" },
  { id: "flashcards", label: "Flashcards", emoji: "🍎" },
];

/** Filtered recordings are re-encoded on-canvas and cross the WebView bridge
 * as one base64 message, so they stay shorter than plain camera clips. Both
 * sides of the bridge read this. */
export const FILTERED_CLIP_MAX_SECONDS = 30;
