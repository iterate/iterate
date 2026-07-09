import { describe, expect, test } from "vitest";
import { computeLineDiffStats, diffFileMaps, isBinaryBytes } from "./line-diff.ts";

const encode = (text: string) => new TextEncoder().encode(text);

describe("computeLineDiffStats", () => {
  test("matches git numstat for plain edits", () => {
    // git diff --numstat reports 1 added, 1 removed for a changed line.
    expect(computeLineDiffStats("a\nb\nc\n", "a\nB\nc\n")).toEqual({ additions: 1, deletions: 1 });
    // pure insertion / pure removal
    expect(computeLineDiffStats("a\nc\n", "a\nb\nc\n")).toEqual({ additions: 1, deletions: 0 });
    expect(computeLineDiffStats("a\nb\nc\n", "a\nc\n")).toEqual({ additions: 0, deletions: 1 });
  });

  test("counts whole files for creations and deletions", () => {
    expect(computeLineDiffStats("", "one\ntwo\n")).toEqual({ additions: 2, deletions: 0 });
    expect(computeLineDiffStats("one\ntwo\n", "")).toEqual({ additions: 0, deletions: 2 });
    expect(computeLineDiffStats("", "")).toEqual({ additions: 0, deletions: 0 });
  });

  test("ignores trailing-newline-only changes (deliberate divergence from git)", () => {
    // Real git reports 1/1 for "a\nb" → "a\nb\n" (the unterminated final line
    // counts as changed); we deliberately count 0/0 — both sides split to the
    // same lines, and newline termination alone is noise for the history UI.
    // See the module docstring in line-diff.ts.
    expect(computeLineDiffStats("a\nb", "a\nb\n")).toEqual({ additions: 0, deletions: 0 });
    expect(computeLineDiffStats("a\nb", "a\nc")).toEqual({ additions: 1, deletions: 1 });
  });

  test("finds minimal counts when lines move apart (not naive rewrite)", () => {
    // Only "x" was inserted; the surrounding lines still match.
    expect(computeLineDiffStats("a\nb\nc\nd\n", "a\nx\nb\nc\nd\n")).toEqual({
      additions: 1,
      deletions: 0,
    });
    // Interleaved edit: replace b->x and e->y, keep a/c/d.
    expect(computeLineDiffStats("a\nb\nc\nd\ne\n", "a\nx\nc\nd\ny\n")).toEqual({
      additions: 2,
      deletions: 2,
    });
  });

  test("degrades to rewrite counts past the size budget instead of stalling", () => {
    const oldText = Array.from({ length: 3000 }, (_, index) => `old ${index}`).join("\n");
    const newText = Array.from({ length: 3000 }, (_, index) => `new ${index}`).join("\n");
    expect(computeLineDiffStats(oldText, newText)).toEqual({ additions: 3000, deletions: 3000 });
  });
});

describe("isBinaryBytes", () => {
  test("sniffs NUL bytes as binary, text as text", () => {
    expect(isBinaryBytes(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))).toBe(true);
    expect(isBinaryBytes(encode("just text\nwith lines\n"))).toBe(false);
    expect(isBinaryBytes(new Uint8Array(0))).toBe(false);
  });
});

describe("diffFileMaps", () => {
  test("reports added/modified/deleted with counts and skips identical files", () => {
    const parent = new Map([
      ["unchanged.txt", encode("same\n")],
      ["modified.txt", encode("a\nb\nc\n")],
      ["deleted.txt", encode("bye\nbye\n")],
    ]);
    const commit = new Map([
      ["unchanged.txt", encode("same\n")],
      ["modified.txt", encode("a\nB\nc\n")],
      ["added.txt", encode("hi\n")],
    ]);

    expect(diffFileMaps(parent, commit)).toEqual([
      { path: "added.txt", status: "added", additions: 1, deletions: 0, binary: false },
      { path: "deleted.txt", status: "deleted", additions: 0, deletions: 2, binary: false },
      { path: "modified.txt", status: "modified", additions: 1, deletions: 1, binary: false },
    ]);
  });

  test("flags binary files with zero counts", () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    const png2 = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    expect(diffFileMaps(new Map(), new Map([["pixel.png", png]]))).toEqual([
      { path: "pixel.png", status: "added", additions: 0, deletions: 0, binary: true },
    ]);
    expect(diffFileMaps(new Map([["pixel.png", png]]), new Map([["pixel.png", png2]]))).toEqual([
      { path: "pixel.png", status: "modified", additions: 0, deletions: 0, binary: true },
    ]);
  });

  test("root commit shape: every file added", () => {
    const commit = new Map([["readme.md", encode("# hello\n\nworld\n")]]);
    expect(diffFileMaps(new Map(), commit)).toEqual([
      { path: "readme.md", status: "added", additions: 3, deletions: 0, binary: false },
    ]);
  });
});
