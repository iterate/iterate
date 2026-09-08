import { diff } from "@codemirror/merge";

/** Preserve unchanged text between edits so concurrent typing rebases in place. */
export function textEdits(source: string, next: string) {
  return diff(source, next).map(({ fromA, toA, fromB, toB }) => ({
    from: fromA,
    to: toA,
    insert: next.slice(fromB, toB),
  }));
}
