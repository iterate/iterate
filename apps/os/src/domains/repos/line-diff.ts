/**
 * Line-level diff stats for the repo history lanes (`repo.commitDetails`) —
 * `git diff --numstat`-shaped +/- counts computed from file contents, plus
 * git's binary sniff. A tree diff needs only the COUNTS (the readonly diff
 * view renders content client-side), so this is a Myers O(ND) edit-distance
 * pass over lines, not a full edit-script diff — no dependency needed.
 *
 * One DELIBERATE divergence from git: a change that only adds or removes a
 * trailing newline counts 0/0 here, where git reports 1/1 (it treats the
 * unterminated final line as changed). Both sides split to the same lines,
 * and "you terminated the file" reading as a rewrite of the last line is
 * noise for this UI's purposes.
 */

import type { RepoCommitFileChange } from "./types.ts";

/** git's binary heuristic: a NUL byte within the first 8000 bytes. */
export function isBinaryBytes(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8000);
  for (let index = 0; index < limit; index++) {
    if (bytes[index] === 0) return true;
  }
  return false;
}

/**
 * `git diff --numstat`-shaped line counts between two texts: the minimal
 * number of added and removed lines (Myers edit distance over lines, with
 * common prefix/suffix trimmed first so ordinary edits stay tiny). Not exact
 * numstat parity — see the module docstring for the deliberate
 * trailing-newline divergence.
 */
export function computeLineDiffStats(
  oldText: string,
  newText: string,
): { additions: number; deletions: number } {
  const oldAll = splitLines(oldText);
  const newAll = splitLines(newText);

  let start = 0;
  while (start < oldAll.length && start < newAll.length && oldAll[start] === newAll[start]) start++;
  let oldEnd = oldAll.length;
  let newEnd = newAll.length;
  while (oldEnd > start && newEnd > start && oldAll[oldEnd - 1] === newAll[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const oldLines = oldAll.slice(start, oldEnd);
  const newLines = newAll.slice(start, newEnd);

  // Myers worst case is O((N+M)²) when the sides share nothing; past this
  // budget the honest-enough answer is "rewrite" (what git's own rename/huge
  // heuristics degrade to), not a multi-second stall inside a Durable Object.
  const MAX_DIFF_LINES = 4000;
  if (oldLines.length + newLines.length > MAX_DIFF_LINES) {
    return { additions: newLines.length, deletions: oldLines.length };
  }

  const distance = shortestEditDistance(oldLines, newLines);
  const lcs = (oldLines.length + newLines.length - distance) / 2;
  return { additions: newLines.length - lcs, deletions: oldLines.length - lcs };
}

/**
 * Changed files between two trees given as path → raw bytes maps: status per
 * path, +/- line counts for text files, `binary: true` (0/0) when either
 * side sniffs binary. The `repo.commitDetails` core, pure so it unit-tests
 * without a git checkout.
 */
export function diffFileMaps(
  oldFiles: Map<string, Uint8Array>,
  newFiles: Map<string, Uint8Array>,
): RepoCommitFileChange[] {
  const paths = [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort();
  const stats: RepoCommitFileChange[] = [];
  const decoder = new TextDecoder();

  for (const path of paths) {
    const oldBytes = oldFiles.get(path);
    const newBytes = newFiles.get(path);

    if (oldBytes && newBytes && bytesEqual(oldBytes, newBytes)) {
      continue;
    }
    const binary =
      (!!oldBytes && isBinaryBytes(oldBytes)) || (!!newBytes && isBinaryBytes(newBytes));
    const counts = binary
      ? { additions: 0, deletions: 0 }
      : computeLineDiffStats(
          !oldBytes ? "" : decoder.decode(oldBytes),
          !newBytes ? "" : decoder.decode(newBytes),
        );
    const status = !oldBytes ? "added" : !newBytes ? "deleted" : "modified";
    stats.push({ path, status, binary, ...counts });
  }
  return stats;
}

/** Git-shaped line split: "a\nb\n" and "a\nb" are both two lines; "" is zero. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Myers O(ND) shortest edit distance over two line arrays. */
function shortestEditDistance(a: string[], b: string[]): number {
  const max = a.length + b.length;
  if (max === 0) return 0;
  const offset = max;
  // v[offset + k] = furthest x reached on diagonal k with the current d.
  const v = new Array<number>(2 * max + 1).fill(0);
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]! // down: a deletion from b's perspective (insertion)
          : v[offset + k - 1]! + 1; // right: a deletion from a
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= a.length && y >= b.length) return d;
    }
  }
  return max;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}
