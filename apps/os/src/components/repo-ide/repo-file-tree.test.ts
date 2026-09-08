// @vitest-environment jsdom
import { FileTree } from "@pierre/trees";
import { expect, test } from "vitest";
import { untitledPath } from "@iterate-com/ui/lib/repo-file-tree-paths";

test("a new file inside a folder gets one path separator", () => {
  const tree = new FileTree({ paths: ["agents/github-review.md"] });
  try {
    const agents = tree.getItem("agents");

    expect(agents?.isDirectory()).toBe(true);
    expect(untitledPath(agents!.getPath(), new Set())).toBe("agents/untitled.txt");
  } finally {
    tree.cleanUp();
  }
});
