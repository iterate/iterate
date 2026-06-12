import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

/**
 * Fully-local dev server bootstrap: free-port picking, `os.localhost`-style
 * base URLs, and a per-worktree discovery file.
 *
 * Default local dev runs with zero Cloudflare resources: no tunnel, no
 * per-user domain. The browser reaches the app at
 * `http://<app>.localhost:<port>` (every browser resolves `*.localhost` to
 * loopback and treats it as a secure context — no certs, no /etc/hosts), and
 * project hosts work as `<proj-slug>.<app>.localhost:<port>`.
 *
 * The port is picked at startup and baked into `APP_CONFIG_BASE_URL` (env is
 * the source of truth — request-sniffing doesn't work for cron/scheduled
 * work). `.alchemy/dev-server.json` records {pid, port, baseUrl} so CLIs and
 * scripts can find "the" dev server without flags. The file intentionally
 * survives shutdown so the next `pnpm dev` can reuse the same port when it is
 * still free. One dev server per worktree: a second `pnpm dev` refuses to
 * start while the recorded pid is alive.
 */

export type DevServerInfo = {
  pid: number;
  port: number;
  baseUrl: string;
  startedAt: string;
};

const DEV_SERVER_INFO_FILENAME = "dev-server.json";

export function devServerInfoPath(appDir: string) {
  return join(appDir, ".alchemy", DEV_SERVER_INFO_FILENAME);
}

export function readDevServerInfoFile(appDir: string): DevServerInfo | null {
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
    return parsed;
  } catch {
    return null;
  }
}

export function isPidAlive(pid: number) {
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPidExit(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(100);
  }
  return !isPidAlive(pid);
}

export type KillLocalDevServerResult =
  | { status: "missing"; path: string }
  | { status: "stale"; path: string; info: DevServerInfo }
  | { status: "killed"; path: string; info: DevServerInfo; signal: NodeJS.Signals }
  | { status: "force-killed"; path: string; info: DevServerInfo };

export async function killLocalDevServer(
  opts: {
    appDir?: string;
    signal?: NodeJS.Signals;
    timeoutMs?: number;
    forceAfterTimeout?: boolean;
  } = {},
): Promise<KillLocalDevServerResult> {
  const appDir = opts.appDir ?? process.cwd();
  const path = devServerInfoPath(appDir);
  const info = readDevServerInfoFile(appDir);
  if (!info) return { status: "missing", path };
  if (!isPidAlive(info.pid)) return { status: "stale", path, info };

  const signal = opts.signal ?? "SIGTERM";
  const timeoutMs = opts.timeoutMs ?? 5_000;
  try {
    process.kill(info.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return { status: "stale", path, info };
    }
    throw error;
  }

  if (await waitForPidExit(info.pid, timeoutMs)) {
    return { status: "killed", path, info, signal };
  }

  const shouldForceKill = opts.forceAfterTimeout ?? signal !== "SIGKILL";
  if (shouldForceKill) {
    process.kill(info.pid, "SIGKILL");
    if (await waitForPidExit(info.pid, timeoutMs)) {
      return { status: "force-killed", path, info };
    }
  }

  throw new Error(`Timed out waiting for dev server pid ${info.pid} to exit.`);
}

/**
 * Prepare the fully-local dev flow. No-op (returns null) unless this is a
 * local run (`ALCHEMY_LOCAL`) without an explicit `APP_CONFIG_BASE_URL` —
 * tunnel-backed per-user configs and explicit localhost configs keep their
 * existing behavior untouched.
 *
 * Mutates `env`: sets `PORT`, `HOST`, and `APP_CONFIG_BASE_URL`
 * (`http://<app>.localhost:<port>`) and writes the discovery file. The
 * discovery file is not removed at exit; a stale file is how the next run
 * remembers the preferred port.
 */
export async function prepareLocalDevServer(
  env: Record<string, string | undefined>,
  opts: { appSlug: string; appDir?: string },
): Promise<DevServerInfo | null> {
  const isLocal = ["true", "1", "yes"].includes((env.ALCHEMY_LOCAL ?? "").trim().toLowerCase());
  if (!isLocal) return null;
  if (env.APP_CONFIG_BASE_URL?.trim()) return null;

  const appDir = opts.appDir ?? process.cwd();
  const existing = readDevServerInfoFile(appDir);
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

  const baseUrl = `http://${opts.appSlug}.localhost:${port}`;
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
    startedAt: new Date().toISOString(),
  };

  const path = devServerInfoPath(appDir);
  mkdirSync(join(appDir, ".alchemy"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(info, null, 2)}\n`);

  console.log(`Local dev server: ${baseUrl} (discovery file: ${path})`);
  return info;
}
