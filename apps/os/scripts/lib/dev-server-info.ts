import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * What a running OS dev server publishes about itself. Written by the
 * `iterate:dev-server-discovery-file` plugin in vite.config.ts the moment the
 * server listens, removed on shutdown — so any tool (auth:mint, e2e, agent
 * browsers, `pnpm dev status`) can find this worktree's server without
 * knowing how it was started.
 */
export interface DevServerInfo {
  pid: number;
  port: number;
  baseUrl: string;
  startedAt: string;
}

/** Discovery/log directory for a worktree's dev server, relative to the app root. */
export const devServerDir = (appRoot: string) => resolve(appRoot, ".dev-server");
export const devServerInfoPath = (appRoot: string) =>
  resolve(devServerDir(appRoot), "dev-server.json");
export const devServerLogPath = (appRoot: string) =>
  resolve(devServerDir(appRoot), "dev-server.log");

/**
 * Read this worktree's dev server info; `requireLive` additionally checks the
 * recorded pid is still running (a crashed server can leave the file behind).
 */
export function readDevServerInfo(
  appRoot: string,
  opts: { requireLive?: boolean } = {},
): DevServerInfo | null {
  const path = devServerInfoPath(appRoot);
  if (!existsSync(path)) return null;
  const info = JSON.parse(readFileSync(path, "utf8")) as DevServerInfo;
  if (opts.requireLive && !isPidAlive(info.pid)) return null;
  return info;
}

export function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
