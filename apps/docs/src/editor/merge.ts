// Merging a commit someone else made into the text being edited, the way git merges: ours and
// theirs both changed base. The result goes into the editor as small edits, so the cursor and the
// undo history survive everywhere the other commit didn't touch.
import { diffChars } from "diff";
import { diff3Merge } from "node-diff3";

/** ours + theirs over base, line by line. Where both changed the same lines, ours stays: a doc
 *  never shows conflict markers. `conflicts` says how many places that happened. */
export function mergeText(ours: string, base: string, theirs: string) {
  const regions = diff3Merge(ours.split("\n"), base.split("\n"), theirs.split("\n"), {
    excludeFalseConflicts: true,
  });
  return {
    text: regions.flatMap((region) => region.ok || region.conflict!.a).join("\n"),
    conflicts: regions.filter((region) => region.conflict).length,
  };
}

/** The edits that turn `from` into `to`, positions in `from` (CodeMirror's `changes` shape). */
export function textChanges(from: string, to: string) {
  const changes: { from: number; to?: number; insert?: string }[] = [];
  let at = 0;
  for (const part of diffChars(from, to)) {
    if (part.added) changes.push({ from: at, insert: part.value });
    else if (part.removed) {
      changes.push({ from: at, to: at + part.value.length });
      at += part.value.length;
    } else at += part.value.length;
  }
  return changes;
}
