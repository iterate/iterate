import { readFileSync, existsSync } from "node:fs";
import { implement, ORPCError } from "@orpc/server";
import type { Manager } from "../manager.ts";
import type { RestartingProcess } from "../restarting-process.ts";
import {
  api,
  type RestartingProcessInfo,
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

// Manager handlers
const managerStatus = os.manager.status.handler(async ({ context }): Promise<ManagerStatus> => {
  const manager = context.manager;
  return {
    state: manager.state,
    processCount: manager.getRestartingProcesses().size,
  };
});

// Helper to wait for manager to finish initialization
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
 * before checking the process state. This avoids "process not found"
 * errors when called during container startup.
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

    // Phase 1: Wait for manager to reach "running" state
    while (Date.now() - start < timeoutMs) {
      if (context.manager.state === "running") {
        break;
      }
      // Manager still initializing - keep waiting
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

// Simple health check endpoint
const health = os.health.handler(async () => {
  return { status: "ok" as const };
});

export const router = os.router({
  health,
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
});
