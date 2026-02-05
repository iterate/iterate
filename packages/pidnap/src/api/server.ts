import { readFileSync, existsSync } from "node:fs";
import { implement, ORPCError } from "@orpc/server";
import type { Manager } from "../manager.ts";
import type { RestartingProcess } from "../restarting-process.ts";
import type { CronProcess } from "../cron-process.ts";
import {
  api,
  type RestartingProcessInfo,
  type CronProcessInfo,
  type TaskEntryInfo,
  type ManagerStatus,
  type WaitForRunningResponse,
} from "./contract.ts";

const os = implement(api).$context<{ manager: Manager }>();

// Helper to compute effective env (process.env merged with definition.env)
function computeEffectiveEnv(definitionEnv?: Record<string, string>): Record<string, string> {
  const effectiveEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      effectiveEnv[key] = value;
    }
  }
  if (definitionEnv) {
    Object.assign(effectiveEnv, definitionEnv);
  }
  return effectiveEnv;
}

// Helper to serialize a RestartingProcess to API response
function serializeProcess(
  proc: RestartingProcess,
  options?: { includeEffectiveEnv?: boolean },
): RestartingProcessInfo {
  const def = proc.lazyProcess.definition;
  const result: RestartingProcessInfo = {
    name: proc.name,
    state: proc.state,
    restarts: proc.restarts,
    definition: {
      command: def.command,
      args: def.args,
      cwd: def.cwd,
      env: def.env,
    },
  };

  if (options?.includeEffectiveEnv) {
    result.effectiveEnv = computeEffectiveEnv(def.env);
  }

  return result;
}

// Helper to serialize a CronProcess to API response
function serializeCron(
  cron: CronProcess,
  options?: { includeEffectiveEnv?: boolean },
): CronProcessInfo {
  const def = cron.lazyProcess.definition;
  const result: CronProcessInfo = {
    name: cron.name,
    state: cron.state,
    runCount: cron.runCount,
    failCount: cron.failCount,
    nextRun: cron.nextRun?.toISOString() ?? null,
    definition: {
      command: def.command,
      args: def.args,
      cwd: def.cwd,
      env: def.env,
    },
  };

  if (options?.includeEffectiveEnv) {
    result.effectiveEnv = computeEffectiveEnv(def.env);
  }

  return result;
}

// Manager handlers
const managerStatus = os.manager.status.handler(async ({ context }): Promise<ManagerStatus> => {
  const manager = context.manager;
  const taskList = manager.getTaskList();
  return {
    state: manager.state,
    processCount: manager.getRestartingProcesses().size,
    cronCount: manager.getCronProcesses().size,
    taskCount: taskList?.tasks.length ?? 0,
  };
});

// Helper to wait for manager to finish initialization (tasks completed)
async function waitForManagerReady(
  manager: Manager,
  timeoutMs = 60_000,
  pollIntervalMs = 500,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (manager.state === "running" || manager.state === "stopped") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

// Processes handlers
const getProcess = os.processes.get.handler(async ({ input, context }) => {
  // Wait for manager to finish initialization before checking process existence
  await waitForManagerReady(context.manager);

  const proc = context.manager.getProcessByTarget(input.target);
  if (!proc) {
    throw new ORPCError("NOT_FOUND", { message: `Process not found: ${input.target}` });
  }
  return serializeProcess(proc, { includeEffectiveEnv: input.includeEffectiveEnv });
});

const listProcesses = os.processes.list.handler(async ({ context }) => {
  const processes = Array.from(context.manager.getRestartingProcesses().values());
  return processes.map((proc) => serializeProcess(proc));
});

const addProcess = os.processes.add.handler(async ({ input, context }) => {
  const proc = await context.manager.addProcess(input.name, input.definition);
  return serializeProcess(proc);
});

const startProcess = os.processes.start.handler(async ({ input, context }) => {
  const proc = await context.manager.startProcessByTarget(input.target);
  return serializeProcess(proc);
});

const stopProcess = os.processes.stop.handler(async ({ input, context }) => {
  const proc = await context.manager.stopProcessByTarget(input.target);
  return serializeProcess(proc);
});

const restartProcess = os.processes.restart.handler(async ({ input, context }) => {
  const proc = await context.manager.restartProcessByTarget(input.target, input.force);
  return serializeProcess(proc);
});

const reloadProcess = os.processes.reload.handler(async ({ input, context }) => {
  const proc = await context.manager.reloadProcessByTarget(input.target, input.definition, {
    restartImmediately: input.restartImmediately,
  });
  return serializeProcess(proc);
});

const removeProcess = os.processes.remove.handler(async ({ input, context }) => {
  await context.manager.removeProcessByTarget(input.target);
  return { success: true };
});

/** Read last N lines from a file */
function tailFile(filePath: string, lines: number): string | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const content = readFileSync(filePath, "utf-8");
    const allLines = content.split("\n");
    const tailLines = allLines.slice(-lines);
    return tailLines.join("\n");
  } catch {
    return undefined;
  }
}

/**
 * Wait for a process to reach "running" state.
 *
 * This handler automatically waits for the manager to finish initialization
 * (tasks completed) before checking the process state. This avoids "process not found"
 * errors when called during container startup while tasks are still running.
 *
 * NOTE: Ideally pidnap would treat tasks as processes with restartPolicy: "never"
 * and register all processes at startup in a "pending" state. Until then, this
 * handler works around the limitation by waiting for manager state === "running".
 */
const waitForRunning = os.processes.waitForRunning.handler(
  async ({ input, context }): Promise<WaitForRunningResponse> => {
    const timeoutMs = input.timeoutMs ?? 60_000;
    const pollIntervalMs = input.pollIntervalMs ?? 500;
    const includeLogs = input.includeLogs ?? true;
    const logTailLines = input.logTailLines ?? 100;
    const start = Date.now();

    // Resolve target to name for log file lookup
    const resolveTargetName = (): string | undefined => {
      if (typeof input.target === "string") return input.target;
      const proc = context.manager.getProcessByTarget(input.target);
      return proc?.name;
    };

    // Phase 1: Wait for manager to reach "running" state (tasks completed)
    // Processes aren't registered until tasks finish, so we must wait for this first
    while (Date.now() - start < timeoutMs) {
      if (context.manager.state === "running") {
        break;
      }
      // Manager still initializing (running tasks) - keep waiting
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    // Check if we timed out waiting for manager
    if (context.manager.state !== "running") {
      const name = resolveTargetName() ?? String(input.target);
      return {
        name,
        state: "idle",
        restarts: 0,
        elapsedMs: Date.now() - start,
        logs: `Manager never reached running state (current: ${context.manager.state})`,
      };
    }

    // Phase 2: Wait for the specific process to reach target state
    while (Date.now() - start < timeoutMs) {
      const proc = context.manager.getProcessByTarget(input.target);

      if (proc) {
        const state = proc.state;
        const elapsedMs = Date.now() - start;

        // Terminal success states
        if (state === "running") {
          const logs = includeLogs
            ? tailFile(context.manager.getProcessLogPath(proc.name), logTailLines)
            : undefined;
          return { name: proc.name, state, restarts: proc.restarts, elapsedMs, logs };
        }

        // Terminal failure states - return immediately with logs
        if (state === "stopped" || state === "max-restarts-reached") {
          const logs = includeLogs
            ? tailFile(context.manager.getProcessLogPath(proc.name), logTailLines)
            : undefined;
          return { name: proc.name, state, restarts: proc.restarts, elapsedMs, logs };
        }
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    // Timeout - return current state with logs
    const proc = context.manager.getProcessByTarget(input.target);
    const name = proc?.name ?? resolveTargetName() ?? String(input.target);
    const state = proc?.state ?? "idle";
    const restarts = proc?.restarts ?? 0;
    const logs = includeLogs
      ? tailFile(context.manager.getProcessLogPath(name), logTailLines)
      : undefined;

    return { name, state, restarts, elapsedMs: timeoutMs, logs };
  },
);

// Crons handlers
const getCron = os.crons.get.handler(async ({ input, context }) => {
  const cron = context.manager.getCronByTarget(input.target);
  if (!cron) {
    throw new ORPCError("NOT_FOUND", { message: `Cron not found: ${input.target}` });
  }
  return serializeCron(cron, { includeEffectiveEnv: input.includeEffectiveEnv });
});

const listCrons = os.crons.list.handler(async ({ context }) => {
  const crons = Array.from(context.manager.getCronProcesses().values());
  return crons.map((cron) => serializeCron(cron));
});

const triggerCron = os.crons.trigger.handler(async ({ input, context }) => {
  const cron = await context.manager.triggerCronByTarget(input.target);
  return serializeCron(cron);
});

const startCron = os.crons.start.handler(async ({ input, context }) => {
  const cron = context.manager.startCronByTarget(input.target);
  return serializeCron(cron);
});

const stopCron = os.crons.stop.handler(async ({ input, context }) => {
  const cron = await context.manager.stopCronByTarget(input.target);
  return serializeCron(cron);
});

// Helper to serialize task processes
function serializeTaskProcesses(
  processes: {
    name: string;
    process: { command: string; args?: string[]; cwd?: string; env?: Record<string, string> };
  }[],
  options?: { includeEffectiveEnv?: boolean },
) {
  return processes.map((p) => ({
    name: p.name,
    definition: {
      command: p.process.command,
      args: p.process.args,
      cwd: p.process.cwd,
      env: p.process.env,
    },
    ...(options?.includeEffectiveEnv && {
      effectiveEnv: computeEffectiveEnv(p.process.env),
    }),
  }));
}

// Tasks handlers
const getTask = os.tasks.get.handler(async ({ input, context }): Promise<TaskEntryInfo> => {
  const taskList = context.manager.getTaskList();
  if (!taskList) {
    throw new ORPCError("NOT_FOUND", { message: `Task not found: ${input.target}` });
  }

  const tasks = taskList.tasks;
  const task =
    typeof input.target === "string"
      ? tasks.find((t) => t.id === input.target)
      : tasks[input.target];

  if (!task) {
    throw new ORPCError("NOT_FOUND", { message: `Task not found: ${input.target}` });
  }

  return {
    id: task.id,
    state: task.state,
    processNames: task.processes.map((p) => p.name),
    processes: serializeTaskProcesses(task.processes, {
      includeEffectiveEnv: input.includeEffectiveEnv,
    }),
  };
});

const listTasks = os.tasks.list.handler(async ({ context }): Promise<TaskEntryInfo[]> => {
  const taskList = context.manager.getTaskList();
  if (!taskList) {
    return [];
  }
  return taskList.tasks.map((t) => ({
    id: t.id,
    state: t.state,
    processNames: t.processes.map((p) => p.name),
    processes: serializeTaskProcesses(t.processes),
  }));
});

const addTask = os.tasks.add.handler(async ({ input, context }): Promise<TaskEntryInfo> => {
  const result = context.manager.addTask(input.name, input.definition);
  // Re-fetch to get the full task with process definitions
  const taskList = context.manager.getTaskList();
  const task = taskList?.tasks.find((t) => t.id === result.id);
  if (!task) {
    // Fallback if task not found (shouldn't happen)
    return {
      id: result.id,
      state: "pending" as const,
      processNames: result.processNames,
      processes: [{ name: input.name, definition: input.definition }],
    };
  }
  return {
    id: task.id,
    state: task.state,
    processNames: task.processes.map((p) => p.name),
    processes: serializeTaskProcesses(task.processes),
  };
});

const removeTask = os.tasks.remove.handler(async ({ input, context }): Promise<TaskEntryInfo> => {
  const taskList = context.manager.getTaskList();
  if (!taskList) {
    throw new ORPCError("NOT_FOUND", { message: `Task not found: ${input.target}` });
  }

  // Get task before removing to capture its details
  const tasks = taskList.tasks;
  const task =
    typeof input.target === "string"
      ? tasks.find((t) => t.id === input.target)
      : tasks[input.target];

  if (!task) {
    throw new ORPCError("NOT_FOUND", { message: `Task not found: ${input.target}` });
  }

  const result = {
    id: task.id,
    state: task.state,
    processNames: task.processes.map((p) => p.name),
    processes: serializeTaskProcesses(task.processes),
  };

  context.manager.removeTaskByTarget(input.target);
  return result;
});

export const router = os.router({
  manager: {
    status: managerStatus,
  },
  processes: {
    add: addProcess,
    get: getProcess,
    list: listProcesses,
    start: startProcess,
    stop: stopProcess,
    restart: restartProcess,
    reload: reloadProcess,
    remove: removeProcess,
    waitForRunning: waitForRunning,
  },
  crons: {
    get: getCron,
    list: listCrons,
    trigger: triggerCron,
    start: startCron,
    stop: stopCron,
  },
  tasks: {
    get: getTask,
    list: listTasks,
    add: addTask,
    remove: removeTask,
  },
});
