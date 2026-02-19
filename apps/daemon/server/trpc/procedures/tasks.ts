import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseMs } from "ms";
import { z } from "zod/v4";
import {
  TaskPriority,
  type ParsedTask,
  abandonTask,
  completeTask,
  filenameToSlug,
  getTasksDir,
  parseTaskFile,
  processPendingTasks,
  reopenTask,
  serializeTask,
  slugToFilename,
} from "../../cron-tasks/scheduler.ts";
import { createTRPCRouter, publicProcedure } from "../init.ts";

/** Parse a duration string (e.g. "1h", "30m", "2 days") or ISO timestamp. */
const DueInput = z
  .string()
  .transform((value, ctx) => {
    if (value.match(/^\d{4}-/)) {
      // looks like an ISO timestamp
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) {
        ctx.addIssue({ code: "custom", message: `Invalid ISO timestamp: "${value}"` });
        return z.NEVER;
      }
      return date;
    }

    const durationMs = parseMs(value);
    if (!Number.isFinite(durationMs)) {
      ctx.addIssue({
        code: "custom",
        message: `Invalid duration: "${value}". Use formats like "1h", "30m", "2 days", "1 week"`,
      });
      return z.NEVER;
    }

    return new Date(Date.now() + durationMs);
  })
  .describe(
    "Duration until task runs (e.g. '1h', '30m', '2 days') or ISO timestamp (e.g. '2026-01-29T09:00:00Z' or '2026-01-29T09:00:00-07:00'). Note that ISO timestamps will be converted to UTC - but you will need to know the user's home timezone to set a correct due date in their local time.",
  );

const SlugInput = z.string().describe("Task slug (e.g. 'daily-report')");

const NoteInput = z
  .string()
  .describe("Note explaining outcome, reason, or context (e.g. 'Done. Posted to #general')");

async function listTasks(): Promise<Array<{ slug: string; filename: string; task: ParsedTask }>> {
  const tasksDir = await getTasksDir();

  await fs.mkdir(tasksDir, { recursive: true });

  const entries = await fs.readdir(tasksDir, { withFileTypes: true });
  const mdFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md"));

  const tasks: Array<{ slug: string; filename: string; task: ParsedTask }> = [];

  for (const entry of mdFiles) {
    const content = await fs.readFile(path.join(tasksDir, entry.name), "utf-8");
    const task = parseTaskFile(content, entry.name);
    if (task) {
      tasks.push({ slug: task.slug, filename: entry.name, task });
    }
  }

  return tasks;
}

async function getTaskBySlug(slug: string) {
  const tasksDir = await getTasksDir();
  const filename = slugToFilename(slug);

  try {
    const filepath = path.join(tasksDir, filename);
    const content = await fs.readFile(filepath, "utf-8");
    const task = parseTaskFile(content, filename);
    if (task) {
      return { task, filepath };
    }
  } catch {
    // not found
  }

  return null;
}

export const tasksRouter = createTRPCRouter({
  list: publicProcedure.meta({ description: "List active tasks" }).query(async () => {
    return listTasks();
  }),

  get: publicProcedure
    .meta({ description: "Get a task by slug" })
    .input(z.object({ slug: SlugInput }))
    .query(async ({ input }) => {
      return getTaskBySlug(input.slug);
    }),

  add: publicProcedure
    .meta({ description: "Add a new task" })
    .input(
      z.object({
        slug: SlugInput.describe("Task slug (e.g. 'daily-report')"),
        body: z.string().describe("Task body (markdown content)"),
        due: DueInput,
        schedule: z
          .string()
          .optional()
          .describe("Cron expression, use if this is a recurring task"),
        priority: TaskPriority.default("normal"),
      }),
    )
    .mutation(async ({ input }) => {
      const tasksDir = await getTasksDir();
      await fs.mkdir(tasksDir, { recursive: true });

      const filename = slugToFilename(input.slug);
      const filepath = path.join(tasksDir, filename);

      try {
        await fs.access(filepath);
        return { created: false, error: `Task already exists: ${input.slug}` };
      } catch {
        // expected when file doesn't exist
      }

      const slug = filenameToSlug(filename);
      const content = serializeTask({
        slug,
        filename,
        frontmatter: {
          state: "pending",
          due: input.due.toISOString(),
          schedule: input.schedule,
          priority: input.priority,
        },
        body: input.body,
      });
      await fs.writeFile(filepath, content);
      return { created: true, slug, filepath };
    }),

  complete: publicProcedure
    .meta({ description: "Mark a task as completed and move to archive" })
    .input(z.object({ slug: SlugInput, note: NoteInput }))
    .mutation(async ({ input }) => {
      return completeTask(input.slug, input.note);
    }),

  abandon: publicProcedure
    .meta({ description: "Abandon a task and move to archive" })
    .input(z.object({ slug: SlugInput, note: NoteInput }))
    .mutation(async ({ input }) => {
      return abandonTask(input.slug, input.note);
    }),

  reopen: publicProcedure
    .meta({ description: "Reopen a task from archive" })
    .input(z.object({ slug: SlugInput, note: NoteInput }))
    .mutation(async ({ input }) => {
      return reopenTask(input.slug, input.note);
    }),

  processPending: publicProcedure
    .meta({ description: "Process tasks that are due" })
    .mutation(async () => {
      await processPendingTasks();
      return { success: true };
    }),
});
