import { expect, test } from "vitest";
import { untitledPath } from "./repo-file-tree-paths.ts";

test("a new file inside a folder gets one path separator", () => {
  expect(untitledPath("agents", new Set())).toBe("agents/untitled.txt");
  expect(untitledPath("agents/", new Set())).toBe("agents/untitled.txt");
  expect(untitledPath(null, new Set())).toBe("untitled.txt");
});

test("a taken name counts up", () => {
  expect(untitledPath("a", new Set(["a/untitled.txt", "a/untitled-1.txt"]))).toBe(
    "a/untitled-2.txt",
  );
});
