import { expect, test } from "vitest";
import { repoWorkingTreeStore } from "./repo-working-tree.ts";

test("collects source edits, creations, and deletions into one explicit commit", () => {
  const store = repoWorkingTreeStore("working-tree-changes");
  store.setHead("head-1", ["README.md", "src/index.ts"]);

  store.open("README.md", "# Before\n");
  store.updateSelected("# After\n");
  store.setNewPath("tasks / next.md");
  store.create();
  store.updateSelected("# Next\n");
  store.remove("src/index.ts");

  expect(store.pendingChanges()).toMatchObject([
    { content: "# After\n", kind: "edit", path: "README.md" },
    { delete: true, kind: "delete", path: "src/index.ts" },
    { content: "# Next\n", kind: "create", path: "tasks / next.md" },
  ]);
});

test("does not replace a dirty working tree when the remote head changes", () => {
  const store = repoWorkingTreeStore("working-tree-conflict");
  store.setHead("head-1", ["README.md"]);
  store.open("README.md", "old\n");
  store.updateSelected("local\n");

  store.setHead("head-2", ["README.md", "remote.md"]);

  expect(store.getSnapshot()).toMatchObject({
    headChanged: true,
    headCommitOid: "head-1",
    headPaths: ["README.md"],
  });
  expect(store.pendingChanges()).toMatchObject([
    { content: "local\n", kind: "edit", path: "README.md" },
  ]);
});

test("starts Markdown files in preview without changing their source", () => {
  const store = repoWorkingTreeStore("working-tree-markdown");
  store.setHead("head-1", ["README.md"]);
  store.open("README.md", "- [ ] keep source\n");

  expect(store.getSnapshot()).toMatchObject({
    editorView: "preview",
    selectedPath: "README.md",
  });
  expect(store.pendingChanges()).toEqual([]);
});
