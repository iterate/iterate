import { implement, ORPCError } from "@orpc/server";
import type { Manager } from "../manager.ts";
import type { RestartingProcess } from "../restarting-process.ts";
import { api, type RestartingProcessInfo, type ManagerStatus } from "./contract.ts";

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

// Processes handlers
const getProcess = os.processes.get.handler(async ({ input, context }) => {
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
  },
});
