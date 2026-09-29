// Merging a commit someone else made into the text being edited, the way git merges: ours and
// theirs both changed base. The result goes into the live text as small edits, so people typing
// elsewhere in the doc, even in the same sentence, keep their keystrokes.
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

/** The edits that turn `from` into `to`, in order, each position in the text as the edits before
 *  it left it: what a `Y.Text` applies one by one. */
export function textEdits(from: string, to: string) {
  const edits: ({ at: number; insert: string } | { at: number; delete: number })[] = [];
  let at = 0;
  for (const part of diffChars(from, to)) {
    if (part.added) {
      edits.push({ at, insert: part.value });
      at += part.value.length;
    } else if (part.removed) edits.push({ at, delete: part.value.length });
    else at += part.value.length;
  }
  return edits;
}
