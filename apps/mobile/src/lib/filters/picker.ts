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
  { id: "sing", label: "Sing", emoji: "🎤" },
  { id: "face-drop", label: "Face drop", emoji: "🫥" },
  { id: "paper-toss", label: "Paper toss", emoji: "🗑️" },
];
