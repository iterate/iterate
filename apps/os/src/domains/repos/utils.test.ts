import { describe, expect, test } from "vitest";
import {
  countOccurrences,
  isConcurrentPushRejection,
  replaceLiteralOccurrences,
} from "./edit-utils.ts";
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

describe("isConcurrentPushRejection", () => {
  test("recognizes the Artifacts server's stale-ref GitPushError", () => {
    // Shape observed in preview e2e when concurrent example-matrix writers race
    // on refs/heads/main (run-044 of the flake hunt).
    const error = Object.assign(new Error("\n  - refs/heads/main: stale ref"), {
      code: "GitPushError",
      name: "GitPushError",
      data: {
        ok: true,
        refs: { "refs/heads/main": { ok: false, error: "stale ref" } },
      },
    });
    expect(isConcurrentPushRejection(error)).toBe(true);
  });

  test("recognizes a not-fast-forward PushRejectedError by code", () => {
    const error = Object.assign(new Error("push rejected"), {
      code: "PushRejectedError",
      name: "PushRejectedError",
    });
    expect(isConcurrentPushRejection(error)).toBe(true);
  });

  test("recognizes a not-fast-forward rejection surfaced only in the message", () => {
    expect(
      isConcurrentPushRejection(
        new Error("Push rejected because it was not a simple fast-forward"),
      ),
    ).toBe(true);
  });

  test("does not retry unrelated errors", () => {
    expect(isConcurrentPushRejection(new Error("Repo file does not exist: notes/x.md."))).toBe(
      false,
    );
    expect(
      isConcurrentPushRejection(
        Object.assign(new Error("boom"), { code: "SomeOtherError", data: { refs: {} } }),
      ),
    ).toBe(false);
    expect(isConcurrentPushRejection("stale ref")).toBe(false);
    expect(isConcurrentPushRejection(null)).toBe(false);
  });
});
