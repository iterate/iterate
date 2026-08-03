import { describe, expect, it } from "vitest";
import { setTaskCardLabels } from "../tasks-model.ts";
import { changeAfterDelete, changeAfterWrite, toBoardTask, unclaimedPath } from "./board-model.ts";
import { matchesFilter, projectBoard } from "./board-engine.ts";

const make = (path: string, frontmatter: string, body = "# Task\n\nSome body.") =>
  toBoardTask(path, `---\n${frontmatter}\n---\n\n${body}\n`);

describe("tags parsing", () => {
  it("reads the tags frontmatter key and merges legacy labels", () => {
    const task = make("tasks/a.md", "state: done\ntags:\n  - hi\nlabels:\n  - legacy");
    expect(task.labels).toEqual(["hi", "legacy"]);
  });

  it("writes canonical tags and migrates a legacy labels key", () => {
    const source = "---\nstate: todo\nlabels:\n  - old\n---\n\n# T\n";
    const next = setTaskCardLabels(source, ["new"]);
    expect(next).toContain("tags:");
    expect(next).not.toContain("labels:");
    expect(make("tasks/t.md", "state: todo\ntags:\n  - new").labels).toEqual(["new"]);
  });
});

describe("projectBoard", () => {
  const tasks = [
    make("tasks/a.md", "state: todo\ntags:\n  - alpha\n  - beta", "# Alpha beta task"),
    make("tasks/b.md", "state: done\ntags:\n  - alpha", "# Alpha task"),
    make("tasks/c.md", "state: todo", "# Untagged"),
    make("sub/tasks/d.md", "state: todo", "# Nested"),
  ];

  it("duplicates multi-tag cards across their tag rows; untagged trail in No tag", () => {
    const projection = projectBoard({ tasks, filter: "", rowField: "label" });
    expect(projection.rows.map((row) => row.label)).toEqual(["alpha", "beta", "No tag"]);
    const inRow = (index: number, path: string) =>
      projection.rows[index]!.cells.some((cell) => cell.tasks.some((task) => task.path === path));
    expect(inRow(0, "tasks/a.md")).toBe(true);
    expect(inRow(1, "tasks/a.md")).toBe(true);
    expect(projection.rows[0]!.count).toBe(2);
    expect(projection.rows[1]!.count).toBe(1);
    expect(projection.rows[2]!.count).toBe(2);
  });

  it("reports visible/total per column while filtering", () => {
    const projection = projectBoard({ tasks, filter: "alpha", rowField: null });
    expect(projection.filterActive).toBe(true);
    const todo = projection.columns.find((column) => column.state === "todo")!;
    const done = projection.columns.find((column) => column.state === "done")!;
    expect(todo.total).toBe(3);
    expect(todo.visible).toBe(1);
    expect(done.total).toBe(1);
    expect(done.visible).toBe(1);
  });

  it("groups by folder with the root row first", () => {
    const projection = projectBoard({ tasks, filter: "", rowField: "folder" });
    expect(projection.rows.map((row) => row.label)).toEqual(["sub/tasks", "tasks"]);
  });

  it("renders one flat row without grouping", () => {
    const projection = projectBoard({ tasks, filter: "", rowField: null });
    expect(projection.rows).toHaveLength(1);
    expect(projection.rows[0]!.count).toBe(4);
  });
});

describe("matchesFilter", () => {
  it("matches tags case-insensitively", () => {
    const task = make("tasks/a.md", "state: todo\ntags:\n  - Urgent");
    expect(matchesFilter(task, "urgent")).toBe(true);
    expect(matchesFilter(task, "nope")).toBe(false);
  });
});

describe("frontmatter resilience", () => {
  it("treats broken YAML as plain text and flags it", () => {
    const task = toBoardTask(
      "tasks/broken.md",
      "---\nstate: todo\ntags: [unclosed\n---\n\n# Broken\n\nBody.\n",
    );
    expect(task.frontmatterError).toBe(true);
    expect(task.labels).toEqual([]);
    expect(task.state).toBe("todo");
    expect(task.title).toBe("Broken");
  });

  it("uses the full path as title when there is no heading", () => {
    const task = toBoardTask("tasks/sub/quiet.md", "---\nstate: todo\n---\n\nJust body text.\n");
    expect(task.title).toBe("tasks/sub/quiet.md");
  });
});

describe("optimistic change transitions", () => {
  it("first write of an unknown path is an ADD, not modified", () => {
    expect(changeAfterWrite(undefined, false)).toBe("added");
  });
  it("first write of a known (seeded) path is a modification", () => {
    expect(changeAfterWrite(undefined, true)).toBe("modified");
  });
  it("a later write keeps the existing status — except deleted, which revives as modified", () => {
    expect(changeAfterWrite("added", true)).toBe("added");
    expect(changeAfterWrite("modified", true)).toBe("modified");
    expect(changeAfterWrite("deleted", true)).toBe("modified");
    expect(changeAfterWrite("deleted", false)).toBe("modified");
  });
  it("deleting an uncommitted add clears the change; others become deleted", () => {
    expect(changeAfterDelete("added")).toBeNull();
    expect(changeAfterDelete("modified")).toBe("deleted");
    expect(changeAfterDelete(undefined)).toBe("deleted");
  });
});

describe("unclaimedPath", () => {
  it("returns the desired path when free", () => {
    expect(unclaimedPath("tasks/new-task.md", () => false)).toBe("tasks/new-task.md");
  });
  it("suffixes the filename until free — tasks never collapse onto one file", () => {
    const taken = new Set(["tasks/new-task.md", "tasks/new-task-2.md"]);
    expect(unclaimedPath("tasks/new-task.md", (path) => taken.has(path))).toBe(
      "tasks/new-task-3.md",
    );
  });
  it("keeps the folder prefix intact", () => {
    const taken = new Set(["sub/tasks/x.md"]);
    expect(unclaimedPath("sub/tasks/x.md", (path) => taken.has(path))).toBe("sub/tasks/x-2.md");
  });
});
