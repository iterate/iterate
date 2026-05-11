import { existsSync, readFileSync, statSync } from "node:fs";
import { implement, ORPCError } from "@orpc/server";
import type { Manager } from "../manager.ts";
import {
  api,
  type HealthCheckConfig,
  type RestartingProcessInfo,
  type ProcessLogEntry,
  type ManagerStatus,
  type WaitForRunningResponse,
  type WaitForResponse,
  type WaitCondition,
} from "./contract.ts";

const os = implement(api).$context<{ manager: Manager }>();

const healthCheckConfigs = new Map<string, HealthCheckConfig>();

function syncHealthCheckConfigs(manager: Manager) {
  for (const entry of manager.listManagedProcessEntries()) {
    if (entry.healthCheck) {
      healthCheckConfigs.set(entry.name, entry.healthCheck);
      continue;
    }
    healthCheckConfigs.delete(entry.name);
  }
}

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
  manager: Manager,
  target: string | number,
  options?: { includeEffectiveEnv?: boolean },
): RestartingProcessInfo {
  const entry = manager.getManagedProcessEntry(target);
  if (!entry) {
    throw new ORPCError("NOT_FOUND", { message: `Process not found: ${target}` });
  }
  const proc = manager.getProcessByTarget(entry.name);
  const def = proc?.lazyProcess.definition ?? entry.definition;
  const result: RestartingProcessInfo = {
    name: entry.name,
    tags: proc?.tags ?? entry.tags ?? [],
    state: proc?.state ?? "idle",
    restarts: proc?.restarts ?? 0,
    definition: {
      command: def.command,
      args: def.args,
      cwd: def.cwd,
      env: def.env,
      inheritProcessEnv: def.inheritProcessEnv,
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
  return serializeProcess(context.manager, input.target, {
    includeEffectiveEnv: input.includeEffectiveEnv,
  });
});

const listProcesses = os.processes.list.handler(async ({ context }) => {
  const processes = context.manager.listManagedProcessEntries();
  return processes.map((proc) => serializeProcess(context.manager, proc.name));
});

const updateConfig = os.processes.updateConfig.handler(async ({ input, context }) => {
  syncHealthCheckConfigs(context.manager);
  if (input.healthCheck) {
    healthCheckConfigs.set(input.processSlug, input.healthCheck);
  }
  await context.manager.updateProcessConfig(input);
  syncHealthCheckConfigs(context.manager);
  return serializeProcess(context.manager, input.processSlug);
});

const startProcess = os.processes.start.handler(async ({ input, context }) => {
  const proc = await context.manager.startProcessByTarget(input.target);
  return serializeProcess(context.manager, proc.name);
});

const stopProcess = os.processes.stop.handler(async ({ input, context }) => {
  const proc = await context.manager.stopProcessByTarget(input.target);
  return serializeProcess(context.manager, proc.name);
});

const restartProcess = os.processes.restart.handler(async ({ input, context }) => {
  const proc = await context.manager.restartProcessByTarget(input.target, input.force);
  return serializeProcess(context.manager, proc.name);
});

const deleteProcess = os.processes.delete.handler(async ({ input, context }) => {
  await context.manager.deleteProcessBySlug(input.processSlug);
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

function tailFileLines(filePath: string, lines: number): string[] {
  const tail = tailFile(filePath, lines);
  if (!tail) return [];
  return tail
    .split("\n")
    .filter((line, index, allLines) => !(index === allLines.length - 1 && line.length === 0));
}

async function waitForPoll(signal: AbortSignal, pollIntervalMs: number): Promise<void> {
  if (signal.aborted) return;

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, pollIntervalMs);

    function onAbort() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function* streamProcessLogs(params: {
  filePath: string;
  tailLines: number;
  pollIntervalMs: number;
  signal: AbortSignal;
}): AsyncGenerator<ProcessLogEntry> {
  const { filePath, tailLines, pollIntervalMs, signal } = params;
  let offset = 0;
  let trailingBuffer = "";

  for (const text of tailFileLines(filePath, tailLines)) {
    yield { text };
  }

  if (existsSync(filePath)) {
    offset = statSync(filePath).size;
  }

  while (!signal.aborted) {
    if (!existsSync(filePath)) {
      offset = 0;
      trailingBuffer = "";
      await waitForPoll(signal, pollIntervalMs);
      continue;
    }

    const size = statSync(filePath).size;
    if (size < offset) {
      offset = 0;
      trailingBuffer = "";
    }

    if (size > offset) {
      const buffer = readFileSync(filePath);
      const chunk = buffer.subarray(offset).toString("utf-8");
      offset = buffer.length;

      const combined = trailingBuffer + chunk;
      const parts = combined.split("\n");
      trailingBuffer = parts.pop() ?? "";

      for (const text of parts) {
        yield { text };
      }
    }

    await waitForPoll(signal, pollIntervalMs);
  }

  if (trailingBuffer.length > 0) {
    yield { text: trailingBuffer };
  }
}

async function pollHealthCheck(
  url: string,
  intervalMs: number,
  deadlineMs: number,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/**
 * Wait for a process to reach "running" state, optionally polling an HTTP
 * health check URL configured via `updateConfig({ healthCheck })`.
 */
const waitForRunning = os.processes.waitForRunning.handler(
  async ({ input, context }): Promise<WaitForRunningResponse> => {
    syncHealthCheckConfigs(context.manager);
    const timeoutMs = input.timeoutMs ?? 60_000;
    const pollIntervalMs = input.pollIntervalMs ?? 500;
    const includeLogs = input.includeLogs ?? true;
    const logTailLines = input.logTailLines ?? 100;
    const start = Date.now();
    const processSlug = input.processSlug;

    // Phase 1: Wait for manager to reach "running" state
    while (Date.now() - start < timeoutMs) {
      if (context.manager.state === "running") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    if (context.manager.state !== "running") {
      return {
        name: processSlug,
        state: "idle",
        restarts: 0,
        elapsedMs: Date.now() - start,
        logs: `Manager never reached running state (current: ${context.manager.state})`,
      };
    }

    // Phase 2: Wait for the specific process to reach running state
    while (Date.now() - start < timeoutMs) {
      const proc = context.manager.getProcessByTarget(processSlug);

      if (proc) {
        const state = proc.state;
        const elapsedMs = Date.now() - start;

        if (state === "running") {
          // Phase 3: If healthCheck configured, poll until healthy
          const hc = healthCheckConfigs.get(processSlug);
          if (hc) {
            const remaining = timeoutMs - elapsedMs;
            const hcInterval = hc.intervalMs ?? 2_000;
            const healthy = await pollHealthCheck(hc.url, hcInterval, remaining);
            if (!healthy) {
              const logs = includeLogs
                ? tailFile(context.manager.getProcessLogPath(proc.name), logTailLines)
                : undefined;
              return {
                name: proc.name,
                state,
                restarts: proc.restarts,
                elapsedMs: Date.now() - start,
                logs: logs
                  ? `${logs}\n[pidnap] health check timed out: ${hc.url}`
                  : `[pidnap] health check timed out: ${hc.url}`,
              };
            }
          }

          const logs = includeLogs
            ? tailFile(context.manager.getProcessLogPath(proc.name), logTailLines)
            : undefined;
          return {
            name: proc.name,
            state,
            restarts: proc.restarts,
            elapsedMs: Date.now() - start,
            logs,
          };
        }

        if (state === "stopped" || state === "max-restarts-reached") {
          const logs = includeLogs
            ? tailFile(context.manager.getProcessLogPath(proc.name), logTailLines)
            : undefined;
          return { name: proc.name, state, restarts: proc.restarts, elapsedMs, logs };
        }
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    // Timeout
    const proc = context.manager.getProcessByTarget(processSlug);
    const state = proc?.state ?? "idle";
    const restarts = proc?.restarts ?? 0;
    const logs = includeLogs
      ? tailFile(context.manager.getProcessLogPath(processSlug), logTailLines)
      : undefined;

    return { name: processSlug, state, restarts, elapsedMs: timeoutMs, logs };
  },
);

async function checkHealthy(processSlug: string): Promise<boolean> {
  const hc = healthCheckConfigs.get(processSlug);
  if (!hc) return true;
  try {
    const response = await fetch(hc.url, { signal: AbortSignal.timeout(5_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function conditionMet(
  manager: Manager,
  slug: string,
  condition: WaitCondition,
  healthy: boolean,
): boolean {
  const proc = manager.getProcessByTarget(slug);
  const state = proc?.state ?? "idle";
  if (condition === "healthy") return state === "running" && healthy;
  return state === condition;
}

const waitFor = os.processes.waitFor.handler(
  async ({ input, context }): Promise<WaitForResponse> => {
    syncHealthCheckConfigs(context.manager);
    const timeoutMs = input.timeoutMs ?? 30_000;
    const start = Date.now();
    const slugs = Object.keys(input.processes);
    const POLL_INTERVAL = 500;
    const healthyWithoutHealthCheck = slugs.filter(
      (slug) => input.processes[slug] === "healthy" && !healthCheckConfigs.has(slug),
    );

    if (healthyWithoutHealthCheck.length > 0) {
      throw new ORPCError("BAD_REQUEST", {
        message:
          `waitFor condition "healthy" requires healthCheck config via updateConfig({ healthCheck }) ` +
          `for: ${healthyWithoutHealthCheck.join(", ")}`,
      });
    }

    while (Date.now() - start < timeoutMs) {
      if (context.manager.state === "running") break;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    }

    if (context.manager.state !== "running") {
      const results: WaitForResponse["results"] = {};
      for (const slug of slugs) {
        results[slug] = { state: "idle", healthy: false, elapsedMs: Date.now() - start };
      }
      return { results, allMet: false };
    }

    while (Date.now() - start < timeoutMs) {
      const results: WaitForResponse["results"] = {};
      let allMet = true;

      for (const slug of slugs) {
        const condition = input.processes[slug]!;
        const proc = context.manager.getProcessByTarget(slug);
        const state = proc?.state ?? "idle";
        const isRunning = state === "running";
        const healthy = isRunning ? await checkHealthy(slug) : false;
        const met = conditionMet(context.manager, slug, condition, healthy);
        results[slug] = { state, healthy, elapsedMs: Date.now() - start };
        if (!met) allMet = false;
      }

      if (allMet) return { results, allMet: true };
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    }

    const results: WaitForResponse["results"] = {};
    for (const slug of slugs) {
      const proc = context.manager.getProcessByTarget(slug);
      const state = proc?.state ?? "idle";
      results[slug] = { state, healthy: false, elapsedMs: Date.now() - start };
    }
    return { results, allMet: false };
  },
);

const streamLogs = os.processes.logs.handler(async function* ({ input, context, signal }) {
  await waitForManagerReady(context.manager);

  const proc = context.manager.getProcessByTarget(input.processSlug);
  if (!proc) {
    throw new ORPCError("NOT_FOUND", { message: `Process not found: ${input.processSlug}` });
  }

  const tailLines = Math.max(0, input.tailLines ?? 200);
  const pollIntervalMs = Math.max(100, input.pollIntervalMs ?? 500);
  const filePath = context.manager.getProcessLogPath(proc.name);
  const abortSignal = signal ?? new AbortController().signal;

  yield* streamProcessLogs({
    filePath,
    tailLines,
    pollIntervalMs,
    signal: abortSignal,
  });
});

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
    updateConfig: updateConfig,
    get: getProcess,
    list: listProcesses,
    start: startProcess,
    stop: stopProcess,
    restart: restartProcess,
    delete: deleteProcess,
    waitForRunning: waitForRunning,
    waitFor: waitFor,
    logs: streamLogs,
  },
});
