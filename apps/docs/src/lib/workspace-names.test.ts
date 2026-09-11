import { describe, expect, test } from "vitest";
import { newWorkspacePath } from "./workspace-names.ts";

describe("workspace paths", () => {
  test("a suggested path is three words under /agents/", () => {
    expect(newWorkspacePath(() => 0)).toBe("/agents/acorn-acorn-acorn");
    expect(newWorkspacePath()).toMatch(/^\/agents\/[a-z]+-[a-z]+-[a-z]+$/);
  });
});
