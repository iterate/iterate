import { describe, expect, test } from "vitest";
import { countOccurrences, replaceLiteralOccurrences } from "./edit-utils.ts";
import { RepoArtifactNameCodec } from "./utils.ts";

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
