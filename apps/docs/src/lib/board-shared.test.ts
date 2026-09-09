import { describe, expect, test } from "vitest";
import {
  boardWorkspacePath,
  isBoardId,
  isGuestWorkspacePath,
  newBoardId,
  normalizeRepoPath,
} from "./board-shared.ts";

describe("board workspace stream paths", () => {
  test("shape: /workspaces/tasks/<boardId>, with no repo in the identity", () => {
    expect(boardWorkspacePath("20260909-1130-ab3f")).toBe("/workspaces/tasks/20260909-1130-ab3f");
  });

  test("a bad id never names a workspace", () => {
    expect(() => boardWorkspacePath("a/b")).toThrow(/bad board id/);
    expect(() => boardWorkspacePath("")).toThrow(/bad board id/);
  });

  test("minted ids are board ids", () => {
    expect(isBoardId(newBoardId(new Date("2026-09-09T11:30:00Z")))).toBe(true);
    expect(newBoardId(new Date("2026-09-09T11:30:00Z"))).toMatch(/^20260909-1130-[a-z0-9]{4}$/);
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
  test("this app's own namespaces are owned; everything else is a guest", () => {
    expect(isGuestWorkspacePath("/workspaces/tasks/20260909-1130-ab3f")).toBe(false);
    expect(isGuestWorkspacePath("/workspaces/scratch/20260909-1130-ab3f")).toBe(false);
    expect(isGuestWorkspacePath("/workspaces/agents/reviewer")).toBe(true);
    expect(isGuestWorkspacePath("/workspaces/notes")).toBe(true);
    expect(isGuestWorkspacePath("/workspaces/tasks")).toBe(true);
  });
});
