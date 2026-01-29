/**
 * Cron Task Scheduler
 *
 * Scans pending tasks folder, processes any that are due.
 * Creates a cron agent for each task execution.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import dedent from "dedent";
import { getCustomerRepoPath } from "../trpc/platform.ts";
import { createAgent, appendToAgent, getAgent } from "../services/agent-manager.ts";
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

export const getTasksDir = async () => {
  const customerRepoPath = await getCustomerRepoPath();
  return path.join(customerRepoPath, "iterate/tasks");
};

export async function getArchivedDir(): Promise<string> {
  const tasksDir = await getTasksDir();
  return path.join(tasksDir, "archived");
}

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
  const tasksDir = await getTasksDir();

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
  const tasksDir = await getTasksDir();

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(tasksDir, { withFileTypes: true });
  } catch {
    return; // No tasks dir yet
  }

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
  const agentSlug = task.frontmatter.lockedBy;
  if (!agentSlug) return;

  const agent = await getAgent(agentSlug);
  if (!agent) {
    console.warn(`[cron-tasks] Agent ${agentSlug} not found for stale task ${task.filename}`);
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

  const workingDirectory = await getCustomerRepoPath();
  await appendToAgent(agent, message, { workingDirectory });

  // Update lockedAt so we don't spam the agent - but only if task still exists
  const tasksDir = await getTasksDir();
  const taskPath = path.join(tasksDir, task.filename);
  try {
    await fs.access(taskPath);
    task.frontmatter.lockedAt = new Date().toISOString();
    await fs.writeFile(taskPath, serializeTask(task));
    console.log(`[cron-tasks] Nudged agent ${agentSlug} for task ${task.filename}`);
  } catch {
    // Task was completed/archived between read and write - that's fine
    console.log(`[cron-tasks] Task ${task.filename} no longer exists, skipping lockedAt update`);
  }
}

/**
 * Process a single task: create agent, mark in_progress, execute.
 */
async function processTask(task: ParsedTask, tasksDir: string): Promise<void> {
  const taskPath = path.join(tasksDir, task.filename);
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
    await markTaskFailed(task, tasksDir, err);
  }
}

/**
 * Build the agent prompt from task content.
 */
function buildPromptFromTask(task: ParsedTask, agentSlug: string): string {
  const lines = [
    `[Agent: ${agentSlug}]`,
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
 * Mark a task as completed: move to archived/ folder.
 * If recurring, create new task first.
 */
export async function completeTask(
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

  // Handle recurring tasks - create next occurrence before archiving
  if (task.frontmatter.schedule) {
    await createNextRecurrence(task);
  }

  // Append completion note
  if (note) {
    task.body += `\n\n---\n**Completed**: ${note}`;
  }

  // Move to archived with completed state
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
 * Reopen a task from archived/ back to tasks/.
 */
export async function reopenTask(
  slug: string,
  note: string,
): Promise<{ success: true; due: string }> {
  const tasksDir = await getTasksDir();
  const archivedDir = path.join(tasksDir, "archived");

  await fs.mkdir(tasksDir, { recursive: true });

  // Find the archived task (may have date prefix)
  const files = await fs.readdir(archivedDir);
  const targetFilename = slugToFilename(slug);
  const archivedFile = files.find((f) => f === targetFilename || f.endsWith(`-${targetFilename}`));

  if (!archivedFile) {
    throw new Error(`Task not found in archive: ${slug}`);
  }

  const archivedPath = path.join(archivedDir, archivedFile);
  const content = await fs.readFile(archivedPath, "utf-8");
  const task = parseTaskFile(content, targetFilename);

  if (!task) {
    throw new Error(`Could not parse archived task: ${slug}`);
  }

  // Reset to pending with new due date (1 hour from now)
  const newDue = new Date(Date.now() + 60 * 60 * 1000);
  task.frontmatter.state = "pending";
  task.frontmatter.due = newDue.toISOString();
  task.frontmatter.lockedBy = undefined;
  task.frontmatter.lockedAt = undefined;
  task.body += `\n\n---\n**Reopened**: ${note}`;

  const taskPath = path.join(tasksDir, targetFilename);
  await fs.writeFile(taskPath, serializeTask(task));
  await fs.unlink(archivedPath);

  console.log(`[cron-tasks] Task ${slug} reopened from archive`);
  return { success: true, due: newDue.toISOString() };
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
    slug: task.slug,
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
  const taskPath = path.join(tasksDir, task.filename);
  await fs.writeFile(taskPath, serializeTask(newTask));

  console.log(
    `[cron-tasks] Created next recurrence for ${task.filename}, due: ${nextDue.toISOString()}`,
  );
}
