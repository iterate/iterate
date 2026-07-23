/**
 * Pure task-file model, ported from the iterate monorepo's repo-ide task
 * board (apps/os). Tasks are Markdown files below any directory segment named
 * `tasks`, with YAML frontmatter carrying `state` / `labels` / `agent`. This
 * module is text-in, text-out only — no storage, no network, no UI.
 */
import { parseDocument, type Document } from "yaml";
import { BOARD_COLUMNS, type TaskCard, type TaskChangeSummary } from "./state.ts";

const DEFAULT_TASK_STATE = BOARD_COLUMNS[0];
const MAX_TASK_FILENAME_SLUG_LENGTH = 64;

/** Markdown files below any directory segment named `tasks` are task cards. */
export function isTaskFilePath(path: string): boolean {
  const segments = pathSegments(path);
  return /\.(?:md|markdown)$/i.test(segments.at(-1) ?? "") && segments.includes("tasks");
}

/**
 * Parse one task file into a card. Title prefers frontmatter `title`, then
 * the first level-one Markdown heading, then the filename. A legacy
 * `state: backlog` stays literal on disk but lands in the Todo column, so the
 * card's state is normalized here.
 */
export function parseTaskCard(path: string, source: string): TaskCard {
  const frontmatter = parseMarkdownFrontmatter(source);
  if (frontmatter.invalid) {
    // Broken YAML: the whole file is plain text — no state, no tags, and
    // the UI surfaces the breakage instead of guessing.
    return {
      path,
      title: firstHeadingTitle(source) ?? path,
      state: normalizeTaskState(undefined),
      labels: [],
      agent: null,
      source,
      frontmatterError: true,
    };
  }
  const metadata = markdownFrontmatterRecord(frontmatter.document);
  return {
    path,
    // A task with no heading (and no title key) is named by its full path.
    title: stringValue(metadata.title) ?? firstHeadingTitle(frontmatter.body) ?? path,
    state: normalizeTaskState(stringValue(metadata.state)),
    // `tags` is the canonical key; `labels` stays readable for apps/os
    // compatibility and older files.
    labels: uniqueStrings([...stringArray(metadata.tags), ...stringArray(metadata.labels)]),
    agent: stringValue(metadata.agent) ?? null,
    source,
    frontmatterError: false,
  };
}

/** Change only the task's state, preserving its Markdown body and unrelated YAML keys. */
export function setTaskCardState(source: string, state: string): string {
  const normalized = state.trim() || DEFAULT_TASK_STATE;
  return updateFrontmatter(source, (document) => {
    document.set("state", normalized);
  });
}

/** Record the assigned agent in frontmatter, preserving everything else. */
export function setTaskCardAgent(source: string, agentPath: string): string {
  return updateFrontmatter(source, (document) => {
    document.set("agent", agentPath);
  });
}

/** Replace the task's tags. Writes the canonical `tags` key (migrating any
 * legacy `labels` key away); empty clears both. */
export function setTaskCardLabels(source: string, labels: readonly string[]): string {
  return updateFrontmatter(source, (document) => {
    document.delete("labels");
    if (labels.length === 0) document.delete("tags");
    else document.set("tags", [...labels]);
  });
}

/** The conventional agent path for a task — apps/os's repoTaskAgentPath. */
export function taskAgentPath(repoPath: string, taskPath: string): string {
  const repoSlug = slugify(pathSegments(repoPath).at(-1) ?? "repo", 48) || "repo";
  const taskSlug = slugify(taskPath.replace(/\.(?:md|markdown)$/i, ""), 120) || "task";
  return `/agents/repos/${repoSlug}/tasks/${taskSlug}`;
}

/** The kickoff brief a freshly assigned agent receives — apps/os's wording. */
export function taskAssignmentInstructions(repoPath: string, taskPath: string): string {
  return [
    `Work on the repo task at ${taskPath} in ${repoPath}.`,
    "First, verify that the task frontmatter state is `in-progress`; set and commit it before doing any other work if it is not.",
    "Read the task Markdown before starting and treat it as the durable source of truth.",
    "Keep that task file current as you work. Commit implementation changes and task updates to the same repo.",
    "Keep a lightweight work log in a final `## Comments` section. Add entries as `### <ISO timestamp> — <agent path>` followed by a short Markdown note; keep this section at the end of the file.",
    "When the work is ready for human review, summarize the result in Comments and set the task frontmatter state to `in-review`.",
  ].join("\n\n");
}

/**
 * Project a brand-new task file: slugified filename under `tasks/`,
 * frontmatter with the state (plus `author` when the creator is known),
 * `# Title` heading, then the body. Collision avoidance is the caller's job
 * via `taskPathForTitle(title, suffix)`.
 */
export function newTaskFile(input: {
  title: string;
  body?: string;
  state?: string;
  author?: string;
}): {
  path: string;
  content: string;
} {
  const title = input.title.trim() || "Task";
  const state = input.state?.trim() || DEFAULT_TASK_STATE;
  const document = parseDocument("");
  document.set("state", state);
  if (input.author !== undefined && input.author.trim() !== "") {
    document.set("author", input.author.trim());
  }
  const yaml = document.toString().trimEnd();
  const body = input.body?.trim();
  return {
    path: taskPathForTitle(input.title),
    content: `---\n${yaml}\n---\n\n# ${title}\n${body ? `\n${body}\n` : ""}`,
  };
}

/**
 * The conventional path for a task with this title. The filename is bounded
 * for readable URLs; a caller-supplied suffix ("2", "3", …) resolves
 * collisions without letting the name outgrow the bound.
 */
export function taskPathForTitle(title: string, suffix?: string): string {
  const base = slugify(title, MAX_TASK_FILENAME_SLUG_LENGTH) || "task";
  if (suffix === undefined) return `tasks/${base}.md`;
  const suffixText = `-${suffix}`;
  const collisionBase =
    base.slice(0, Math.max(1, MAX_TASK_FILENAME_SLUG_LENGTH - suffixText.length)).replace(/-+$/g, "") ||
    "task";
  return `tasks/${collisionBase}${suffixText}.md`;
}

/** Deterministic commit message when AI is unavailable or empty. */
export function fallbackCommitMessage(changes: readonly TaskChangeSummary[]): string {
  if (changes.length === 0) return "Update tasks";
  const added = changes.filter((change) => change.status === "added");
  const modified = changes.filter((change) => change.status === "modified");
  const deleted = changes.filter((change) => change.status === "deleted");
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

/** Prompt payload for `ai.run` commit-message generation. */
export function taskCommitMessagePrompt(changes: readonly TaskChangeSummary[]): {
  system: string;
  user: string;
} {
  const lines = changes.map((change) => {
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

/**
 * The four canonical columns in board order, then any custom states as
 * trailing columns. Assignment goes by normalized state, so `backlog` cards
 * share the Todo column without their files being rewritten.
 */
export function columnsForTasks(tasks: TaskCard[]): Array<{ state: string; tasks: TaskCard[] }> {
  const custom = new Set<string>(tasks.map((task) => normalizeTaskState(task.state)));
  for (const state of BOARD_COLUMNS) custom.delete(state);
  const states = [...BOARD_COLUMNS, ...[...custom].sort((left, right) => left.localeCompare(right))];
  return states.map((state) => ({
    state,
    tasks: tasks.filter((task) => normalizeTaskState(task.state) === state),
  }));
}

/**
 * The column a literal state lands in — the drag guard uses this so dropping
 * a legacy `backlog` card back onto Todo never rewrites its file.
 */
export function taskColumnState(state: string): string {
  return normalizeTaskState(state);
}

/**
 * Query projection from literal task metadata to the v1 Kanban columns. This
 * never rewrites frontmatter: a legacy `state: backlog` shares the single
 * Todo column.
 */
function normalizeTaskState(state: string | undefined): string {
  const literal = state?.trim() ?? "";
  if (literal === "" || literal === "backlog") return DEFAULT_TASK_STATE;
  return literal;
}

/** The first level-one Markdown heading drives the inferred task title. */
function firstHeadingTitle(body: string): string | undefined {
  const match = /^#\s+(.+?)\s*#*\s*$/m.exec(body);
  return match?.[1]?.trim();
}

function parseMarkdownFrontmatter(content: string): {
  body: string;
  document: Document;
  exists: boolean;
  invalid: boolean;
} {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(content);
  if (match === null) {
    return { body: content, document: parseDocument(""), exists: false, invalid: false };
  }
  const document = parseDocument(match[1] ?? "");
  return {
    body: content.slice(match[0].length),
    document,
    exists: true,
    invalid: document.errors.length > 0,
  };
}

function markdownFrontmatterRecord(document: Document): Record<string, unknown> {
  try {
    const value: unknown = document.toJS();
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function updateFrontmatter(content: string, update: (document: Document) => void): string {
  const frontmatter = parseMarkdownFrontmatter(content);
  update(frontmatter.document);
  const yaml = frontmatter.document.toString().trimEnd();
  if (yaml === "" || yaml === "{}") return frontmatter.body;
  const body = frontmatter.exists ? frontmatter.body : `\n${content}`;
  return `---\n${yaml}\n---\n${body}`;
}

function pathSegments(path: string): string[] {
  return path.split("/").filter(Boolean);
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

function slugify(value: string, maxLength: number): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
}
