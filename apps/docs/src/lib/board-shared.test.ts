import { describe, expect, test } from "vitest";
import {
  isGuestWorkspacePath,
  newScratchWorkspaceName,
  normalizeRepoPath,
} from "./board-shared.ts";

describe("scratch workspace names", () => {
  test("date-time stamp plus a random tail", () => {
    expect(newScratchWorkspaceName(new Date("2026-09-09T11:30:00Z"))).toMatch(
      /^20260909-1130-[a-z0-9]{4}$/,
    );
  });
});

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

describe("ownership", () => {
  test("this app's scratch workspaces are owned; every other path is a guest view", () => {
    expect(isGuestWorkspacePath("/workspaces/scratch/20260909-1130-ab3f")).toBe(false);
    expect(isGuestWorkspacePath("/agents/reviewer")).toBe(true);
    expect(isGuestWorkspacePath("/workspaces/notes")).toBe(true);
    expect(isGuestWorkspacePath("/workspaces/scratch")).toBe(true);
  });
});
