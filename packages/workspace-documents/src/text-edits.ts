import { diff } from "@codemirror/merge";

const DIFF_CONFIG = { scanLimit: 10_000, timeout: 50 };

/** Preserve unchanged text between edits so concurrent typing rebases in place. */
export function textEdits(source: string, next: string) {
  return diff(source, next, DIFF_CONFIG).map(({ fromA, toA, fromB, toB }) => ({
    from: fromA,
    to: toA,
    insert: next.slice(fromB, toB),
  }));
}
