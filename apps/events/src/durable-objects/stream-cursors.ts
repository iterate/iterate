import type { StreamCursor } from "@iterate-com/events-contract";

/**
 * Converts public stream cursors into the half-open SQLite offset range used
 * by the generated `history` query: offset > afterOffset and offset < beforeOffset.
 *
 * If callers ask for events after the current end and there are no newer
 * events, `history()` returns an empty list and callers can keep their existing
 * cursor. The stream itself always has at least the initialized event once it
 * exists, but uninitialized helper paths still call `historyIfInitialized()`.
 */
export function resolveStreamRange(args: {
  after?: StreamCursor;
  before?: StreamCursor;
  endOffset: number;
}) {
  return {
    afterOffset: resolveAfterCursor(args.after, args.endOffset),
    beforeOffset: resolveBeforeCursor(args.before, args.endOffset),
  };
}

function resolveAfterCursor(cursor: StreamCursor | undefined, endOffset: number) {
  if (cursor == null || cursor === "start") {
    return 0;
  }

  if (cursor === "end") {
    return endOffset;
  }

  return cursor;
}

function resolveBeforeCursor(cursor: StreamCursor | undefined, endOffset: number) {
  if (cursor == null || cursor === "end") {
    return endOffset + 1;
  }

  if (cursor === "start") {
    return 1;
  }

  return cursor;
}
