import { columnsForTasks, taskColumnState } from "../tasks-model.ts";
import type { BoardTask, RowField } from "./board-model.ts";

/**
 * The board's pure projection engine: parsed tasks in, render-ready
 * structure out. No React, no Yjs — just data, so every rule (filtering,
 * folder/tag grouping, duplication of multi-tag cards, visible/total
 * counts) is unit-testable.
 */

export type BoardColumn = { state: string; visible: number; total: number };
export type BoardCellData = { state: string; tasks: BoardTask[] };
export type BoardRowData = {
  key: string;
  label: string | null;
  value: string | null;
  count: number;
  cells: BoardCellData[];
};
export type BoardProjection = {
  rowField: RowField;
  filterActive: boolean;
  columns: BoardColumn[];
  rows: BoardRowData[];
};

/** Case-insensitive substring match over everything a card shows. */
export function matchesFilter(task: BoardTask, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized === "") return true;
  return [task.title, task.summary, task.state, task.folder, task.path, ...task.labels].some(
    (value) => value.toLocaleLowerCase().includes(normalized),
  );
}

export function projectBoard(input: {
  tasks: BoardTask[];
  filter: string;
  rowField: RowField;
}): BoardProjection {
  const filterActive = input.filter.trim() !== "";
  const visible = input.tasks.filter((task) => matchesFilter(task, input.filter));
  // Column set comes from ALL tasks so filtering never makes columns vanish.
  const states = columnsForTasks(input.tasks).map((column) => column.state);
  const columns = states.map((state) => ({
    state,
    total: input.tasks.filter((task) => taskColumnState(task.state) === state).length,
    visible: visible.filter((task) => taskColumnState(task.state) === state).length,
  }));
  const rows = rowGroups(visible, input.rowField).map((row) => ({
    key: row.key,
    label: row.label,
    value: row.value,
    count: row.tasks.length,
    cells: states.map((state) => ({
      state,
      tasks: row.tasks.filter((task) => taskColumnState(task.state) === state),
    })),
  }));
  return { rowField: input.rowField, filterActive, columns, rows };
}

function rowGroups(
  tasks: BoardTask[],
  rowField: RowField,
): Array<{ key: string; label: string | null; value: string | null; tasks: BoardTask[] }> {
  if (!rowField) return [{ key: "all", label: null, value: null, tasks }];
  const groups = new Map<string, BoardTask[]>();
  if (rowField === "folder") {
    for (const task of tasks) {
      const group = groups.get(task.folder) ?? [];
      group.push(task);
      groups.set(task.folder, group);
    }
    if (groups.size === 0) groups.set("tasks", []);
    return [...groups]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([folder, grouped]) => ({
        key: `folder:${folder}`,
        label: folder,
        value: folder,
        tasks: grouped,
      }));
  }
  // Tags: a task appears in EVERY one of its tags' rows (multi-tag cards
  // render more than once); untagged tasks share one trailing "No tag" row.
  for (const task of tasks) {
    const labels = task.labels.length === 0 ? [""] : task.labels;
    for (const label of labels) {
      const group = groups.get(label) ?? [];
      group.push(task);
      groups.set(label, group);
    }
  }
  if (groups.size === 0) groups.set("", []);
  return [...groups]
    .sort(([left], [right]) => {
      if (left === "") return 1;
      if (right === "") return -1;
      return left.localeCompare(right);
    })
    .map(([label, grouped]) => ({
      key: `label:${label}`,
      label: label === "" ? "No tag" : label,
      value: label === "" ? null : label,
      tasks: grouped,
    }));
}
