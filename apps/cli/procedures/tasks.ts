import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseMs } from "ms";
import { z } from "zod/v4";
import {
  getTasksDir,
  getArchivedDir,
  parseTaskFile,
  processPendingTasks,
  serializeTask,
  slugToFilename,
  filenameToSlug,
  completeTask,
  abandonTask,
  reopenTask,
  TaskPriority,
  type ParsedTask,
} from "@iterate-com/daemon/server/cron-tasks/scheduler.ts";
import { t } from "../trpc.ts";

// ============================================================================
// Input Schemas
// ============================================================================

/**
 * Parse a duration string (e.g. "1h", "30m", "2 days") or ISO timestamp.
 */
const DueInput = z
  .string()
  .transform((val, ctx) => {
    if (val.match(/^\d{4}-/)) {
      // Looks like an ISO timestamp
      const date = new Date(val);
      if (!Number.isFinite(date.getTime())) {
        ctx.addIssue({ code: "custom", message: `Invalid ISO timestamp: "${val}"` });
        return z.NEVER;
      }
      return date;
    }
    const ms = parseMs(val);
    if (!Number.isFinite(ms)) {
      ctx.addIssue({
        code: "custom",
        message: `Invalid duration: "${val}". Use formats like "1h", "30m", "2 days", "1 week"`,
      });
      return z.NEVER;
    }
    return new Date(Date.now() + ms);
  })
  .describe(
    "Duration until task runs (e.g. '1h', '30m', '2 days') or ISO timestamp (e.g. '2026-01-29T09:00:00Z')",
  );

const SlugInput = z.string().describe("Task slug (e.g. 'daily-report' or 'daily-report.md')");

const NoteInput = z
  .string()
  .describe("Note explaining outcome, reason, or context (e.g. 'Done. Posted to #general')");

// ============================================================================
// Helpers
// ============================================================================

async function listTasks(): Promise<Array<{ slug: string; filename: string; task: ParsedTask }>> {
  const tasksDir = await getTasksDir();

  try {
    await fs.mkdir(tasksDir, { recursive: true });
  } catch {
    // ignore
  }

  const entries = await fs.readdir(tasksDir, { withFileTypes: true });
  const mdFiles = entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name);

  const results: Array<{ slug: string; filename: string; task: ParsedTask }> = [];

  for (const file of mdFiles) {
    const content = await fs.readFile(path.join(tasksDir, file), "utf-8");
    const task = parseTaskFile(content, file);
    if (task) {
      results.push({ slug: task.slug, filename: file, task });
    }
  }

  return results;
}

async function getTaskBySlug(slug: string): Promise<{ task: ParsedTask; filepath: string } | null> {
  const tasksDir = await getTasksDir();
  const filename = slugToFilename(slug);

  try {
    const filepath = path.join(tasksDir, filename);
    const content = await fs.readFile(filepath, "utf-8");
    const task = parseTaskFile(content, filename);
    if (task) return { task, filepath };
  } catch {
    // Not found
  }

  return null;
}

// ============================================================================
// Router
// ============================================================================

export const tasksRouter = t.router({
  list: t.procedure.meta({ description: "List active tasks" }).query(async () => {
    const tasks = await listTasks();
    return {
      tasks: tasks.map(({ slug, task }) => ({
        slug,
        state: task.frontmatter.state,
        due: task.frontmatter.due,
        schedule: task.frontmatter.schedule,
        priority: task.frontmatter.priority,
        lockedBy: task.frontmatter.lockedBy,
      })),
    };
  }),

  get: t.procedure
    .meta({ description: "Get a task by slug" })
    .input(z.object({ slug: SlugInput }))
    .query(async ({ input }) => {
      const result = await getTaskBySlug(input.slug);
      if (!result) {
        return { error: `Task not found: ${input.slug}`, task: null };
      }
      return { task: result.task, filepath: result.filepath };
    }),

  add: t.procedure
    .meta({ description: "Add a new task" })
    .input(
      z.object({
        slug: SlugInput.describe("Task slug (e.g. 'daily-report')"),
        body: z.string().describe("Task body (markdown content)"),
        due: DueInput,
        schedule: z.string().optional().describe("Cron expression for recurring tasks"),
        priority: TaskPriority.optional().default("normal"),
      }),
    )
    .mutation(async ({ input }) => {
      const tasksDir = await getTasksDir();
      await fs.mkdir(tasksDir, { recursive: true });

      const filename = slugToFilename(input.slug);
      const filepath = path.join(tasksDir, filename);

      // Check if already exists
      try {
        await fs.access(filepath);
        return { error: `Task already exists: ${input.slug}`, created: false };
      } catch {
        // Good, doesn't exist
      }

      const task: Omit<ParsedTask, "raw"> = {
        slug: filenameToSlug(filename),
        filename,
        frontmatter: {
          state: "pending",
          due: input.due.toISOString(),
          schedule: input.schedule,
          priority: input.priority,
        },
        body: input.body,
      };

      await fs.writeFile(filepath, serializeTask(task));
      return { created: true, slug: task.slug, filepath };
    }),

  complete: t.procedure
    .meta({ description: "Mark a task as completed and move to archive" })
    .input(z.object({ slug: SlugInput, note: NoteInput }))
    .mutation(async ({ input }) => {
      return await completeTask(input.slug, input.note);
    }),

  abandon: t.procedure
    .meta({ description: "Abandon a task and move to archive" })
    .input(z.object({ slug: SlugInput, note: NoteInput }))
    .mutation(async ({ input }) => {
      return await abandonTask(input.slug, input.note);
    }),

  reopen: t.procedure
    .meta({ description: "Reopen a task from archive" })
    .input(z.object({ slug: SlugInput, note: NoteInput }))
    .mutation(async ({ input }) => {
      return await reopenTask(input.slug, input.note);
    }),

  processPending: t.procedure
    .meta({ description: "Process tasks that are due" })
    .mutation(async () => {
      await processPendingTasks();
      return { success: true };
    }),
});
