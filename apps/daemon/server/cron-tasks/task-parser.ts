/**
 * Task parsing utilities - pure functions with no side effects.
 */
import { parseDocument } from "yaml";
import { z } from "zod/v4";

// ============================================================================
// Task Schema & Types
// ============================================================================

/** Task states for active tasks (in pending/) */
export const ActiveTaskState = z.enum(["pending", "in_progress"]);
export type ActiveTaskState = z.infer<typeof ActiveTaskState>;

/** Task states for archived tasks (in archived/) */
export const ArchivedTaskState = z.enum(["completed", "abandoned"]);
export type ArchivedTaskState = z.infer<typeof ArchivedTaskState>;

/** All possible task states */
export const TaskState = z.enum(["pending", "in_progress", "completed", "abandoned"]);
export type TaskState = z.infer<typeof TaskState>;

export const TaskPriority = z.enum(["low", "normal", "high"]);
export type TaskPriority = z.infer<typeof TaskPriority>;

export const TaskFrontmatter = z.object({
  state: TaskState,
  due: z.string(), // ISO timestamp
  schedule: z.string().optional(), // cron expression for recurring
  lockedBy: z.string().optional(), // agent slug when in_progress
  lockedAt: z.string().optional(), // ISO timestamp when locked
  priority: TaskPriority.optional(),
});

export type TaskFrontmatter = z.infer<typeof TaskFrontmatter>;

export interface ParsedTask {
  slug: string;
  filename: string;
  frontmatter: TaskFrontmatter;
  body: string;
  raw: string;
}

// ============================================================================
// Slug/Filename Helpers
// ============================================================================

/** Convert a slug to a filename (adds .md if not present) */
export function slugToFilename(slug: string): string {
  return slug.endsWith(".md") ? slug : `${slug}.md`;
}

/** Convert a filename to a slug (removes .md if present) */
export function filenameToSlug(filename: string): string {
  return filename.endsWith(".md") ? filename.slice(0, -3) : filename;
}

// ============================================================================
// Parsing Functions
// ============================================================================

/**
 * Parse a task markdown file into frontmatter and body.
 */
export function parseTaskFile(content: string, filename: string): ParsedTask | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) {
    console.warn(`[cron-tasks] Invalid task format (no frontmatter): ${filename}`);
    return null;
  }

  try {
    const doc = parseDocument(fmMatch[1]);
    const raw = doc.toJS();
    const result = TaskFrontmatter.safeParse(raw);

    if (!result.success) {
      console.warn(
        `[cron-tasks] Invalid task frontmatter: ${filename}`,
        z.prettifyError(result.error),
      );
      return null;
    }

    return {
      slug: filenameToSlug(filename),
      filename,
      frontmatter: result.data,
      body: fmMatch[2].trim(),
      raw: content,
    };
  } catch (err) {
    console.warn(`[cron-tasks] Failed to parse frontmatter: ${filename}`, err);
    return null;
  }
}

/**
 * Serialize a task back to markdown.
 */
export function serializeTask(task: Omit<ParsedTask, "raw">): string {
  const lines = ["---"];
  lines.push(`state: ${task.frontmatter.state}`);
  lines.push(`due: ${task.frontmatter.due}`);
  if (task.frontmatter.schedule) {
    lines.push(`schedule: "${task.frontmatter.schedule}"`);
  }
  if (task.frontmatter.lockedBy) {
    lines.push(`lockedBy: ${task.frontmatter.lockedBy}`);
  }
  if (task.frontmatter.lockedAt) {
    lines.push(`lockedAt: ${task.frontmatter.lockedAt}`);
  }
  lines.push(`priority: ${task.frontmatter.priority || "normal"}`);
  lines.push("---");
  lines.push("");
  lines.push(task.body);

  return lines.join("\n");
}

/**
 * Get priority order for sorting (high = 0, normal = 1, low = 2).
 */
export function getPriorityOrder(priority?: TaskFrontmatter["priority"]): number {
  switch (priority) {
    case "high":
      return 0;
    case "low":
      return 2;
    default:
      return 1;
  }
}
