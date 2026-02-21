/**
 * Cron Task Scheduler
 *
 * Scans pending tasks folder, processes any that are due.
 * Creates a cron agent for each task execution.
 */
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CronTime } from "cron";
import dedent from "dedent";
import { getCustomerRepoPath } from "../trpc/platform.ts";
import { trpcRouter } from "../trpc/router.ts";
import {
  type ParsedTask,
  parseTaskFile,
  serializeTask,
  slugToFilename,
  getPriorityOrder,
} from "./task-parser.ts";

// Re-export types and pure functions for backwards compatibility
export {
  ActiveTaskState,
  ArchivedTaskState,
  TaskState,
  TaskPriority,
  TaskFrontmatter,
  type ParsedTask,
  parseTaskFile,
  serializeTask,
  slugToFilename,
  filenameToSlug,
} from "./task-parser.ts";

/** Default interval for checking for pending tasks */
const DEFAULT_INTERVAL_MS = 1 * 15 * 1000;

/** Default stale threshold for nudging agents to "close the loop" */
const DEFAULT_STALE_THRESHOLD_MS = 1 * 60 * 1000;

// ============================================================================
// Directory Helpers
// ============================================================================

let schedulerRunning = false;

const DAEMON_PORT = process.env.PORT || "3001";
const DAEMON_BASE_URL = `http://localhost:${DAEMON_PORT}`;

function getCronAgentPath(agentPathSegment: string): string {
  return `/cron/${agentPathSegment}`;
}

/** Check whether an active agent exists via tRPC. */
async function agentExists(agentPath: string): Promise<boolean> {
  const agent = await trpcRouter.createCaller({}).getAgent({ path: agentPath });
  return agent !== null;
}

/**
 * Send a prompt to an agent via the agents router.
 * The agents router runs getOrCreateAgent internally, so this
 * creates the agent + session if it doesn't exist yet.
 */
async function sendPromptToAgent(agentPath: string, message: string): Promise<void> {
  const response = await fetch(`${DAEMON_BASE_URL}/api/agents${agentPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "iterate:agent:prompt-added", message }),
  });
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(
      `Agent prompt failed: ${response.status}${errorBody ? ` ${errorBody.slice(0, 500)}` : ""}`,
    );
  }
}

export const getTasksDir = async (): Promise<string> => {
  const customerRepoPath = await getCustomerRepoPath();
  return path.join(customerRepoPath, "iterate/tasks");
};

/** Like getTasksDir but returns null if ITERATE_CUSTOMER_REPO_PATH isn't set yet. */
const tryGetTasksDir = (): string | null => {
  const customerRepoPath = process.env.ITERATE_CUSTOMER_REPO_PATH;
  if (!customerRepoPath) return null;
  return path.join(customerRepoPath, "iterate/tasks");
};

export async function getArchivedDir(): Promise<string> {
  const tasksDir = await getTasksDir();
  return path.join(tasksDir, "archived");
}

/**
 * Initialize and start the cron task scheduler.
 * Note: ITERATE_CUSTOMER_REPO_PATH may not be set on first boot (before the OS pushes .env).
 * The scheduler starts unconditionally and gracefully skips processing until the env var is available.
 */
export async function startCronTaskScheduler() {
  const intervalMs = parseInt(process.env.CRON_TASK_INTERVAL_MS || "", 10) || DEFAULT_INTERVAL_MS;

  if (schedulerRunning) {
    console.log("[cron-tasks] Scheduler already running");
    return;
  }

  schedulerRunning = true;
  console.log(`[cron-tasks] Starting scheduler, interval: ${intervalMs / 1000}s`);

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
 * Check if a task is due (due time has passed).
 */
function isDue(task: ParsedTask): boolean {
  const dueDate = new Date(task.frontmatter.due);
  return dueDate <= new Date();
}

/**
 * Scan tasks folder and process due tasks.
 */
export async function processPendingTasks(): Promise<void> {
  const tasksDir = tryGetTasksDir();
  if (!tasksDir) return; // env not pushed yet, skip silently

  // Ensure directories exist
  await fs.mkdir(tasksDir, { recursive: true });
  await fs.mkdir(path.join(tasksDir, "archived"), { recursive: true });

  const entries = await fs.readdir(tasksDir, { withFileTypes: true });
  const mdFiles = entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name);

  if (mdFiles.length === 0) {
    return;
  }

  console.log(`[cron-tasks] Found ${mdFiles.length} task files`);

  // Parse all tasks
  const tasks: ParsedTask[] = [];
  for (const file of mdFiles) {
    const content = await fs.readFile(path.join(tasksDir, file), "utf-8");
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
    await processTask(task, tasksDir);
  }
}

/**
 * Start the stale task watchdog.
 * Checks for in_progress tasks that have been locked for too long and nudges the agent.
 */
function startStaleTaskWatchdog() {
  const intervalMs = DEFAULT_INTERVAL_MS;
  const thresholdMs = DEFAULT_STALE_THRESHOLD_MS;

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
  const tasksDir = tryGetTasksDir();
  if (!tasksDir) return; // env not pushed yet, skip silently

  if (!existsSync(tasksDir)) return;

  const entries = await fs.readdir(tasksDir, { withFileTypes: true });
  const mdFiles = entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name);
  const now = Date.now();

  for (const file of mdFiles) {
    const content = await fs.readFile(path.join(tasksDir, file), "utf-8");
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
  const agentPath = task.frontmatter.lockedBy;
  if (!agentPath) return;

  if (!(await agentExists(agentPath))) {
    console.warn(`[cron-tasks] Agent ${agentPath} not found for stale task ${task.filename}`);
    return;
  }

  const message = dedent`
    Checking in on task "${task.slug}".

    **If you're done**, mark it complete (include a note about what you did):
    \`\`\`bash
    iterate task complete --slug "${task.slug}" --note "Done. Posted to #general, thread_ts=..."
    \`\`\`

    **If you're still working**, just reply with your status.
    **If you're stuck or want to give up**, abandon the task:
    \`\`\`bash
    iterate task abandon --slug "${task.slug}" --note "Couldn't complete because..."
    \`\`\`
  `;

  await sendPromptToAgent(agentPath, message);

  // Update lockedAt so we don't spam the agent - but only if task still exists
  const tasksDir = await getTasksDir();
  const taskPath = path.join(tasksDir, task.filename);
  if (existsSync(taskPath)) {
    task.frontmatter.lockedAt = new Date().toISOString();
    await fs.writeFile(taskPath, serializeTask(task));
    console.log(`[cron-tasks] Nudged agent ${agentPath} for task ${task.filename}`);
  } else {
    // Task was completed/archived between read and write - that's fine
    console.log(`[cron-tasks] Task ${task.filename} no longer exists, skipping lockedAt update`);
  }
}

/**
 * Process a single task: create agent, mark in_progress, execute.
 */
async function processTask(task: ParsedTask, tasksDir: string): Promise<void> {
  const taskPath = path.join(tasksDir, task.filename);
  const sanitize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  const taskName = sanitize(task.filename.replace(/\.md$/i, ""));
  const timestamp = sanitize(new Date().toISOString());
  const agentPathSegment = `cron-${taskName}-${timestamp}`;
  const agentPath = getCronAgentPath(agentPathSegment);

  console.log(`[cron-tasks] Processing task: ${task.filename} -> agent: ${agentPath}`);

  try {
    // Mark as in_progress with lockedBy and lockedAt
    task.frontmatter.state = "in_progress";
    task.frontmatter.lockedBy = agentPath;
    task.frontmatter.lockedAt = new Date().toISOString();
    await fs.writeFile(taskPath, serializeTask(task));

    // Build prompt from task body
    const prompt = buildPromptFromTask(task, agentPath);

    // Send prompt via agents router (creates agent + session if needed)
    await sendPromptToAgent(agentPath, prompt);
    console.log(`[cron-tasks] Sent prompt to agent ${agentPath} for task ${task.filename}`);

    // Note: The agent now runs asynchronously. We don't wait for completion here.
    // A separate mechanism (agent completion callback or watchdog) will:
    // 1. Handle recurring task recreation
    // 2. Move to completed/ folder
    // 3. Handle failures

    // For now, we leave the task in_progress. The agent's completion
    // should trigger markTaskCompleted() or markTaskFailed().
  } catch (err) {
    console.error(`[cron-tasks] Failed to process task ${task.filename}:`, err);
    await markTaskFailed(task, tasksDir, err);
  }
}

/**
 * Build the agent prompt from task content.
 */
function buildPromptFromTask(task: ParsedTask, agentPath: string): string {
  const lines = [
    `[Agent Path: ${agentPath}]`,
    `[Task: ${task.slug}]`,
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

    When you're done, mark it complete with a note about what you did:
    \`\`\`bash
    iterate task complete --slug "${task.slug}" --note "Done. <summary of what you did, thread_ts, etc>"
    \`\`\`

    For recurring tasks, include any user feedback that should influence the next run.

    **Notes:**
    - If you can't close the loop quickly (e.g., waiting for user response), leave the task in progress. A watchdog will nudge you later for a status update.
    - If you're stuck or want to give up, abandon the task:
      \`\`\`bash
      iterate task abandon --slug "${task.slug}" --note "Couldn't complete because..."
      \`\`\`
  `);

  return lines.join("\n");
}

/**
 * Mark a task as failed: append error note, reset to pending.
 */
async function markTaskFailed(task: ParsedTask, tasksDir: string, error: unknown): Promise<void> {
  const taskPath = path.join(tasksDir, task.filename);
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
 * Mark a task as completed.
 * - Recurring tasks: reset to pending with next due date (stays in tasks/)
 * - One-off tasks: move to archived/
 */
export async function completeTask(
  slug: string,
  note: string,
): Promise<{ success: true; archivedAs?: string; nextDue?: string }> {
  const tasksDir = await getTasksDir();
  const filename = slugToFilename(slug);
  const taskPath = path.join(tasksDir, filename);

  const content = await fs.readFile(taskPath, "utf-8");
  const task = parseTaskFile(content, filename);

  if (!task) {
    throw new Error(`Could not parse task: ${slug}`);
  }

  // Handle recurring tasks - reset to pending with next due date
  if (task.frontmatter.schedule) {
    const cronTime = new CronTime(task.frontmatter.schedule);
    const nextDue = cronTime.sendAt().toJSDate();

    task.frontmatter.state = "pending";
    task.frontmatter.due = nextDue.toISOString();
    task.frontmatter.lockedBy = undefined;
    task.frontmatter.lockedAt = undefined;

    task.body = task.body
      .split("\n")
      .filter((line) => !line.startsWith("**Last completion**"))
      .join("\n");
    task.body += `\n\n**Last completion**: ${new Date().toISOString()} - ${note}`;

    await fs.writeFile(taskPath, serializeTask(task));
    console.log(
      `[cron-tasks] Recurring task ${slug} reset to pending, next due: ${nextDue.toISOString()}`,
    );
    return { success: true, nextDue: nextDue.toISOString() };
  }

  // Append completion note
  task.body += `\n\n---\n**Completed**: ${note}`;

  // One-off task: move to archived
  const archivedDir = path.join(tasksDir, "archived");
  await fs.mkdir(archivedDir, { recursive: true });

  task.frontmatter.state = "completed";
  task.frontmatter.lockedBy = undefined;
  task.frontmatter.lockedAt = undefined;

  const timestamp = new Date().toISOString().split("T")[0];
  const archivedFilename = `${timestamp}-${filename}`;
  const archivedPath = path.join(archivedDir, archivedFilename);

  await fs.writeFile(archivedPath, serializeTask(task));
  await fs.unlink(taskPath);

  console.log(`[cron-tasks] Task ${slug} completed -> ${archivedFilename}`);
  return { success: true, archivedAs: archivedFilename };
}

/**
 * Abandon a task: move to archived/ folder with abandoned state.
 */
export async function abandonTask(
  slug: string,
  note: string,
): Promise<{ success: true; archivedAs: string }> {
  const tasksDir = await getTasksDir();
  const filename = slugToFilename(slug);
  const taskPath = path.join(tasksDir, filename);
  const archivedDir = path.join(tasksDir, "archived");

  await fs.mkdir(archivedDir, { recursive: true });

  const content = await fs.readFile(taskPath, "utf-8");
  const task = parseTaskFile(content, filename);

  if (!task) {
    throw new Error(`Could not parse task: ${slug}`);
  }

  // Move to archived with abandoned state
  task.frontmatter.state = "abandoned";
  task.frontmatter.lockedBy = undefined;
  task.frontmatter.lockedAt = undefined;
  task.body += `\n\n---\n**Abandoned**: ${note}`;

  const timestamp = new Date().toISOString().split("T")[0];
  const archivedFilename = `${timestamp}-${filename}`;
  const archivedPath = path.join(archivedDir, archivedFilename);

  await fs.writeFile(archivedPath, serializeTask(task));
  await fs.unlink(taskPath);

  console.log(`[cron-tasks] Task ${slug} abandoned -> ${archivedFilename}`);
  return { success: true, archivedAs: archivedFilename };
}

/**
 * Reopen a task: reset to pending state.
 * - If task is in_progress in tasks/: reset to pending
 * - If task is in archived/: move back to tasks/
 */
export async function reopenTask(
  slug: string,
  note: string,
): Promise<{ success: true; due: string }> {
  const tasksDir = await getTasksDir();
  const archivedDir = path.join(tasksDir, "archived");
  const targetFilename = slugToFilename(slug);
  const taskPath = path.join(tasksDir, targetFilename);

  // First check if task exists in main folder (e.g., in_progress task)
  let task: ParsedTask | null = null;
  let sourcePath: string | null = null;
  let fromArchive = false;

  if (existsSync(taskPath)) {
    const content = await fs.readFile(taskPath, "utf-8");
    task = parseTaskFile(content, targetFilename);
    sourcePath = taskPath;
  } else {
    for await (const filename of fs.glob(`*-${targetFilename}`, { cwd: archivedDir })) {
      if (filename.replace(/^\d{4}-\d{2}-\d{2}-/, "") === targetFilename) {
        sourcePath = path.join(archivedDir, filename);
        const content = await fs.readFile(sourcePath, "utf-8");
        task = parseTaskFile(content, targetFilename);
        fromArchive = true;
        break;
      }
    }
  }

  if (!task || !sourcePath) {
    throw new Error(`Task not found: ${slug}`);
  }

  // Reset to pending with new due date (1 hour from now)
  const newDue = new Date(Date.now() + 60 * 60 * 1000);
  task.frontmatter.state = "pending";
  task.frontmatter.due = newDue.toISOString();
  task.frontmatter.lockedBy = undefined;
  task.frontmatter.lockedAt = undefined;
  task.body += `\n\n---\n**Reopened**: ${note}`;

  await fs.writeFile(taskPath, serializeTask(task));

  // If from archive, delete the archived copy
  if (fromArchive && sourcePath !== taskPath) {
    await fs.unlink(sourcePath);
  }

  console.log(`[cron-tasks] Task ${slug} reopened${fromArchive ? " from archive" : ""}`);
  return { success: true, due: newDue.toISOString() };
}
