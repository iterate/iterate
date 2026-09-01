// lib/hash.ts — THE content hash (djb2), shared by every loader call site: cache keys and facet
// version markers must change exactly when source changes, and two spellings of the same hash
// would eventually disagree.

/** djb2 — a stable content hash so loader cache keys change when source changes. */
export function hashSource(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
