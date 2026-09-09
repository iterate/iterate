import { describe, expect, test } from "vitest";
import { normalizeRepoPath } from "./board-shared.ts";

describe("repo paths", () => {
  test.each([
    ["", "/repos/config"],
    [undefined, "/repos/config"],
    ["/repos/other", "/repos/other"],
    ["/repos/a/b", "/repos/a/b"],
  ])("%j normalizes to %s", (value, expected) => {
    expect(normalizeRepoPath(value)).toBe(expected);
  });

  test.each([
    "/repos",
    "/repos/",
    "/repos/../x",
    "/workspaces/x",
    "repos/config",
    "/repos/.hidden",
  ])("%s is rejected", (value) => {
    expect(normalizeRepoPath(value)).toBeNull();
  });
});
