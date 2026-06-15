import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

/**
 * Fully-local dev server bootstrap: free-port picking, a curlable localhost
 * base URL, and a per-worktree discovery file.
 *
 * Default local dev runs with zero Cloudflare resources. The curlable local
 * server URL is `http://localhost:<port>` so curl/Node clients work without
 * special DNS setup. Browser-only project hosts work as
 * `<proj-slug>.localhost:<port>`.
 *
 * The port is picked at startup. `.alchemy/dev-server.json` records
 * {pid, port, baseUrl, logPath, stoppedAt?} so CLIs and scripts can find
 * "the" dev server without flags. When no public app URL is configured, the
 * local URL is also exposed as `APP_CONFIG_BASE_URL`; when a public app URL is
 * configured in `APP_CONFIG.baseUrl`, runtime config keeps that public URL and
 * the discovery file remains the source of truth for the local target.
 * One dev server per worktree: a second `pnpm dev` refuses to start while the
 * recorded pid is alive.
 */

export type DevServerInfo = {
  pid: number;
  port: number;
  baseUrl: string;
  logPath?: string;
  startedAt: string;
  stoppedAt?: string;
};

const DEV_SERVER_INFO_FILENAME = "dev-server.json";
const DEV_SERVER_LOG_FILENAME = "dev-server.log";

function devServerInfoPath(appDir: string) {
  return join(appDir, ".alchemy", DEV_SERVER_INFO_FILENAME);
}

export function localDevServerLogPath(appDir: string) {
  return join(appDir, ".alchemy", DEV_SERVER_LOG_FILENAME);
}

export function readLocalDevServerInfo(
  appDir: string,
  opts: { requireLive?: boolean } = {},
): DevServerInfo | null {
  const path = devServerInfoPath(appDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as DevServerInfo;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.port !== "number" ||
      typeof parsed.baseUrl !== "string"
    ) {
      return null;
    }
    if (opts.requireLive && (parsed.stoppedAt || !isPidAlive(parsed.pid))) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function releaseLocalDevServerInfo(appDir: string, pid: number) {
  const path = devServerInfoPath(appDir);
  try {
    const current = readLocalDevServerInfo(appDir);
    if (current?.pid === pid) {
      writeFileSync(
        path,
        `${JSON.stringify({ ...current, stoppedAt: new Date().toISOString() }, null, 2)}\n`,
      );
    }
  } catch {
    // best effort — a stale file is detected by pid liveness anyway
  }
}

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isPortFree(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1" }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function pickFreePort(preferred?: number) {
  if (preferred && preferred > 0 && (await isPortFree(preferred))) {
    return preferred;
  }
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("Could not determine free port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

/**
 * Prepare the fully-local dev flow. No-op (returns null) unless this is a
 * local run (`ALCHEMY_LOCAL`) without an explicit `APP_CONFIG_BASE_URL`.
 *
 * Mutates `env`: sets `PORT` and `HOST`, writes the discovery file, and
 * installs exit handlers that mark the server stopped while preserving the
 * last port. Also sets `APP_CONFIG_BASE_URL` to `http://localhost:<port>` when
 * no explicit base URL exists in either `APP_CONFIG_BASE_URL` or
 * `APP_CONFIG.baseUrl`.
 */
export async function prepareLocalDevServer(
  env: Record<string, string | undefined>,
  opts: { appDir?: string } = {},
): Promise<DevServerInfo | null> {
  const isLocal = ["true", "1", "yes"].includes((env.ALCHEMY_LOCAL ?? "").trim().toLowerCase());
  if (!isLocal) return null;
  if (env.APP_CONFIG_BASE_URL?.trim()) return null;

  const appDir = opts.appDir ?? process.cwd();
  const existing = readLocalDevServerInfo(appDir);
  if (existing && existing.pid !== process.pid && !existing.stoppedAt && isPidAlive(existing.pid)) {
    throw new Error(
      `A dev server for this worktree is already running (pid ${existing.pid}, ${existing.baseUrl}). ` +
        `One dev server per worktree: stop it first, or work in another worktree. ` +
        `If this is wrong, delete ${devServerInfoPath(appDir)}.`,
    );
  }

  // Reuse the previous (now-stale) port when it's still free so the base URL
  // stays stable across restarts — browser sessions and bookmarks survive.
  const envPort = env.PORT ? Number(env.PORT) : undefined;
  const port = await pickFreePort(envPort ?? existing?.port);

  const baseUrl = `http://localhost:${port}`;
  const logPath = env.DEV_SERVER_LOG_PATH?.trim() || localDevServerLogPath(appDir);
  env.PORT = String(port);
  env.HOST ||= "127.0.0.1";
  const rawAppConfig = JSON.parse(env.APP_CONFIG ?? "{}") as { baseUrl?: string };
  env.APP_CONFIG_BASE_URL = rawAppConfig.baseUrl || baseUrl;
  // The vite dev command is spawned with the real process env, which may not
  // be the same object as `env` — keep them in sync for the port/host.
  process.env.PORT = env.PORT;
  process.env.HOST = env.HOST;

  const info: DevServerInfo = {
    pid: process.pid,
    port,
    baseUrl,
    logPath,
    startedAt: new Date().toISOString(),
  };

  const path = devServerInfoPath(appDir);
  mkdirSync(join(appDir, ".alchemy"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(info, null, 2)}\n`);

  const cleanup = () => releaseLocalDevServerInfo(appDir, process.pid);
  process.once("exit", cleanup);
  process.once("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  console.log(`Local dev server: ${baseUrl} (discovery file: ${path})`);
  return info;
}
