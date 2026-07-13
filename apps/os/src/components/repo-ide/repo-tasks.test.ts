import { expect, test } from "vitest";
import {
  createRepoTask,
  isRepoTaskPath,
  parseRepoTask,
  prepareRepoTaskAssignment,
  queryRepoTaskBoard,
  repoTaskAgentPath,
  repoTaskHeadingTitle,
  repoTaskPathForTitle,
  repoTaskPathInDirectory,
  repoTaskWithPath,
  repoTaskCreationPaths,
  taskDirectoryForFolder,
  taskDirectoryForPath,
  taskStateColumns,
  updateRepoTaskLabels,
  updateRepoTaskAgent,
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
    folderPath: "/apps/os",
    title: "Make OS faster",
    description: "Measure first.",
    state: "todo",
    labels: [],
    agent: undefined,
    comments: [],
    content: "# Make OS faster\n\nMeasure first.\n",
  });
});

test("falls back to the filename and infers the root folder", () => {
  const task = parseRepoTask("tasks/fix-auth.md", "There is no heading yet.");
  expect(task?.title).toBe("fix-auth");
  expect(task?.description).toBe("There is no heading yet.");
  expect(task?.folderPath).toBe("/");
  expect(task?.labels).toEqual([]);
});

test("reads canonical frontmatter fields literally", () => {
  const canonical = parseRepoTask(
    "packages/ui/tasks/card.md",
    "---\nstate: in-progress\nlabels: [ui, polish]\n---\n# Card\n",
  );
  expect(canonical?.state).toBe("in-progress");
  expect(canonical?.folderPath).toBe("/packages/ui");
  expect(canonical?.labels).toEqual(["ui", "polish"]);

  const unrelatedMetadata = parseRepoTask(
    "tasks/unrelated.md",
    "---\nstatus: in-review\ntags: backend\n---\nOther keys are ordinary metadata\n",
  );
  expect(unrelatedMetadata?.state).toBe("todo");
  expect(unrelatedMetadata?.labels).toEqual([]);

  const backlog = parseRepoTask("tasks/backlog.md", "---\nstate: backlog\n---\n# Backlog\n");
  expect(backlog?.state).toBe("todo");
});

test("uses an explicit title before the first heading", () => {
  const task = parseRepoTask(
    "tasks/rename-me.md",
    "---\ntitle: Frontmatter title\n---\n# Heading title\n\nDescription.\n",
  );
  expect(task?.title).toBe("Frontmatter title");
  expect(task?.description).toBe("Description.");
});

test("reads an assigned agent and a permissive final comments log", () => {
  const task = parseRepoTask(
    "tasks/assigned.md",
    "---\nagent: /agents/repos/config/tasks/assigned\n---\n# Assigned\n\nDo it.\n\n## Comments\n\nA loose note.\n\n### 2026-07-13T12:00:00Z — agent\n\nStarted.\n\n### malformed but fine\nDone.\n",
  );

  expect(task?.description).toBe("Do it.");
  expect(task?.agent).toBe("/agents/repos/config/tasks/assigned");
  expect(task?.comments).toEqual([
    { heading: undefined, body: "A loose note." },
    { heading: "2026-07-13T12:00:00Z — agent", body: "Started." },
    { heading: "malformed but fine", body: "Done." },
  ]);
});

test("treats an unstructured comments section as one lightweight comment", () => {
  const task = parseRepoTask("tasks/log.md", "# Log\n\nBody.\n\n## Comments\nnot structured");
  expect(task?.description).toBe("Body.");
  expect(task?.comments).toEqual([{ heading: undefined, body: "not structured" }]);
});

test("updates state while preserving unrelated YAML, comments, and Markdown", () => {
  const content = "---\n# keep this\nstate: todo\nsize: small\n---\n\n# Ship it\n\nBody.\n";
  const updated = updateRepoTaskState(content, "in-progress");
  expect(updated).toContain("# keep this");
  expect(updated).toContain("state: in-progress");
  expect(updated).toContain("size: small");
  expect(updated.endsWith("\n# Ship it\n\nBody.\n")).toBe(true);
});

test("adds canonical state frontmatter", () => {
  expect(updateRepoTaskState("# New task\n", "done")).toBe("---\nstate: done\n---\n\n# New task\n");
});

test("updates labels stored in frontmatter", () => {
  const updated = updateRepoTaskLabels("# Labels\n", ["frontend", "frontend", "v1"]);
  expect(updated).toBe("---\nlabels:\n  - frontend\n  - v1\n---\n\n# Labels\n");
  expect(updated).not.toContain("folder:");

  const removed = updateRepoTaskLabels(updated, []);
  expect(removed).toBe("\n# Labels\n");
});

test("updates and clears an agent property", () => {
  const assigned = updateRepoTaskAgent("# Assign me\n", "/agents/repos/config/tasks/assign-me");
  expect(assigned).toContain("agent: /agents/repos/config/tasks/assign-me");
  expect(updateRepoTaskAgent(assigned, undefined)).toBe("\n# Assign me\n");
});

test("creates a bare task with a stable collision-free path", () => {
  const paths = new Set(["tasks/ship-the-board.md", "tasks/ship-the-board-2.md"]);
  expect(createRepoTask("  Ship the board!  ", paths)).toEqual({
    path: "tasks/ship-the-board-3.md",
    content: "# Ship the board!\n",
  });
  expect(createRepoTask("   ", paths)).toBeNull();
});

test("derives bounded collision-safe filenames from the first heading", () => {
  expect(repoTaskHeadingTitle("---\nstate: todo\n---\n# A Better Name\n\nBody")).toBe(
    "A Better Name",
  );
  expect(
    repoTaskPathForTitle(
      "apps/os/tasks/new-task.md",
      "A Better Name",
      new Set(["apps/os/tasks/a-better-name.md"]),
    ),
  ).toBe("apps/os/tasks/a-better-name-2.md");
  const longPath = repoTaskPathForTitle(
    "tasks/new-task.md",
    "A title that is intentionally much much much much much much much much much much longer than a filename should be",
    new Set(),
  );
  expect(longPath).toMatch(/^tasks\/[a-z0-9-]{1,64}\.md$/);
});

test("prepares a deterministic durable agent assignment", () => {
  const task = parseRepoTask("apps/os/tasks/Ship This.md", "# Ship this\n\nPlease finish it.\n")!;
  const assignment = prepareRepoTaskAssignment(task, "/repos/config");

  expect(repoTaskAgentPath("/repos/config", task.path)).toBe(
    "/agents/repos/config/tasks/apps-os-tasks-ship-this",
  );
  expect(assignment.agentPath).toBe("/agents/repos/config/tasks/apps-os-tasks-ship-this");
  expect(parseRepoTask(task.path, assignment.content)).toMatchObject({
    state: "in-progress",
    agent: assignment.agentPath,
  });
  expect(assignment.instructions).toContain(task.path);
  expect(assignment.instructions).toContain("First, verify");
  expect(assignment.instructions).toContain("## Comments");
  expect(assignment.instructions).toContain("in-review");
});

test("creates tasks in a folder's conventional task directory", () => {
  expect(taskDirectoryForFolder("/apps/os")).toBe("apps/os/tasks");
  expect(taskDirectoryForFolder("/")).toBe("tasks");
  expect(createRepoTask("Ship it", new Set(), taskDirectoryForFolder("/apps/os"))?.path).toBe(
    "apps/os/tasks/ship-it.md",
  );
});

test("picks a collision-free path when moving a task between folders", () => {
  const paths = new Set(["tasks/plan.md", "apps/os/tasks/plan.md", "apps/os/tasks/plan-2.md"]);
  expect(repoTaskPathInDirectory("tasks/plan.md", "apps/os/tasks", paths)).toBe(
    "apps/os/tasks/plan-3.md",
  );
  expect(repoTaskPathInDirectory("tasks/plan.md", "tasks", paths)).toBe("tasks/plan.md");
});

test("validates an edited task path before projecting the task there", () => {
  const task = parseRepoTask("tasks/old.md", "# Old\n")!;
  const reserved = new Set([task.path, "tasks/taken.md"]);

  expect(repoTaskWithPath(task, "/tasks/new.md", reserved)?.path).toBe("tasks/new.md");
  expect(repoTaskWithPath(task, task.path, reserved)?.path).toBe(task.path);
  expect(repoTaskWithPath(task, "tasks/taken.md", reserved)).toBeNull();
  expect(repoTaskWithPath(task, "tasks/../outside.md", reserved)).toBeNull();
  expect(repoTaskWithPath(task, "not-a-task.md", reserved)).toBeNull();
});

test("reserves a task path that exists at HEAD while its deletion is pending", () => {
  const paths = repoTaskCreationPaths(["tasks/reuse-me.md"], [["tasks/reuse-me.md", "delete"]]);

  expect(createRepoTask("Reuse me", paths)?.path).toBe("tasks/reuse-me-2.md");
});

test("keeps the core columns and appends states found in the repo", () => {
  const task = parseRepoTask("tasks/review.md", "---\nstate: in-review\n---\n# Review\n")!;
  expect(taskStateColumns([task])).toEqual(["todo", "in-progress", "in-review", "done"]);
});

test("queries a status board with folders as an independent row dimension", () => {
  const tasks = [
    parseRepoTask("tasks/root.md", "# Root\n")!,
    parseRepoTask("apps/os/tasks/ship.md", "---\nstate: in-progress\n---\n# Ship OS\n")!,
    parseRepoTask("apps/os/tasks/test.md", "---\nlabels: [quality]\n---\n# Test OS\n")!,
  ];
  const board = queryRepoTaskBoard(tasks, { filter: "", columns: "state", rows: "folder" });

  expect(board.states).toEqual(["todo", "in-progress", "in-review", "done"]);
  expect(board.visibleProperties).toEqual({ folder: false, state: false, labels: true });
  expect(board.rows.map((row) => row.label)).toEqual(["/", "/apps/os"]);
  expect(board.rows[1]?.cells.find((cell) => cell.state === "todo")?.tasks[0]?.title).toBe(
    "Test OS",
  );
  expect(board.rows[1]?.cells.find((cell) => cell.state === "in-progress")?.tasks[0]?.title).toBe(
    "Ship OS",
  );
});

test("filters the board projection and can group multi-label tasks", () => {
  const task = parseRepoTask(
    "tasks/card.md",
    "---\nlabels: [frontend, polish]\n---\n# Polish card\n",
  )!;
  const byLabel = queryRepoTaskBoard([task], { filter: "card", columns: "state", rows: "label" });

  expect(byLabel.taskCount).toBe(1);
  expect(byLabel.visibleProperties).toEqual({ folder: true, state: false, labels: false });
  expect(byLabel.rows.map((row) => row.label)).toEqual(["frontend", "polish"]);
  expect(
    queryRepoTaskBoard([task], { filter: "missing", columns: "state", rows: null }).taskCount,
  ).toBe(0);
});
