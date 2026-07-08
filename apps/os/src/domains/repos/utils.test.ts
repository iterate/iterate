import { describe, expect, test } from "vitest";
import { countOccurrences, replaceLiteralOccurrences } from "./edit-utils.ts";
import { RepoArtifactNameCodec, base64ToBytes, bytesToBase64 } from "./utils.ts";

describe("RepoArtifactNameCodec", () => {
  test("round-trips project-scoped repo paths", () => {
    expect(RepoArtifactNameCodec.stringify({ projectId: "prj_123", path: "/" })).toBe(
      "prj_123--Lw",
    );
    expect(RepoArtifactNameCodec.parse("prj_123--Lw")).toEqual({
      path: "/",
      projectId: "prj_123",
    });

    const name = RepoArtifactNameCodec.stringify({
      path: "/features/a b",
      projectId: "prj_with-hyphens",
    });
    expect(RepoArtifactNameCodec.parse(name)).toEqual({
      path: "/features/a b",
      projectId: "prj_with-hyphens",
    });
  });

  test("round-trips global repo paths", () => {
    expect(RepoArtifactNameCodec.stringify({ projectId: null, path: "/" })).toBe("global--Lw");
    expect(RepoArtifactNameCodec.parse("global--Lw")).toEqual({
      path: "/",
      projectId: null,
    });
    expect(() => RepoArtifactNameCodec.stringify({ projectId: "global", path: "/" })).toThrow(
      /reserved/,
    );
  });
});

describe("repo binary base64 lane", () => {
  test("round-trips bytes a utf8 decode would corrupt", () => {
    // PNG magic followed by invalid-utf8 continuation bytes.
    const bytes = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x80,
    ]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  test("rejects junk base64 with a caller-friendly error", () => {
    expect(() => base64ToBytes("not base64!!!")).toThrow(/contentBase64 must be valid base64/);
  });
});

describe("repo edit helpers", () => {
  test("counts non-overlapping occurrences", () => {
    expect(countOccurrences("one two one", "one")).toBe(2);
    expect(countOccurrences("aaaa", "aa")).toBe(2);
    expect(countOccurrences("unchanged", "missing")).toBe(0);
  });

  test("replaces newString literally instead of as a JavaScript replacement template", () => {
    expect(
      replaceLiteralOccurrences({
        content: "const value = ORIGINAL;",
        oldString: "ORIGINAL",
        newString: "$& $1 $$",
      }),
    ).toBe("const value = $& $1 $$;");
  });
});
