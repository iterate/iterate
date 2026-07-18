import { InMemoryFs } from "@cloudflare/shell";
import { createGit } from "@cloudflare/shell/git";
import { describe, expect, test } from "vitest";
import { countOccurrences, replaceLiteralOccurrences } from "./edit-utils.ts";
import {
  RepoArtifactNameCodec,
  RepoNotSeededError,
  base64ToBytes,
  bytesToBase64,
  classifyRepoAccessError,
  gitBranchContainsCommit,
  isRepoNotSeededError,
} from "./utils.ts";

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

describe("classifyRepoAccessError", () => {
  test("wraps isomorphic-git's missing-ref clone failure (the unseeded-remote shape)", () => {
    // What an empty Artifacts remote actually produces: the server answers
    // HEAD with a branch that has no commits, and isomorphic-git's clone
    // fails resolving it (observed verbatim during every prd bootstrap).
    const raw = Object.assign(new Error("Could not find refs/heads/master."), {
      code: "NotFoundError",
    });
    const classified = classifyRepoAccessError(raw);
    expect(classified).toBeInstanceOf(RepoNotSeededError);
    expect(isRepoNotSeededError(classified)).toBe(true);
    expect((classified as Error).message).toContain("refs/heads/master");
    expect((classified as Error).cause).toBe(raw);
  });

  test("wraps a missing Artifacts repo (NOT_FOUND — the pre-createArtifactRepo window)", () => {
    const raw = Object.assign(new Error("repo not found"), { code: "NOT_FOUND" });
    expect(isRepoNotSeededError(classifyRepoAccessError(raw))).toBe(true);
  });

  test.each(["IMPORT_IN_PROGRESS", "FORK_IN_PROGRESS"])(
    "wraps an Artifacts repo that is still being materialized (%s)",
    (code) => {
      const raw = Object.assign(new Error("repository is currently being created"), { code });
      expect(isRepoNotSeededError(classifyRepoAccessError(raw))).toBe(true);
    },
  );

  test("wraps an explicitly requested branch missing from an empty Artifacts repo", () => {
    const raw = Object.assign(new Error("Could not find main."), {
      code: "NotFoundError",
    });

    expect(isRepoNotSeededError(classifyRepoAccessError(raw, "main"))).toBe(true);
    expect(classifyRepoAccessError(raw)).toBe(raw);
  });

  test("passes every other failure through unchanged", () => {
    const network = new Error("fetch failed");
    expect(classifyRepoAccessError(network)).toBe(network);
    // A NotFoundError about something other than a ref (a missing object id)
    // is repo corruption or a bad caller input, not the unseeded window.
    const object = Object.assign(new Error("Could not find deadbeef."), {
      code: "NotFoundError",
    });
    expect(classifyRepoAccessError(object)).toBe(object);
    expect(classifyRepoAccessError(undefined)).toBe(undefined);
    expect(classifyRepoAccessError("string error")).toBe("string error");
  });

  test("isRepoNotSeededError matches by name, the only identity that survives Workers RPC", () => {
    expect(
      isRepoNotSeededError(Object.assign(new Error("x"), { name: "RepoNotSeededError" })),
    ).toBe(true);
    expect(isRepoNotSeededError(new Error("x"))).toBe(false);
    expect(isRepoNotSeededError(null)).toBe(false);
  });
});

describe("gitBranchContainsCommit", () => {
  test("accepts a newer descendant beyond git.log's default depth", async () => {
    const filesystem = new InMemoryFs();
    const git = createGit(filesystem, "/repo");
    await git.init({ defaultBranch: "main" });
    await filesystem.writeFile("/repo/value.txt", "root");
    await git.add({ filepath: "value.txt" });
    const root = await git.commit({
      author: { email: "test@iterate.com", name: "Test" },
      message: "root",
    });

    for (let index = 1; index <= 40; index += 1) {
      await filesystem.writeFile("/repo/value.txt", String(index));
      await git.add({ filepath: "value.txt" });
      await git.commit({
        author: { email: "test@iterate.com", name: "Test" },
        message: `commit ${index}`,
      });
    }

    await expect(
      gitBranchContainsCommit({ branch: "main", commitOid: root.oid, git }),
    ).resolves.toBe(true);
  });

  test("rejects an object that exists outside the branch ancestry", async () => {
    const filesystem = new InMemoryFs();
    const git = createGit(filesystem, "/repo");
    await git.init({ defaultBranch: "main" });
    await filesystem.writeFile("/repo/value.txt", "root");
    await git.add({ filepath: "value.txt" });
    await git.commit({
      author: { email: "test@iterate.com", name: "Test" },
      message: "root",
    });
    await git.checkout({ branch: "other" });
    await filesystem.writeFile("/repo/value.txt", "other");
    await git.add({ filepath: "value.txt" });
    const other = await git.commit({
      author: { email: "test@iterate.com", name: "Test" },
      message: "other",
    });
    await git.checkout({ ref: "main" });

    await expect(
      gitBranchContainsCommit({ branch: "main", commitOid: other.oid, git }),
    ).resolves.toBe(false);
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
