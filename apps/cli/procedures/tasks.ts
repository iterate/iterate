import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseMs } from "ms";
import { z } from "zod/v4";
import {
  getTasksDir,
  parseTaskFile,
  processPendingTasks,
  serializeTask,
  type ParsedTask,
} from "@iterate-com/daemon/server/cron-tasks/scheduler.ts";
import { t } from "../trpc.ts";

/**
 * Parse a duration string (e.g. "1h", "30m", "2 days") and return an ISO timestamp.
 */
const Due = z.union([
  z
    .string()
    .transform((val, ctx) => {
      if (val.match(/^\d4-/)) {
        // looks like an ISO timestamp
        const date = new Date(val);
        if (!Number.isFinite(date.getTime())) {
          ctx.addIssue({
            code: "custom",
            message: `Invalid ISO timestamp: "${val}"`,
          });
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
      "Either the time until the task runs (e.g. '1h', '30m', '2 days', '1 week') or an ISO timestamp (e.g. '2026-01-29T09:00:00Z' or '2026-01-29T09:00:00-07:00'). Note that you will need to know the user's timezone to use the ISO timestamp.",
    ),
]);

const TASKS_DIR_DESCRIPTION =
  "Tasks are stored as markdown files in the cron-tasks directory. " +
  "Use 'pending' for tasks waiting to run, 'completed' for archived tasks.";

/**
 * Get the folder path for a given state.
 */
async function getStateFolder(state: "pending" | "completed"): Promise<string> {
  return path.join(await getTasksDir(), state);
}

export const tasksRouter = t.router({
  list: t.procedure
    .meta({ description: `List tasks. ${TASKS_DIR_DESCRIPTION}` })
    .input(
      z.object({
        state: z
          .enum(["pending", "completed"])
          .default("pending")
          .describe("Task state folder to list from"),
      }),
    )
    .query(async ({ input }) => {
      const folder = await getStateFolder(input.state);

      try {
        await fs.mkdir(folder, { recursive: true });
      } catch {
        // ignore
      }

      const files = await fs.readdir(folder);
      const mdFiles = files.filter((f) => f.endsWith(".md"));

      const tasks: Array<{
        filename: string;
        state: string;
        due: string;
        schedule?: string;
        priority?: string;
        lockedBy?: string;
      }> = [];

      for (const file of mdFiles) {
        const content = await fs.readFile(path.join(folder, file), "utf-8");
        const task = parseTaskFile(content, file);
        if (task) {
          tasks.push({
            filename: task.filename,
            state: task.frontmatter.state,
            due: task.frontmatter.due,
            schedule: task.frontmatter.schedule,
            priority: task.frontmatter.priority,
            lockedBy: task.frontmatter.lockedBy,
          });
        }
      }

      return { tasks, folder };
    }),

  get: t.procedure
    .meta({ description: `Get a task by filename. ${TASKS_DIR_DESCRIPTION}` })
    .input(
      z.object({
        filename: z.string().describe("Task filename (e.g. daily-report.md)"),
        state: z
          .enum(["pending", "completed"])
          .default("pending")
          .describe("Task state folder to look in"),
      }),
    )
    .query(async ({ input }) => {
      const folder = await getStateFolder(input.state);
      const filepath = path.join(folder, input.filename);

      try {
        const content = await fs.readFile(filepath, "utf-8");
        const task = parseTaskFile(content, input.filename);
        if (!task) {
          return { error: "Failed to parse task file", task: null };
        }
        return { task, filepath };
      } catch {
        return { error: `File not found: ${filepath}`, task: null };
      }
    }),

  add: t.procedure
    .meta({ description: `Add a new pending task. ${TASKS_DIR_DESCRIPTION}` })
    .input(
      z.object({
        filename: z
          .string()
          .describe("Task filename (e.g. daily-report.md). Will be created in pending/"),
        body: z.string().describe("Task body (markdown content after frontmatter)"),
        due: Due,
        schedule: z
          .string()
          .optional()
          .describe("Cron expression for recurring tasks (e.g. '0 9 * * *')"),
        priority: z
          .enum(["low", "normal", "high"])
          .optional()
          .default("normal")
          .describe("Task priority"),
      }),
    )
    .mutation(async ({ input }) => {
      const folder = await getStateFolder("pending");
      await fs.mkdir(folder, { recursive: true });

      const filepath = path.join(folder, input.filename);

      // Check if file already exists
      try {
        await fs.access(filepath);
        return { error: `Task already exists: ${input.filename}`, created: false };
      } catch {
        // File doesn't exist, good to create
      }

      const task: Omit<ParsedTask, "raw"> = {
        filename: input.filename,
        frontmatter: {
          state: "pending",
          due: input.due.toISOString(),
          schedule: input.schedule,
          priority: input.priority,
        },
        body: input.body,
      };

      const content = serializeTask(task);
      await fs.writeFile(filepath, content);

      return { created: true, filepath, task: task.frontmatter };
    }),

  append: t.procedure
    .meta({ description: `Append to a task. ${TASKS_DIR_DESCRIPTION}` })
    .input(
      z.object({
        state: z
          .enum(["pending", "in_progress", "completed"])
          .default("pending")
          .describe("Task state folder to look in"),
        filename: z.string().describe("Task filename (e.g. daily-report.md)"),
        body: z.string().describe("Task body (markdown content after frontmatter)"),
      }),
    )
    .mutation(async ({ input }) => {
      const folder = await getStateFolder("pending");
      const filepath = path.join(folder, input.filename);
      const content = await fs.readFile(filepath, "utf-8");
      const task = parseTaskFile(content, input.filename);
      if (!task) {
        return { error: "Failed to parse task file", task: null };
      }
      task.body = [task.body.trim(), input.body.trim()].join("\n\n");
      const updated = serializeTask(task);
      await fs.writeFile(filepath, updated);
      return { task: task.frontmatter };
    }),

  update: t.procedure
    .meta({ description: `Replace the entire body of a task. ${TASKS_DIR_DESCRIPTION}` })
    .input(
      z.object({
        state: z
          .enum(["pending", "in_progress", "completed"])
          .default("pending")
          .describe("Task state folder to look in"),
        filename: z.string().describe("Task filename (e.g. daily-report.md)"),
        body: z.string().describe("Replacement task body (markdown content after frontmatter)"),
      }),
    )
    .mutation(async ({ input }) => {
      const folder = await getStateFolder("pending");
      const filepath = path.join(folder, input.filename);
      const content = await fs.readFile(filepath, "utf-8");
      const task = parseTaskFile(content, input.filename);
      if (!task) {
        return { error: "Failed to parse task file", task: null };
      }
      task.body = input.body;
      const updated = serializeTask(task);
      await fs.writeFile(filepath, updated);
      return { task: task.frontmatter };
    }),

  processPending: t.procedure
    .meta({ description: `Process pending tasks. ${TASKS_DIR_DESCRIPTION}` })
    .mutation(async () => {
      await processPendingTasks();
    }),
});
