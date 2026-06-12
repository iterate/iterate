import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

/**
 * Fully-local dev server bootstrap: free-port picking, a curlable localhost
 * base URL, and a per-worktree discovery file.
 *
 * Default local dev runs with zero Cloudflare resources: no tunnel, no
 * per-user domain. The app's canonical URL is `http://localhost:<port>` so
 * curl/Node clients work without special DNS setup. Browser-only project hosts
 * work as `<proj-slug>.localhost:<port>`.
 *
 * The port is picked at startup and baked into `APP_CONFIG_BASE_URL` (env is
 * the source of truth — request-sniffing doesn't work for cron/scheduled
 * work). `.alchemy/dev-server.json` records {pid, port, baseUrl, logPath} so
 * CLIs and scripts can find "the" dev server without flags. One dev server
 * per worktree: a second `pnpm dev` refuses to start while the recorded pid is
 * alive.
 */

export type DevServerInfo = {
  pid: number;
  port: number;
  baseUrl: string;
  logPath?: string;
  startedAt: string;
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
    if (opts.requireLive && !isPidAlive(parsed.pid)) return null;
    return parsed;
  } catch {
    return null;
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
 * local run (`ALCHEMY_LOCAL`) without an explicit `APP_CONFIG_BASE_URL` —
 * tunnel-backed per-user configs and explicit localhost configs keep their
 * existing behavior untouched.
 *
 * Mutates `env`: sets `PORT`, `HOST`, and `APP_CONFIG_BASE_URL`
 * (`http://localhost:<port>`), writes the discovery file, and installs exit
 * handlers that clean it up.
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
  if (existing && existing.pid !== process.pid && isPidAlive(existing.pid)) {
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
  env.APP_CONFIG_BASE_URL = baseUrl;
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

  const cleanup = () => {
    try {
      const current = readLocalDevServerInfo(appDir);
      if (current?.pid === process.pid) {
        rmSync(path, { force: true });
      }
    } catch {
      // best effort — a stale file is detected by pid liveness anyway
    }
  };
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
