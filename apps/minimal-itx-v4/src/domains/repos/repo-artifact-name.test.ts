import { describe, expect, test } from "vitest";
import { RepoArtifactNameCodec } from "./repo-artifact-name.ts";

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
