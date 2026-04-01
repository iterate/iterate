const INITIAL_EVENT_OFFSET_WIDTH = 16;

/**
 * Offsets are fixed-width decimal strings so lexicographic ordering matches
 * append order in SQLite and over the wire.
 */
export function getNextEventOffset(offset: string | null) {
  if (offset == null) {
    return "0".padStart(INITIAL_EVENT_OFFSET_WIDTH, "0");
  }

  if (!/^\d+$/.test(offset)) {
    throw new Error(`Cannot generate the next event offset after non-numeric offset ${offset}.`);
  }

  const width = Math.max(offset.length, INITIAL_EVENT_OFFSET_WIDTH);
  return (BigInt(offset) + 1n).toString().padStart(width, "0");
}

/**
 * The next offset a caller may guard against when appending a real event.
 * An untouched stream reserves offset 0 for its synthetic self-initialized event,
 * so the first caller-appended event starts at offset 1.
 */
export function getNextAppendEventOffset(args: {
  initialized: boolean;
  lastOffset: string | null;
}) {
  if (!args.initialized) {
    return "1".padStart(INITIAL_EVENT_OFFSET_WIDTH, "0");
  }

  return getNextEventOffset(args.lastOffset);
}
