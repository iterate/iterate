import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  abandonTask,
  completeTask,
  filenameToSlug,
  getTasksDir,
  parseTaskFile,
  processPendingTasks,
  reopenTask,
  serializeTask,
  slugToFilename,
  TaskPriority,
  type ParsedTask,
} from "@iterate-com/daemon/server/cron-tasks/scheduler.ts";
import { parse as parseMs } from "ms";
import { z } from "zod/v4";
import { t } from "../trpc.ts";

const DueInput = z
  .string()
  .transform((value, ctx) => {
    if (value.match(/^\d{4}-/)) {
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) {
        ctx.addIssue({ code: "custom", message: `Invalid ISO timestamp: "${value}"` });
        return z.NEVER;
      }
      return date;
    }

    const milliseconds = parseMs(value);
    if (!Number.isFinite(milliseconds)) {
      ctx.addIssue({
        code: "custom",
        message: `Invalid duration: "${value}". Use formats like "1h", "30m", "2 days", "1 week"`,
      });
      return z.NEVER;
    }

    return new Date(Date.now() + milliseconds);
  })
  .describe(
    "Duration until task runs (e.g. '1h', '30m', '2 days') or ISO timestamp (e.g. '2026-01-29T09:00:00Z' or '2026-01-29T09:00:00-07:00'). Note that ISO timestamps are converted to UTC.",
  );

const SlugInput = z.string().describe("Task slug (e.g. 'daily-report')");

const NoteInput = z
  .string()
  .describe("Note explaining outcome, reason, or context (e.g. 'Done. Posted to #general')");

async function listTasks(): Promise<Array<{ slug: string; filename: string; task: ParsedTask }>> {
  const tasksDir = await getTasksDir();
  await fs.mkdir(tasksDir, { recursive: true });

  const entries = await fs.readdir(tasksDir, { withFileTypes: true });
  const markdownFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name);

  const results: Array<{ slug: string; filename: string; task: ParsedTask }> = [];
  for (const file of markdownFiles) {
    const content = await fs.readFile(path.join(tasksDir, file), "utf-8");
    const task = parseTaskFile(content, file);
    if (!task) {
      continue;
    }
    results.push({ slug: task.slug, filename: file, task });
  }

  return results;
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

export const tasksRouter = t.router({
  list: t.procedure.meta({ description: "List active tasks" }).query(async () => {
    return listTasks();
  }),

  get: t.procedure
    .meta({ description: "Get a task by slug" })
    .input(z.object({ slug: SlugInput }))
    .query(async ({ input }) => {
      return getTaskBySlug(input.slug);
    }),

  add: t.procedure
    .meta({ description: "Add a new task" })
    .input(
      z.object({
        slug: SlugInput,
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
        // expected when file does not exist
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

  complete: t.procedure
    .meta({ description: "Mark a task as completed and move to archive" })
    .input(z.object({ slug: SlugInput, note: NoteInput }))
    .mutation(async ({ input }) => {
      return completeTask(input.slug, input.note);
    }),

  abandon: t.procedure
    .meta({ description: "Abandon a task and move to archive" })
    .input(z.object({ slug: SlugInput, note: NoteInput }))
    .mutation(async ({ input }) => {
      return abandonTask(input.slug, input.note);
    }),

  reopen: t.procedure
    .meta({ description: "Reopen a task from archive" })
    .input(z.object({ slug: SlugInput, note: NoteInput }))
    .mutation(async ({ input }) => {
      return reopenTask(input.slug, input.note);
    }),

  processPending: t.procedure
    .meta({ description: "Process tasks that are due" })
    .mutation(async () => {
      await processPendingTasks();
      return { success: true };
    }),
});
