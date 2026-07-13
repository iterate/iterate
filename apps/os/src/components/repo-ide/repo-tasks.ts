import { parseDocument, type Document } from "yaml";

const DEFAULT_TASK_STATE = "todo";

const STANDARD_TASK_STATES = ["backlog", DEFAULT_TASK_STATE, "in-progress", "done"] as const;

export type RepoTask = {
  path: string;
  taskDirectoryPath: string;
  title: string;
  description: string;
  state: string;
  explicitLabels: string[];
  labels: string[];
  content: string;
};

/** Markdown files below any directory segment named `tasks` are repo tasks. */
export function isRepoTaskPath(path: string): boolean {
  const segments = pathSegments(path);
  return /\.(?:md|markdown)$/i.test(segments.at(-1) ?? "") && segments.includes("tasks");
}

/** The nearest `tasks` directory owns a task; its parent becomes the folder label. */
export function taskDirectoryForPath(path: string): string | null {
  if (!isRepoTaskPath(path)) return null;
  const segments = pathSegments(path);
  const tasksIndex = segments.lastIndexOf("tasks");
  return segments.slice(0, tasksIndex + 1).join("/");
}

export function parseRepoTask(path: string, content: string): RepoTask | null {
  const taskDirectoryPath = taskDirectoryForPath(path);
  if (taskDirectoryPath === null) return null;

  const frontmatter = readFrontmatter(content);
  const metadata = documentRecord(frontmatter.document);
  const state = stringValue(metadata.state) ?? stringValue(metadata.status) ?? DEFAULT_TASK_STATE;
  const explicitLabels = uniqueStrings([
    ...stringArray(metadata.labels),
    ...stringArray(metadata.tags),
  ]);
  const folderPath = taskDirectoryPath.split("/").slice(0, -1).join("/");
  const folderLabel = `folder:/${folderPath}`;
  const heading = firstHeading(frontmatter.body);
  const fallbackTitle = (pathSegments(path).at(-1) ?? "task").replace(/\.(?:md|markdown)$/i, "");

  return {
    path,
    taskDirectoryPath,
    title: heading?.title ?? fallbackTitle,
    description:
      heading === undefined
        ? frontmatter.body.trim()
        : `${frontmatter.body.slice(0, heading.start)}${frontmatter.body.slice(heading.end)}`.trim(),
    state,
    explicitLabels,
    labels: uniqueStrings([folderLabel, ...explicitLabels]),
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

/** Folder labels are inferred, so callers pass only labels that belong in YAML. */
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
): { path: string; content: string } | null {
  const normalizedTitle = title.trim();
  if (normalizedTitle === "") return null;

  const base = slugify(normalizedTitle) || "task";
  let suffix = 1;
  let path = `tasks/${base}.md`;
  while (existingPaths.has(path)) {
    suffix += 1;
    path = `tasks/${base}-${suffix}.md`;
  }
  return { path, content: `# ${normalizedTitle}\n` };
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

function firstHeading(body: string): { start: number; end: number; title: string } | undefined {
  const match = /^#\s+(.+?)\s*#*\s*$/m.exec(body);
  if (match === null || match.index === undefined) return undefined;
  let end = match.index + match[0].length;
  if (body.slice(end, end + 2) === "\r\n") end += 2;
  else if (body[end] === "\n") end += 1;
  return { start: match.index, end, title: match[1]!.trim() };
}

function readFrontmatter(content: string): {
  body: string;
  document: Document;
  exists: boolean;
} {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(content);
  if (match === null) return { body: content, document: parseDocument(""), exists: false };
  return {
    body: content.slice(match[0].length),
    document: parseDocument(match[1] ?? ""),
    exists: true,
  };
}

function documentRecord(document: Document): Record<string, unknown> {
  try {
    const value: unknown = document.toJS();
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function updateFrontmatter(
  content: string,
  update: (document: Document, metadata: Record<string, unknown>) => void,
): string {
  const frontmatter = readFrontmatter(content);
  update(frontmatter.document, documentRecord(frontmatter.document));
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
