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
import { publicProcedure } from "../init.ts";

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

// TODO: oRPC doesn't support .meta() — descriptions from .meta({ description }) are dropped for now
export const tasksRouter = {
  list: publicProcedure.handler(async () => {
    return listTasks();
  }),

  get: publicProcedure.input(z.object({ slug: SlugInput })).handler(async ({ input }) => {
    return getTaskBySlug(input.slug);
  }),

  add: publicProcedure
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
    .handler(async ({ input }) => {
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
    .input(z.object({ slug: SlugInput, note: NoteInput }))
    .handler(async ({ input }) => {
      return completeTask(input.slug, input.note);
    }),

  abandon: publicProcedure
    .input(z.object({ slug: SlugInput, note: NoteInput }))
    .handler(async ({ input }) => {
      return abandonTask(input.slug, input.note);
    }),

  reopen: publicProcedure
    .input(z.object({ slug: SlugInput, note: NoteInput }))
    .handler(async ({ input }) => {
      return reopenTask(input.slug, input.note);
    }),

  processPending: publicProcedure.handler(async () => {
    await processPendingTasks();
    return { success: true };
  }),
};
