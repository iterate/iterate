import { describe, expect, test } from "vitest";
import { newWorkspaceName, workspacePathForName } from "./workspace-names.ts";

describe("workspace names", () => {
  test("a new name is three words", () => {
    expect(newWorkspaceName(() => 0)).toBe("apple-apple-apple");
    expect(newWorkspaceName()).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
  });

  test.each([
    ["apple-cow-hat", "/workspaces/apple-cow-hat"],
    [" notes ", "/workspaces/notes"],
    ["team/notes", "/workspaces/team/notes"],
    ["/agents/reviewer/", "/workspaces/agents/reviewer"],
  ])("%j lands at %s", (name, path) => {
    expect(workspacePathForName(name)).toBe(path);
  });

  test.each(["", "   ", "a b", "../x", "x//y", ".hidden", "-lead"])("%j is not a name", (name) => {
    expect(workspacePathForName(name)).toBeNull();
  });
});
