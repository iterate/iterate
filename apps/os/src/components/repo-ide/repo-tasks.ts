import type { Document } from "yaml";
import { isRepoTaskMarkdownPath } from "../../domains/repos/repo-task-events.ts";
import type { RepoFileChange } from "../../domains/repos/types.ts";
import { markdownFrontmatterRecord, parseMarkdownFrontmatter } from "./markdown-frontmatter.ts";
import { effectiveEntry, type FileEntry, type WorkingTreeChanges } from "./staged-changes.ts";

const DEFAULT_TASK_STATE = "todo";
const MAX_TASK_FILENAME_SLUG_LENGTH = 64;

const STANDARD_TASK_STATES = [DEFAULT_TASK_STATE, "in-progress", "in-review", "done"] as const;

export type RepoTask = {
  path: string;
  taskDirectoryPath: string;
  folderPath: string;
  title: string;
  description: string;
  state: string;
  labels: string[];
  agent: string | undefined;
  comments: RepoTaskComment[];
  content: string;
};

export type RepoTaskComment = {
  heading: string | undefined;
  body: string;
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
  return isRepoTaskMarkdownPath(path);
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
  const state = stringValue(metadata.state) ?? DEFAULT_TASK_STATE;
  const labels = uniqueStrings(stringArray(metadata.labels));
  const agent = stringValue(metadata.agent);
  const folderPath = `/${taskDirectoryPath.split("/").slice(0, -1).join("/")}`;
  const commentsSection = taskCommentsSection(frontmatter.body);
  const bodyWithoutComments = commentsSection?.before ?? frontmatter.body;
  const heading = firstHeading(bodyWithoutComments);
  const fallbackTitle = (pathSegments(path).at(-1) ?? "task").replace(/\.(?:md|markdown)$/i, "");

  return {
    path,
    taskDirectoryPath,
    folderPath,
    title: stringValue(metadata.title) ?? heading?.title ?? fallbackTitle,
    description:
      heading === undefined
        ? bodyWithoutComments.trim()
        : `${bodyWithoutComments.slice(0, heading.start)}${bodyWithoutComments.slice(heading.end)}`.trim(),
    state,
    labels,
    agent,
    comments: commentsSection?.comments ?? [],
    content,
  };
}

/** Change only task metadata, preserving its Markdown body and unrelated YAML keys. */
export function updateRepoTaskState(content: string, state: string): string {
  const normalized = state.trim() || DEFAULT_TASK_STATE;
  return updateFrontmatter(content, (document) => {
    document.set("state", normalized);
  });
}

/** Change labels stored in YAML while preserving unrelated frontmatter and Markdown. */
export function updateRepoTaskLabels(content: string, labels: readonly string[]): string {
  const normalized = uniqueStrings(labels);
  return updateFrontmatter(content, (document) => {
    if (normalized.length === 0) {
      document.delete("labels");
    } else {
      document.set("labels", normalized);
    }
  });
}

/** Validate an edited task path and project the task at that path. */
export function repoTaskWithPath(
  task: RepoTask,
  path: string,
  reservedPaths: ReadonlySet<string>,
): RepoTask | null {
  const targetPath = path.trim().replace(/^\/+/, "");
  const segments = targetPath.split("/");
  if (
    !isRepoTaskPath(targetPath) ||
    (targetPath !== task.path && reservedPaths.has(targetPath)) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  )
    return null;
  return parseRepoTask(targetPath, task.content);
}

/** Assign (or clear) an agent without disturbing any other task metadata. */
export function updateRepoTaskAgent(content: string, agent: string | undefined): string {
  return updateFrontmatter(content, (document) => {
    const normalized = agent?.trim();
    if (normalized) document.set("agent", normalized);
    else document.delete("agent");
  });
}

/** The first level-one Markdown heading drives the inferred task title. */
export function repoTaskHeadingTitle(content: string): string | undefined {
  return firstHeading(parseMarkdownFrontmatter(content).body)?.title;
}

/** Select the inferred title in the first level-one heading of the full file. */
export function repoTaskHeadingSelection(
  content: string,
): { start: number; end: number } | undefined {
  const frontmatter = parseMarkdownFrontmatter(content);
  const heading = firstHeading(frontmatter.body);
  if (heading === undefined) return undefined;
  const headingText = frontmatter.body.slice(heading.start, heading.end);
  const titleOffset = headingText.indexOf(heading.title);
  if (titleOffset < 0) return undefined;
  const bodyOffset = content.length - frontmatter.body.length;
  const start = bodyOffset + heading.start + titleOffset;
  return { start, end: start + heading.title.length };
}

/**
 * Rename a task after its first heading while keeping it in the same tasks
 * directory. The filename is bounded for readable URLs and collision-safe.
 */
export function repoTaskPathForTitle(
  currentPath: string,
  title: string,
  existingPaths: ReadonlySet<string>,
): string {
  const directory = taskDirectoryForPath(currentPath) ?? "tasks";
  const base = slugify(title, MAX_TASK_FILENAME_SLUG_LENGTH) || "task";
  let suffix = 1;
  let candidate = `${directory}/${base}.md`;
  while (candidate !== currentPath && existingPaths.has(candidate)) {
    suffix += 1;
    const suffixText = `-${suffix}`;
    const collisionBase = base.slice(0, MAX_TASK_FILENAME_SLUG_LENGTH - suffixText.length);
    candidate = `${directory}/${collisionBase}${suffixText}.md`;
  }
  return candidate;
}

/** Deterministic task-agent path, stable across retries. */
export function repoTaskAgentPath(repoPath: string, taskPath: string): string {
  const repoSlug = slugify(pathSegments(repoPath).at(-1) ?? "repo", 48) || "repo";
  const taskSlug = slugify(taskPath.replace(/\.(?:md|markdown)$/i, ""), 120) || "task";
  return `/agents/repos/${repoSlug}/tasks/${taskSlug}`;
}

/**
 * Pure assignment projection. Calling code commits `content` before sending
 * `instructions`, so a born agent always sees its durable task assignment.
 */
export function prepareRepoTaskAssignment(
  task: RepoTask,
  repoPath: string,
): { agentPath: string; content: string; instructions: string } {
  const agentPath = repoTaskAgentPath(repoPath, task.path);
  const stateContent =
    task.state === "in-progress" ? task.content : updateRepoTaskState(task.content, "in-progress");
  const content = updateRepoTaskAgent(stateContent, agentPath);
  return {
    agentPath,
    content,
    instructions: [
      `Work on the repo task at ${task.path} in ${repoPath}.`,
      "First, verify that the task frontmatter state is `in-progress`; set and commit it before doing any other work if it is not.",
      "Read the task Markdown before starting and treat it as the durable source of truth.",
      "Keep that task file current as you work. Commit implementation changes and task updates to the same repo.",
      "Keep a lightweight work log in a final `## Comments` section. Add entries as `### <ISO timestamp> — <agent path>` followed by a short Markdown note; keep this section at the end of the file.",
      "When the work is ready for human review, summarize the result in Comments and set the task frontmatter state to `in-review`.",
    ].join("\n\n"),
  };
}

/** The one atomic repo commit that makes a renamed task durable and assigned. */
export function repoTaskAssignmentFileChanges(
  task: RepoTask,
  content: string,
  renamedFromPath?: string,
): RepoFileChange[] {
  return [
    ...(renamedFromPath === undefined || renamedFromPath === task.path
      ? []
      : [{ path: renamedFromPath, delete: true } as const]),
    { path: task.path, content },
  ];
}

/** Project the assignment commit onto a possibly stale file-list cache. */
export function repoTaskAssignmentHeadPaths(
  headPaths: readonly string[],
  task: RepoTask,
  renamedFromPath?: string,
): string[] {
  const paths = new Set(headPaths);
  if (renamedFromPath !== undefined && renamedFromPath !== task.path) paths.delete(renamedFromPath);
  paths.add(task.path);
  return [...paths].sort();
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
  const unknown = new Set(tasks.map(taskColumnState));
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
        tasks: row.tasks.filter((task) => taskColumnState(task) === state),
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

/**
 * UI-only query projection from literal task metadata to the v1 Kanban
 * columns. This never rewrites frontmatter: a legacy `state: backlog` remains
 * literal in `task.state` and on disk, but shares the single Todo column.
 */
export function taskColumnState(task: Pick<RepoTask, "state">): string {
  return task.state === "backlog" ? DEFAULT_TASK_STATE : task.state;
}

export function taskStateLabel(state: string): string {
  return state
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

/** Uncommitted board status for a task path (working or staged). */
export type RepoTaskChangeStatus = "added" | "modified" | "deleted";

export type RepoTaskChange = {
  path: string;
  status: RepoTaskChangeStatus;
  title: string;
  entry: FileEntry;
};

/**
 * Task-only working-tree changes for the board's staged/visual + commit UI.
 * Titles prefer live content, then HEAD content for pure deletions.
 */
export function listRepoTaskChanges(
  changes: WorkingTreeChanges,
  headPaths: ReadonlySet<string>,
  headContents: Readonly<Record<string, string>> = {},
): RepoTaskChange[] {
  const listed: RepoTaskChange[] = [];
  for (const [path, change] of changes) {
    if (!isRepoTaskPath(path)) continue;
    const entry = effectiveEntry(change);
    if (entry === undefined) continue;
    const status: RepoTaskChangeStatus =
      entry.type === "delete" ? "deleted" : headPaths.has(path) ? "modified" : "added";
    const liveContent = textContentFromEntry(entry);
    const content = liveContent ?? headContents[path];
    const parsed = content === undefined ? null : parseRepoTask(path, content);
    listed.push({
      path,
      status,
      title:
        parsed?.title ?? (pathSegments(path).at(-1) ?? "task").replace(/\.(?:md|markdown)$/i, ""),
      entry,
    });
  }
  return listed.sort((left, right) => left.path.localeCompare(right.path));
}

/** File changes for a tasks-only commit (ignores non-task paths and stage mode). */
export function taskCommitFileChanges(changes: WorkingTreeChanges): {
  paths: string[];
  fileChanges: RepoFileChange[];
} {
  const paths: string[] = [];
  const fileChanges: RepoFileChange[] = [];
  for (const [path, change] of changes) {
    if (!isRepoTaskPath(path)) continue;
    const entry = effectiveEntry(change);
    if (entry === undefined) continue;
    paths.push(path);
    if (entry.type === "delete") fileChanges.push({ path, delete: true });
    else if (entry.type === "write-base64")
      fileChanges.push({ path, contentBase64: entry.contentBase64 });
    else fileChanges.push({ path, content: entry.content });
  }
  return { paths, fileChanges };
}

/** Deterministic commit message when AI is unavailable or empty. */
export function fallbackTaskCommitMessage(taskChanges: readonly RepoTaskChange[]): string {
  if (taskChanges.length === 0) return "Update tasks";
  const added = taskChanges.filter((change) => change.status === "added");
  const modified = taskChanges.filter((change) => change.status === "modified");
  const deleted = taskChanges.filter((change) => change.status === "deleted");
  const parts: string[] = [];
  if (added.length === 1) parts.push(`add ${added[0]!.title}`);
  else if (added.length > 1) parts.push(`add ${added.length} tasks`);
  if (modified.length === 1) parts.push(`update ${modified[0]!.title}`);
  else if (modified.length > 1) parts.push(`update ${modified.length} tasks`);
  if (deleted.length === 1) parts.push(`delete ${deleted[0]!.title}`);
  else if (deleted.length > 1) parts.push(`delete ${deleted.length} tasks`);
  const body = parts.join(", ");
  return body === "" ? "Update tasks" : `${body[0]!.toUpperCase()}${body.slice(1)}`;
}

/** Prompt payload for `itx.ai.run` commit-message generation. */
export function taskCommitMessagePrompt(taskChanges: readonly RepoTaskChange[]): {
  system: string;
  user: string;
} {
  const lines = taskChanges.map((change) => {
    const verb =
      change.status === "added" ? "Added" : change.status === "deleted" ? "Deleted" : "Edited";
    return `- ${verb}: ${change.title} (${change.path})`;
  });
  return {
    system:
      "You write short git commit messages for a task board. Reply with one line only, imperative mood, no quotes, no trailing period, max 72 characters.",
    user: `Write a commit message for these task changes:\n${lines.join("\n")}`,
  };
}

function textContentFromEntry(entry: FileEntry): string | undefined {
  if (entry.type === "write") return entry.content;
  if (entry.type !== "write-base64") return undefined;
  try {
    const bytes = Uint8Array.from(atob(entry.contentBase64.trim()), (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
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

function taskCommentsSection(
  body: string,
): { before: string; comments: RepoTaskComment[] } | undefined {
  try {
    const sectionMatches = [...body.matchAll(/^##\s+Comments\s*#*\s*$/gim)];
    const section = sectionMatches.at(-1);
    if (section?.index === undefined) return undefined;
    const start = section.index;
    let contentStart = start + section[0].length;
    if (body.slice(contentStart, contentStart + 2) === "\r\n") contentStart += 2;
    else if (body[contentStart] === "\n") contentStart += 1;
    const raw = body.slice(contentStart);
    const headings = [...raw.matchAll(/^###\s+(.+?)\s*#*\s*$/gm)];
    if (headings.length === 0) {
      const comment = raw.trim();
      return {
        before: body.slice(0, start).trimEnd(),
        comments: comment === "" ? [] : [{ heading: undefined, body: comment }],
      };
    }
    const comments: RepoTaskComment[] = [];
    const preface = raw.slice(0, headings[0]!.index).trim();
    if (preface !== "") comments.push({ heading: undefined, body: preface });
    for (const [index, heading] of headings.entries()) {
      const headingStart = heading.index ?? 0;
      const bodyStart = headingStart + heading[0].length;
      const bodyEnd = headings[index + 1]?.index ?? raw.length;
      comments.push({
        heading: heading[1]?.trim() || undefined,
        body: raw.slice(bodyStart, bodyEnd).trim(),
      });
    }
    return { before: body.slice(0, start).trimEnd(), comments };
  } catch {
    // Task Markdown is user-authored. A malformed log must never take down the board.
    return undefined;
  }
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

function slugify(value: string, maxLength = Number.POSITIVE_INFINITY): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
}
