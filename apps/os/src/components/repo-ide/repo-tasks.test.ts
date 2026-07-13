import { expect, test } from "vitest";
import {
  createRepoTask,
  isRepoTaskPath,
  parseRepoTask,
  taskDirectoryForPath,
  taskStateColumns,
  updateRepoTaskLabels,
  updateRepoTaskState,
} from "./repo-tasks.ts";

test("recognizes Markdown files in any tasks directory", () => {
  expect(isRepoTaskPath("tasks/ship-it.md")).toBe(true);
  expect(isRepoTaskPath("apps/os/tasks/ship-it.markdown")).toBe(true);
  expect(isRepoTaskPath("apps/os/tasks/notes/ship-it.md")).toBe(true);
  expect(isRepoTaskPath("apps/os/task/ship-it.md")).toBe(false);
  expect(isRepoTaskPath("apps/os/tasks/ship-it.txt")).toBe(false);
  expect(taskDirectoryForPath("apps/os/tasks/notes/ship-it.md")).toBe("apps/os/tasks");
});

test("projects a bare Markdown file into a task", () => {
  expect(
    parseRepoTask("apps/os/tasks/speed-up.md", "# Make OS faster\n\nMeasure first.\n"),
  ).toEqual({
    path: "apps/os/tasks/speed-up.md",
    taskDirectoryPath: "apps/os/tasks",
    title: "Make OS faster",
    description: "Measure first.",
    state: "todo",
    explicitLabels: [],
    labels: ["folder:apps/os"],
    content: "# Make OS faster\n\nMeasure first.\n",
  });
});

test("falls back to the filename and infers the root folder label", () => {
  const task = parseRepoTask("tasks/fix-auth.md", "There is no heading yet.");
  expect(task?.title).toBe("fix-auth");
  expect(task?.description).toBe("There is no heading yet.");
  expect(task?.labels).toEqual(["folder:."]);
});

test("reads canonical and legacy frontmatter without requiring it", () => {
  const canonical = parseRepoTask(
    "packages/ui/tasks/card.md",
    "---\nstate: in-progress\nlabels: [ui, polish]\ntags: [polish, v1]\n---\n# Card\n",
  );
  expect(canonical?.state).toBe("in-progress");
  expect(canonical?.explicitLabels).toEqual(["ui", "polish", "v1"]);
  expect(canonical?.labels).toEqual(["folder:packages/ui", "ui", "polish", "v1"]);

  const legacy = parseRepoTask(
    "tasks/legacy.md",
    "---\nstatus: in-review\ntags: backend\n---\nLegacy task\n",
  );
  expect(legacy?.state).toBe("in-review");
  expect(legacy?.explicitLabels).toEqual(["backend"]);
});

test("updates state while preserving unrelated YAML, comments, and Markdown", () => {
  const content = "---\n# keep this\nstate: todo\nsize: small\n---\n\n# Ship it\n\nBody.\n";
  const updated = updateRepoTaskState(content, "in-progress");
  expect(updated).toContain("# keep this");
  expect(updated).toContain("state: in-progress");
  expect(updated).toContain("size: small");
  expect(updated.endsWith("\n# Ship it\n\nBody.\n")).toBe(true);
});

test("adds state frontmatter to a bare task and updates the legacy key in place", () => {
  expect(updateRepoTaskState("# New task\n", "done")).toBe("---\nstate: done\n---\n\n# New task\n");
  const legacy = updateRepoTaskState("---\nstatus: todo\n---\n# Old\n", "done");
  expect(legacy).toContain("status: done");
  expect(legacy).not.toContain("state:");
});

test("updates explicit labels without serializing the inferred folder label", () => {
  const updated = updateRepoTaskLabels("# Labels\n", ["frontend", "frontend", "v1"]);
  expect(updated).toBe("---\nlabels:\n  - frontend\n  - v1\n---\n\n# Labels\n");
  expect(updated).not.toContain("folder:");

  const removed = updateRepoTaskLabels(updated, []);
  expect(removed).toBe("\n# Labels\n");
});

test("creates a bare task with a stable collision-free path", () => {
  const paths = new Set(["tasks/ship-the-board.md", "tasks/ship-the-board-2.md"]);
  expect(createRepoTask("  Ship the board!  ", paths)).toEqual({
    path: "tasks/ship-the-board-3.md",
    content: "# Ship the board!\n",
  });
  expect(createRepoTask("   ", paths)).toBeNull();
});

test("keeps the core columns and appends states found in the repo", () => {
  const task = parseRepoTask("tasks/review.md", "---\nstate: in-review\n---\n# Review\n")!;
  expect(taskStateColumns([task])).toEqual(["backlog", "todo", "in-progress", "done", "in-review"]);
});
