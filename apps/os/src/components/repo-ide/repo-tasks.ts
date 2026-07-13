import type { Document } from "yaml";
import { markdownFrontmatterRecord, parseMarkdownFrontmatter } from "./markdown-frontmatter.ts";

const DEFAULT_TASK_STATE = "todo";

const STANDARD_TASK_STATES = ["backlog", DEFAULT_TASK_STATE, "in-progress", "done"] as const;

export type RepoTask = {
  path: string;
  taskDirectoryPath: string;
  folderPath: string;
  title: string;
  description: string;
  state: string;
  labels: string[];
  content: string;
};

export type RepoTaskBoardRowField = "folder" | "label" | null;

export type RepoTaskBoardQuery = {
  filter: string;
  columns: "state";
  rows: RepoTaskBoardRowField;
};

type RepoTaskBoardRow = {
  key: string;
  label: string | null;
  value: string | null;
  tasks: RepoTask[];
  cells: Array<{ state: string; tasks: RepoTask[] }>;
};

export type RepoTaskBoardProjection = {
  states: string[];
  rows: RepoTaskBoardRow[];
  taskCount: number;
  visibleProperties: {
    folder: boolean;
    state: boolean;
    labels: boolean;
  };
};

/** Markdown files below any directory segment named `tasks` are repo tasks. */
export function isRepoTaskPath(path: string): boolean {
  const segments = pathSegments(path);
  return /\.(?:md|markdown)$/i.test(segments.at(-1) ?? "") && segments.includes("tasks");
}

/** The nearest `tasks` directory owns a task. */
export function taskDirectoryForPath(path: string): string | null {
  if (!isRepoTaskPath(path)) return null;
  const segments = pathSegments(path);
  const tasksIndex = segments.lastIndexOf("tasks");
  return segments.slice(0, tasksIndex + 1).join("/");
}

export function parseRepoTask(path: string, content: string): RepoTask | null {
  const taskDirectoryPath = taskDirectoryForPath(path);
  if (taskDirectoryPath === null) return null;

  const frontmatter = parseMarkdownFrontmatter(content);
  const metadata = markdownFrontmatterRecord(frontmatter.document);
  const state = stringValue(metadata.state) ?? stringValue(metadata.status) ?? DEFAULT_TASK_STATE;
  const labels = uniqueStrings([...stringArray(metadata.labels), ...stringArray(metadata.tags)]);
  const folderPath = `/${taskDirectoryPath.split("/").slice(0, -1).join("/")}`;
  const heading = firstHeading(frontmatter.body);
  const fallbackTitle = (pathSegments(path).at(-1) ?? "task").replace(/\.(?:md|markdown)$/i, "");

  return {
    path,
    taskDirectoryPath,
    folderPath,
    title: stringValue(metadata.title) ?? heading?.title ?? fallbackTitle,
    description:
      heading === undefined
        ? frontmatter.body.trim()
        : `${frontmatter.body.slice(0, heading.start)}${frontmatter.body.slice(heading.end)}`.trim(),
    state,
    labels,
    content,
  };
}

/** Change only task metadata, preserving its Markdown body and unrelated YAML keys. */
export function updateRepoTaskState(content: string, state: string): string {
  const normalized = state.trim() || DEFAULT_TASK_STATE;
  return updateFrontmatter(content, (document, metadata) => {
    document.set(
      metadata.state === undefined && metadata.status !== undefined ? "status" : "state",
      normalized,
    );
  });
}

/** Change labels stored in YAML while preserving unrelated frontmatter and Markdown. */
export function updateRepoTaskLabels(content: string, labels: readonly string[]): string {
  const normalized = uniqueStrings(labels);
  return updateFrontmatter(content, (document, metadata) => {
    const usesLegacyTags = metadata.labels === undefined && metadata.tags !== undefined;
    if (normalized.length === 0) {
      document.delete("labels");
      document.delete("tags");
    } else if (usesLegacyTags) {
      document.set("tags", normalized);
    } else {
      document.set("labels", normalized);
      document.delete("tags");
    }
  });
}

export function createRepoTask(
  title: string,
  existingPaths: ReadonlySet<string>,
  taskDirectoryPath = "tasks",
): { path: string; content: string } | null {
  const normalizedTitle = title.trim();
  if (normalizedTitle === "") return null;

  const base = slugify(normalizedTitle) || "task";
  const directory = pathSegments(taskDirectoryPath).join("/") || "tasks";
  let suffix = 1;
  let path = `${directory}/${base}.md`;
  while (existingPaths.has(path)) {
    suffix += 1;
    path = `${directory}/${base}-${suffix}.md`;
  }
  return { path, content: `# ${normalizedTitle}\n` };
}

/** The conventional task directory for a repo folder shown as `/apps/os`. */
export function taskDirectoryForFolder(folderPath: string): string {
  const directory = pathSegments(folderPath).join("/");
  return directory === "" ? "tasks" : `${directory}/tasks`;
}

/** Pick a collision-free path when a task file moves to another task directory. */
export function repoTaskPathInDirectory(
  path: string,
  taskDirectoryPath: string,
  existingPaths: ReadonlySet<string>,
): string {
  const filename = pathSegments(path).at(-1) ?? "task.md";
  const directory = pathSegments(taskDirectoryPath).join("/") || "tasks";
  const directPath = `${directory}/${filename}`;
  if (directPath === path || !existingPaths.has(directPath)) return directPath;

  const extension = /\.(?:md|markdown)$/i.exec(filename)?.[0] ?? ".md";
  const base = filename.slice(0, -extension.length) || "task";
  let suffix = 2;
  let candidate = `${directory}/${base}-${suffix}${extension}`;
  while (existingPaths.has(candidate)) {
    suffix += 1;
    candidate = `${directory}/${base}-${suffix}${extension}`;
  }
  return candidate;
}

export function repoTaskCreationPaths(
  headPaths: readonly string[],
  changes: Iterable<readonly [path: string, type: "write" | "write-base64" | "delete" | undefined]>,
): Set<string> {
  const paths = new Set(headPaths);
  for (const [path, type] of changes) {
    if (type === "write" || type === "write-base64") paths.add(path);
  }
  return paths;
}

export function taskStateColumns(tasks: readonly RepoTask[]): string[] {
  const unknown = new Set(tasks.map((task) => task.state));
  for (const state of STANDARD_TASK_STATES) unknown.delete(state);
  return [
    ...STANDARD_TASK_STATES,
    ...[...unknown].sort((left, right) => left.localeCompare(right)),
  ];
}

/** Query tasks into the row × state cells consumed by the board renderer. */
export function queryRepoTaskBoard(
  tasks: readonly RepoTask[],
  query: RepoTaskBoardQuery,
): RepoTaskBoardProjection {
  const states = taskStateColumns(tasks);
  const filter = query.filter.trim().toLocaleLowerCase();
  const matchingTasks = tasks.filter(
    (task) =>
      filter === "" ||
      [task.title, task.description, task.state, task.folderPath, ...task.labels].some((value) =>
        value.toLocaleLowerCase().includes(filter),
      ),
  );
  const rowGroups = taskBoardRowGroups(matchingTasks, query.rows);
  return {
    states,
    rows: rowGroups.map((row) => ({
      ...row,
      cells: states.map((state) => ({
        state,
        tasks: row.tasks.filter((task) => task.state === state),
      })),
    })),
    taskCount: matchingTasks.length,
    visibleProperties: {
      folder: query.rows !== "folder",
      state: query.columns !== "state",
      labels: query.rows !== "label",
    },
  };
}

export function taskStateLabel(state: string): string {
  return state
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function pathSegments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function taskBoardRowGroups(
  tasks: readonly RepoTask[],
  rowField: RepoTaskBoardRowField,
): Array<Pick<RepoTaskBoardRow, "key" | "label" | "value" | "tasks">> {
  if (rowField === null) return [{ key: "all", label: null, value: null, tasks: [...tasks] }];

  const groups = new Map<string, RepoTask[]>();
  if (rowField === "folder") {
    for (const task of tasks) {
      const group = groups.get(task.folderPath) ?? [];
      group.push(task);
      groups.set(task.folderPath, group);
    }
    if (groups.size === 0) groups.set("/", []);
    return [...groups]
      .sort(([left], [right]) => {
        if (left === "/") return -1;
        if (right === "/") return 1;
        return left.localeCompare(right);
      })
      .map(([folderPath, groupedTasks]) => ({
        key: `folder:${folderPath}`,
        label: folderPath,
        value: folderPath,
        tasks: groupedTasks,
      }));
  }

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
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, groupedTasks]) => ({
      key: `label:${label}`,
      label: label === "" ? "No label" : label,
      value: label === "" ? null : label,
      tasks: groupedTasks,
    }));
}

function firstHeading(body: string): { start: number; end: number; title: string } | undefined {
  const match = /^#\s+(.+?)\s*#*\s*$/m.exec(body);
  if (match === null || match.index === undefined) return undefined;
  let end = match.index + match[0].length;
  if (body.slice(end, end + 2) === "\r\n") end += 2;
  else if (body[end] === "\n") end += 1;
  return { start: match.index, end, title: match[1]!.trim() };
}

function updateFrontmatter(
  content: string,
  update: (document: Document, metadata: Record<string, unknown>) => void,
): string {
  const frontmatter = parseMarkdownFrontmatter(content);
  update(frontmatter.document, markdownFrontmatterRecord(frontmatter.document));
  const yaml = frontmatter.document.toString().trimEnd();
  if (yaml === "" || yaml === "{}") return frontmatter.body;
  const body = frontmatter.exists ? frontmatter.body : `\n${content}`;
  return `---\n${yaml}\n---\n${body}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (typeof item === "string" ? [item] : []));
}

function uniqueStrings(values: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (normalized !== "") unique.add(normalized);
  }
  return [...unique];
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
