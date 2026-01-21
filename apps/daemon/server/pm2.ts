/**
 * PM2 process management utilities.
 * Provides functions to list, restart, and get logs for PM2-managed processes.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { x } from "tinyexec";

const PM2_HOME = process.env.PM2_HOME || join(homedir(), ".pm2");
const PM2_LOGS_DIR = join(PM2_HOME, "logs");

/** PM2 process status */
export type Pm2Status =
  | "online"
  | "stopping"
  | "stopped"
  | "launching"
  | "errored"
  | "one-launch-status";

/** PM2 process info (subset of what pm2 jlist returns) */
export interface Pm2Process {
  name: string;
  pm_id: number;
  status: Pm2Status;
  pid: number | null;
  cpu: number;
  memory: number;
  uptime: number | null;
  restarts: number;
  createdAt: number | null;
  meta?: {
    displayName?: string;
    description?: string;
    ports?: Array<{
      name: string;
      port: number;
      protocol: string;
      healthEndpoint?: string;
      hasWebUI?: boolean;
    }>;
  };
}

/** Raw PM2 jlist process structure */
interface Pm2JlistProcess {
  name: string;
  pm_id: number;
  pm2_env: {
    status: Pm2Status;
    pm_uptime?: number;
    restart_time?: number;
    created_at?: number;

    meta?: Record<string, any>;
  };
  pid: number;
  monit: {
    cpu: number;
    memory: number;
  };
}

/**
 * List all PM2 processes with their status.
 */
export async function listPm2Processes(): Promise<Pm2Process[]> {
  try {
    const result = await x("pm2", ["jlist"], { throwOnError: true });
    const processes: Pm2JlistProcess[] = JSON.parse(result.stdout || "[]");

    return processes.map((proc) => ({
      name: proc.name,
      pm_id: proc.pm_id,
      status: proc.pm2_env.status,
      pid: proc.pid || null,
      cpu: proc.monit?.cpu ?? 0,
      memory: proc.monit?.memory ?? 0,
      uptime: proc.pm2_env.pm_uptime ? Date.now() - proc.pm2_env.pm_uptime : null,
      restarts: proc.pm2_env.restart_time ?? 0,
      createdAt: proc.pm2_env.created_at ?? null,
      meta: proc.pm2_env.meta,
    }));
  } catch (err) {
    console.error("[pm2] Failed to list processes:", err);
    return [];
  }
}

/**
 * Restart a specific PM2 process by name.
 */
export async function restartPm2Process(
  name: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    await x("pm2", ["restart", name], { throwOnError: true });
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pm2] Failed to restart ${name}:`, err);
    return { success: false, error: message };
  }
}

/**
 * Stop a specific PM2 process by name.
 */
export async function stopPm2Process(name: string): Promise<{ success: boolean; error?: string }> {
  try {
    await x("pm2", ["stop", name], { throwOnError: true });
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pm2] Failed to stop ${name}:`, err);
    return { success: false, error: message };
  }
}

/**
 * Get logs for a specific PM2 process.
 * Reads from the PM2 log files in ~/.pm2/logs.
 */
export function getPm2Logs(
  name: string,
  options: { lines?: number; type?: "out" | "error" | "both" } = {},
): { out: string; error: string } {
  const { lines = 100, type = "both" } = options;

  const outLogPath = join(PM2_LOGS_DIR, `${name}-out.log`);
  const errorLogPath = join(PM2_LOGS_DIR, `${name}-error.log`);

  let outLogs = "";
  let errorLogs = "";

  if ((type === "out" || type === "both") && existsSync(outLogPath)) {
    outLogs = readLastLines(outLogPath, lines);
  }

  if ((type === "error" || type === "both") && existsSync(errorLogPath)) {
    errorLogs = readLastLines(errorLogPath, lines);
  }

  return { out: outLogs, error: errorLogs };
}

/**
 * Read the last N lines from a file.
 */
function readLastLines(filePath: string, numLines: number): string {
  try {
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    // Take last N lines (excluding trailing empty line if present)
    const relevantLines = lines.slice(-numLines - 1).filter((line, index, arr) => {
      // Keep all lines except empty last line
      return index < arr.length - 1 || line.trim() !== "";
    });
    return relevantLines.slice(-numLines).join("\n");
  } catch {
    return "";
  }
}

/**
 * Check if PM2 is available.
 */
export async function isPm2Available(): Promise<boolean> {
  try {
    await x("pm2", ["--version"], { throwOnError: true });
    return true;
  } catch {
    return false;
  }
}
