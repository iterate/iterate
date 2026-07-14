// @vitest-environment jsdom
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import type { RepoTask } from "./repo-tasks.ts";

vi.mock("@dnd-kit/react", () => ({
  DragDropProvider: Fragment,
  useDraggable: () => ({ ref: undefined, isDragging: false }),
  useDroppable: () => ({ ref: undefined, isDropTarget: false }),
}));

const task = (path: string, title: string): RepoTask => ({
  path,
  taskDirectoryPath: "tasks",
  folderPath: "/",
  title,
  description: "",
  state: "todo",
  labels: [],
  agent: undefined,
  comments: [],
  content: `---\nstate: todo\n---\n\n# ${title}\n`,
});

test("the cell add button is always immediately below its task cards", async () => {
  const { TaskColumn } = await import("./repo-tasks-view.tsx");
  const html = renderToStaticMarkup(
    createElement(TaskColumn, {
      state: "todo",
      rowKey: "folder:/",
      rowLabel: "/",
      tasks: [task("tasks/first.md", "First"), task("tasks/second.md", "Second")],
      visibleProperties: { folder: false, state: false, labels: true },
      showHeader: true,
      onOpen: vi.fn(),
      onCreate: vi.fn(),
    }),
  );
  const container = document.createElement("div");
  container.innerHTML = html;
  const cell = container.querySelector("[data-task-cell]");
  const cards = cell?.querySelectorAll("[data-task-path]");
  const addButton = cell?.querySelector('[aria-label="Add task to Todo in /"]');

  expect(cards).toHaveLength(2);
  expect(addButton).not.toBeNull();
  expect(cards?.item(1).compareDocumentPosition(addButton!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(addButton?.parentElement?.firstElementChild?.contains(cards?.item(0) ?? null)).toBe(true);
  expect(addButton?.previousElementSibling?.contains(cards?.item(1) ?? null)).toBe(true);
});

test("an empty cell still renders its add button", async () => {
  const { TaskColumn } = await import("./repo-tasks-view.tsx");
  const html = renderToStaticMarkup(
    createElement(TaskColumn, {
      state: "in-review",
      rowKey: "folder:/apps/os",
      rowLabel: "/apps/os",
      tasks: [],
      visibleProperties: { folder: false, state: false, labels: true },
      showHeader: false,
      onOpen: vi.fn(),
      onCreate: vi.fn(),
    }),
  );
  const container = document.createElement("div");
  container.innerHTML = html;

  expect(
    container.querySelector('[aria-label="Add task to In review in /apps/os"]'),
  ).not.toBeNull();
});

test("an editor path override expires after router selection advances", async () => {
  const { reconcileEditorPathOverride } = await import("./repo-task-editor-state.ts");
  const pending = { source: "tasks/first.md", target: "tasks/second.md" };

  expect(reconcileEditorPathOverride(pending, "tasks/first.md")).toEqual(pending);
  const settled = reconcileEditorPathOverride(pending, "tasks/second.md");
  expect(settled).toBeUndefined();
  expect(reconcileEditorPathOverride(settled, "tasks/first.md")).toBeUndefined();
});

test("a resolved editor path stays visible until the renamed task arrives", async () => {
  const { editorPathDraftApplies, editorPathValue, resolvedEditorPathDraft } =
    await import("./repo-task-editor-state.ts");
  const draft = resolvedEditorPathDraft("tasks/first.md", "tasks/renamed.md");

  expect(editorPathValue("tasks/first.md", draft)).toBe("/tasks/renamed.md");
  expect(editorPathValue("tasks/renamed.md", draft)).toBe("/tasks/renamed.md");
  expect(editorPathDraftApplies("tasks/first.md", draft)).toBe(true);
  expect(editorPathDraftApplies("tasks/renamed.md", draft)).toBe(true);
  expect(resolvedEditorPathDraft("tasks/first.md", "tasks/first.md")).toBeUndefined();
  expect(resolvedEditorPathDraft("tasks/first.md", undefined)).toBeUndefined();
});
