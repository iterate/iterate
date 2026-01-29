/**
 * Cron Task Scheduler
 *
 * Scans pending tasks folder, processes any that are due.
 * Creates a cron agent for each task execution.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import dedent from "dedent";
import { parseDocument } from "yaml";
import { z } from "zod/v4";
import { getCustomerRepoPath } from "../trpc/platform.ts";
import { createAgent, appendToAgent, getAgent } from "../services/agent-manager.ts";

// Default interval: 1 minute
const DEFAULT_INTERVAL_MS = 1 * 60 * 1000;

export const TaskState = z.enum(["pending", "in_progress", "completed"]);
export type TaskState = z.infer<typeof TaskState>;

export const TaskFrontmatter = z.object({
  state: TaskState,
  due: z.string(), // ISO timestamp
  schedule: z.string().optional(), // cron expression for recurring
  lockedBy: z.string().optional(), // agent slug when in_progress
  lockedAt: z.string().optional(), // ISO timestamp when locked
  priority: z.enum(["low", "normal", "high"]).optional(),
});

export type TaskFrontmatter = z.infer<typeof TaskFrontmatter>;

export interface ParsedTask {
  filename: string;
  frontmatter: TaskFrontmatter;
  body: string;
  raw: string;
}

let schedulerRunning = false;

export const getTasksDir = async () => {
  const customerRepoPath = await getCustomerRepoPath();
  return path.join(customerRepoPath, "iterate/tasks");
};

/**
 * Initialize and start the cron task scheduler.
 */
export async function startCronTaskScheduler() {
  const intervalMs = parseInt(process.env.CRON_TASK_INTERVAL_MS || "", 10) || DEFAULT_INTERVAL_MS;
  const tasksDir = await getTasksDir();

  if (schedulerRunning) {
    console.log("[cron-tasks] Scheduler already running");
    return;
  }

  schedulerRunning = true;
  console.log(`[cron-tasks] Starting scheduler, interval: ${intervalMs / 1000}s`);
  console.log(`[cron-tasks] Tasks directory: ${tasksDir}`);

  const scheduleNext = () => {
    setTimeout(async () => {
      try {
        await processPendingTasks();
      } catch (err) {
        console.error("[cron-tasks] Error processing tasks:", err);
      }
      scheduleNext();
    }, intervalMs);
  };

  // Run immediately on start, then schedule
  processPendingTasks().catch((err) => {
    console.error("[cron-tasks] Error on initial task processing:", err);
  });
  scheduleNext();

  // Start watchdog for stale tasks
  startStaleTaskWatchdog();
}

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
 * Check if a task is due (due time has passed).
 */
function isDue(task: ParsedTask): boolean {
  const dueDate = new Date(task.frontmatter.due);
  return dueDate <= new Date();
}

/**
 * Get priority order for sorting (high = 0, normal = 1, low = 2).
 */
function getPriorityOrder(priority?: TaskFrontmatter["priority"]): number {
  switch (priority) {
    case "high":
      return 0;
    case "low":
      return 2;
    default:
      return 1;
  }
}

/**
 * Scan pending folder and process due tasks.
 */
export async function processPendingTasks(): Promise<void> {
  const tasksDir = await getTasksDir();
  const pendingDir = path.join(tasksDir, "pending");

  // Ensure directories exist
  await fs.mkdir(pendingDir, { recursive: true });
  await fs.mkdir(path.join(tasksDir, "completed"), { recursive: true });

  const files = await fs.readdir(pendingDir);
  const mdFiles = files.filter((f) => f.endsWith(".md"));

  if (mdFiles.length === 0) {
    return;
  }

  console.log(`[cron-tasks] Found ${mdFiles.length} pending tasks`);

  // Parse all tasks
  const tasks: ParsedTask[] = [];
  for (const file of mdFiles) {
    const content = await fs.readFile(path.join(pendingDir, file), "utf-8");
    const task = parseTaskFile(content, file);
    if (task && task.frontmatter.state === "pending" && isDue(task)) {
      tasks.push(task);
    }
  }

  if (tasks.length === 0) {
    return;
  }

  // Sort by priority (high first), then by due date (oldest first)
  tasks.sort((a, b) => {
    const priorityDiff =
      getPriorityOrder(a.frontmatter.priority) - getPriorityOrder(b.frontmatter.priority);
    if (priorityDiff !== 0) return priorityDiff;
    return new Date(a.frontmatter.due).getTime() - new Date(b.frontmatter.due).getTime();
  });

  console.log(`[cron-tasks] ${tasks.length} tasks are due, processing...`);

  // Process each due task
  for (const task of tasks) {
    await processTask(task, pendingDir);
  }
}

// Default stale threshold: 1 minute
const DEFAULT_STALE_THRESHOLD_MS = 1 * 60 * 1000;

/**
 * Start the stale task watchdog.
 * Checks for in_progress tasks that have been locked for too long and nudges the agent.
 */
function startStaleTaskWatchdog() {
  const intervalMs = parseInt(process.env.STALE_TASK_INTERVAL_MS || "", 10) || DEFAULT_INTERVAL_MS;
  const thresholdMs =
    parseInt(process.env.STALE_TASK_THRESHOLD_MS || "", 10) || DEFAULT_STALE_THRESHOLD_MS;

  console.log(
    `[cron-tasks] Starting stale task watchdog, interval: ${intervalMs / 1000}s, threshold: ${thresholdMs / 1000}s`,
  );

  const checkStale = async () => {
    try {
      await nudgeStaleTasks(thresholdMs);
    } catch (err) {
      console.error("[cron-tasks] Error in stale task watchdog:", err);
    }
  };

  // Check periodically
  setInterval(checkStale, intervalMs);
}

/**
 * Find in_progress tasks that have been locked longer than threshold and nudge their agents.
 */
async function nudgeStaleTasks(thresholdMs: number): Promise<void> {
  const tasksDir = await getTasksDir();
  const pendingDir = path.join(tasksDir, "pending");

  let files: string[];
  try {
    files = await fs.readdir(pendingDir);
  } catch {
    return; // No pending dir yet
  }

  const mdFiles = files.filter((f) => f.endsWith(".md"));
  const now = Date.now();

  for (const file of mdFiles) {
    const content = await fs.readFile(path.join(pendingDir, file), "utf-8");
    const task = parseTaskFile(content, file);

    if (!task) continue;
    if (task.frontmatter.state !== "in_progress") continue;
    if (!task.frontmatter.lockedBy || !task.frontmatter.lockedAt) continue;

    const lockedAt = new Date(task.frontmatter.lockedAt).getTime();
    const staleDuration = now - lockedAt;

    if (staleDuration > thresholdMs) {
      console.log(
        `[cron-tasks] Task ${file} is stale (locked ${Math.round(staleDuration / 1000)}s ago), nudging agent`,
      );
      await nudgeAgent(task);
    }
  }
}

/**
 * Send a "u ok?" message to the agent working on a stale task.
 */
async function nudgeAgent(task: ParsedTask): Promise<void> {
  const agentSlug = task.frontmatter.lockedBy;
  if (!agentSlug) return;

  const agent = await getAgent(agentSlug);
  if (!agent) {
    console.warn(`[cron-tasks] Agent ${agentSlug} not found for stale task ${task.filename}`);
    return;
  }

  const message = dedent`
    Hey, checking in on task "${task.filename}".

    If you're done, please append your outcome to the task:
    \`\`\`bash
    iterate task append --filename "${task.filename}" --body "## Outcome

    <what you did, any message IDs for follow-up>"
    \`\`\`

    If the task is complete, mark it as completed.
    If you're still working, that's fine - just let me know your status.
    If you got stuck, describe the issue and I can help.
  `;

  const workingDirectory = await getCustomerRepoPath();
  await appendToAgent(agent, message, { workingDirectory });

  // Update lockedAt so we don't spam the agent
  task.frontmatter.lockedAt = new Date().toISOString();
  const tasksDir = await getTasksDir();
  const taskPath = path.join(tasksDir, "pending", task.filename);
  await fs.writeFile(taskPath, serializeTask(task));

  console.log(`[cron-tasks] Nudged agent ${agentSlug} for task ${task.filename}`);
}

/**
 * Process a single task: create agent, mark in_progress, execute.
 */
async function processTask(task: ParsedTask, pendingDir: string): Promise<void> {
  const taskPath = path.join(pendingDir, task.filename);
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const slug = `cron-${task.filename.replace(".md", "")}-${timestamp}`;

  console.log(`[cron-tasks] Processing task: ${task.filename} -> agent: ${slug}`);

  try {
    // Mark as in_progress with lockedBy and lockedAt
    task.frontmatter.state = "in_progress";
    task.frontmatter.lockedBy = slug;
    task.frontmatter.lockedAt = new Date().toISOString();
    await fs.writeFile(taskPath, serializeTask(task));

    // Build prompt from task body
    const prompt = buildPromptFromTask(task, slug);

    // Create cron agent
    const workingDirectory = await getCustomerRepoPath();
    const agent = await createAgent({
      slug,
      harnessType: "opencode",
      workingDirectory,
      initialPrompt: `[Agent slug: ${slug}]\n[Source: cron]\n[Task: ${task.filename}]`,
    });

    console.log(`[cron-tasks] Created agent ${agent.slug} for task ${task.filename}`);

    // Send the initial prompt to start the agent working
    await appendToAgent(agent, prompt, { workingDirectory });
    console.log(`[cron-tasks] Sent prompt to agent ${agent.slug}`);

    // Note: The agent now runs asynchronously. We don't wait for completion here.
    // A separate mechanism (agent completion callback or watchdog) will:
    // 1. Handle recurring task recreation
    // 2. Move to completed/ folder
    // 3. Handle failures

    // For now, we leave the task in_progress. The agent's completion
    // should trigger markTaskCompleted() or markTaskFailed().
  } catch (err) {
    console.error(`[cron-tasks] Failed to process task ${task.filename}:`, err);
    await markTaskFailed(task, pendingDir, err);
  }
}

/**
 * Build the agent prompt from task content.
 */
function buildPromptFromTask(task: ParsedTask, agentSlug: string): string {
  const lines = [
    `[Agent: ${agentSlug}]`,
    `[Task file: ${task.filename}]`,
    "",
    "You are executing a scheduled cron task. Here are your instructions:",
    "",
    "---",
    task.body,
    "---",
    "",
    "Complete the task as described above.",
  ];

  if (task.frontmatter.schedule) {
    lines.push("");
    lines.push(`This is a recurring task with schedule: ${task.frontmatter.schedule}`);
    lines.push("If this task should no longer recur, mention that the schedule should be removed.");
  }

  lines.push(dedent`

    ## Completing This Task

    When you're done, append your outcome to the task file:

    \`\`\`bash
    iterate task append --filename "${task.filename}" --body "## Outcome

    <summary of what you did, any thread_ts or message IDs for follow-up>"
    \`\`\`

    If you sent a Slack message or email, include the thread_ts/channel or message ID so future
    runs can check for responses. For recurring tasks, also note any user feedback that should
    influence how you approach the next run.
  `);

  return lines.join("\n");
}

/**
 * Mark a task as failed: append error note, reset to pending.
 */
async function markTaskFailed(task: ParsedTask, pendingDir: string, error: unknown): Promise<void> {
  const taskPath = path.join(pendingDir, task.filename);
  const errorMsg = error instanceof Error ? error.message : String(error);
  const timestamp = new Date().toISOString();

  // Append failure note to body
  task.body += `\n\n---\n**Failure at ${timestamp}**: ${errorMsg}`;
  task.frontmatter.state = "pending";
  task.frontmatter.lockedBy = undefined;

  await fs.writeFile(taskPath, serializeTask(task));
  console.log(`[cron-tasks] Task ${task.filename} marked as failed, will retry`);
}

/**
 * Mark a task as completed: move to completed/ folder.
 * If recurring, create new pending task first.
 *
 * This should be called by the agent completion handler.
 */
export async function markTaskCompleted(taskFilename: string): Promise<void> {
  const tasksDir = await getTasksDir();
  const pendingPath = path.join(tasksDir, "pending", taskFilename);
  const completedDir = path.join(tasksDir, "completed");

  const content = await fs.readFile(pendingPath, "utf-8");
  const task = parseTaskFile(content, taskFilename);

  if (!task) {
    console.error(`[cron-tasks] Could not parse completed task: ${taskFilename}`);
    return;
  }

  // Handle recurring tasks
  if (task.frontmatter.schedule) {
    await createNextRecurrence(task);
  }

  // Move to completed
  task.frontmatter.state = "completed";
  task.frontmatter.lockedBy = undefined;

  const timestamp = new Date().toISOString().split("T")[0];
  const completedFilename = `${timestamp}-${taskFilename}`;
  const completedPath = path.join(completedDir, completedFilename);

  await fs.writeFile(completedPath, serializeTask(task));
  await fs.unlink(pendingPath);

  console.log(`[cron-tasks] Task ${taskFilename} completed -> ${completedFilename}`);
}

/**
 * Create the next occurrence of a recurring task.
 */
async function createNextRecurrence(task: ParsedTask): Promise<void> {
  // TODO: Parse cron expression and calculate next due date
  // For now, just add 24 hours as a simple implementation
  const currentDue = new Date(task.frontmatter.due);
  const nextDue = new Date(currentDue.getTime() + 24 * 60 * 60 * 1000);

  const newTask: ParsedTask = {
    filename: task.filename,
    frontmatter: {
      ...task.frontmatter,
      state: "pending",
      due: nextDue.toISOString(),
      lockedBy: undefined,
    },
    body: task.body.split("\n---\n**Failure")[0], // Remove any failure notes
    raw: "",
  };

  const tasksDir = await getTasksDir();
  const pendingPath = path.join(tasksDir, "pending", task.filename);
  await fs.writeFile(pendingPath, serializeTask(newTask));

  console.log(
    `[cron-tasks] Created next recurrence for ${task.filename}, due: ${nextDue.toISOString()}`,
  );
}
