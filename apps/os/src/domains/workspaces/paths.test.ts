import { describe, expect, test } from "vitest";
import { isCanonicalMountPath, isCanonicalRepoPath, resolveAbsolutePath } from "./paths.ts";

describe("canonical workspace paths", () => {
  test("resolveAbsolutePath pops dot segments and cannot escape the root", () => {
    expect(resolveAbsolutePath("/a/./b/../c")).toBe("/a/c");
    expect(resolveAbsolutePath("/../..")).toBe("/");
  });

  test("mount paths must be resolved-absolute and .git-free", () => {
    expect(isCanonicalMountPath("/")).toBe(true);
    expect(isCanonicalMountPath("/config")).toBe(true);
    expect(isCanonicalMountPath("/config/")).toBe(false);
    expect(isCanonicalMountPath("/a/../b")).toBe(false);
    expect(isCanonicalMountPath("/a/.git")).toBe(false);
  });

  test("repo paths must be normalized /repos/** names that round-trip the codec", () => {
    expect(isCanonicalRepoPath("/repos/config")).toBe(true);
    expect(isCanonicalRepoPath("/repos/a/../b")).toBe(false);
    // `?` is the DO name codec's props separator — two names, one logical repo.
    expect(isCanonicalRepoPath("/repos/b?alias=1")).toBe(false);
    expect(isCanonicalRepoPath("/repos/")).toBe(false);
    expect(isCanonicalRepoPath("/secrets/a")).toBe(false);
  });
});
