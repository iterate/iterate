import { describe, expect, it } from "vitest";
import { flattenPathForClaude } from "./skills.ts";

describe("flattenPathForClaude", () => {
  it("passes through single-level paths unchanged", () => {
    expect(flattenPathForClaude("skill-name")).toBe("skill-name");
  });

  it("replaces single separator with double hyphen", () => {
    expect(flattenPathForClaude("category/skill-name")).toBe("category--skill-name");
  });

  it("handles multiple levels of nesting", () => {
    expect(flattenPathForClaude("a/b/c/skill")).toBe("a--b--c--skill");
  });

  it("handles paths with hyphens in names", () => {
    expect(flattenPathForClaude("my-category/my-skill-name")).toBe("my-category--my-skill-name");
  });
});
