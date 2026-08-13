/**
 * Lifecycle wrapper around the OS dev server (`vite dev` in this worktree).
 *
 * The server itself is just `doppler run -- vite dev`; this wrapper exists
 * for parallel-worktree workflows: detached starts with log capture,
 * `status`/`attach`/`kill` against the discovery file the vite plugin
 * publishes (see vite.config.ts), and free-port picking so several
 * worktrees can run servers side by side.
 *
 *   pnpm dev                  # attached (Ctrl-C stops it)
 *   pnpm dev start --detach   # background; returns once the server is up
 *   pnpm dev status|attach|restart|kill
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createReadStream, existsSync, mkdirSync, openSync, statSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import {
  devServerDir,
  devServerLogPath,
  isPidAlive,
  readDevServerInfo,
  type DevServerInfo,
} from "./lib/dev-server-info.ts";
import { packLocalIterateSdk } from "./lib/dev-sdk-tarball.ts";

export type StartOptions = {
  /** Doppler config to load before starting the dev server. */
  config?: string;
  /** Start in the background and return once the discovery file is published. */
  detach?: boolean;
  /** Keep this wrapper command alive after detached startup. Intended for Playwright webServer. */
  keepAlive?: boolean;
  /** Port the local OS server must use. */
  port?: number;
  /** Do not load Doppler secrets before starting. Intended for already-prepared local envs. */
  skipDoppler?: boolean;
  /** Maximum time to wait for detached startup. */
  timeoutMs?: number;
};

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const LOG_PATH = devServerLogPath(APP_ROOT);
const DEFAULT_START_TIMEOUT_MS = 60_000;

/** Start the OS dev server (the default command: bare `pnpm dev` runs this). */
export default async function start(options: StartOptions = {}) {
  const requestedPort = options.port ?? (process.env.PORT ? Number(process.env.PORT) : undefined);
  const live = readDevServerInfo(APP_ROOT, { requireLive: true });
  // Captured before eviction: shutdown removes the discovery file that
  // recordedPort() reads, and the replacement should keep the stable URL.
  let evictedPort: number | undefined;
  if (live && (await evictIfMemoryPressured(live))) {
    evictedPort = live.port;
  }
  if (live && !Number.isFinite(evictedPort)) {
    if (Number.isFinite(requestedPort) && live.port !== requestedPort) {
      throw new Error(
        `A dev server is already running on port ${live.port} (pid ${live.pid}) but port ` +
          `${requestedPort} was requested — kill it or use restart.`,
      );
    }
    return { ...formatStatus(live), note: "already running — use restart to replace it" };
  }

  const port = requestedPort ?? evictedPort ?? (await pickFreePort(recordedPort()));
  // Thread the picked port through the environment too: vite.config.ts writes
  // wrangler.jsonc at import time, and the local-dev vars bake
  // APP_CONFIG_BASE_URL from PORT so the worker knows its own origin (signed
  // file URLs and other absolute-URL minting need it).
  process.env.PORT = String(port);
  // Dynamic worker builds (seeded template apps included) npm-install the
  // `iterate` package. Pack the WORKSPACE package so local dev exercises this
  // branch's SDK, exactly like preview deploys pin their PR's published
  // build. The overrides env var MUST be set here in the parent — the
  // wrangler config generator captures process.env at import time, before
  // any code in vite.config.ts could set it — while the tarball HTTP server
  // itself lives in the vite process (vite.config.ts serveDevSdkTarball),
  // which owns the long-running lifetime. Explicit
  // APP_CONFIG_ITERATE_REPO_PKG_SPEC_OVERRIDES wins (see
  // lib/dev-sdk-tarball.ts for the whole story).
  if (!process.env.APP_CONFIG_ITERATE_REPO_PKG_SPEC_OVERRIDES) {
    const { specUrl, tarball } = await packLocalIterateSdk(APP_ROOT);
    process.env.APP_CONFIG_ITERATE_REPO_PKG_SPEC_OVERRIDES = JSON.stringify({ iterate: specUrl });
    process.env.ITERATE_DEV_SDK_TARBALL = tarball;
  }
  const viteArgs = ["exec", "vite", "dev", "--port", String(port), "--strictPort"];
  const [command, args] = options.skipDoppler
    ? ["pnpm", viteArgs]
    : [
        "doppler",
        ["run", ...(options.config ? ["--config", options.config] : []), "--", "pnpm", ...viteArgs],
      ];

  if (options.detach) {
    mkdirSync(devServerDir(APP_ROOT), { recursive: true });
    const log = openSync(LOG_PATH, "w");
    const child = spawn(command, args, {
      cwd: APP_ROOT,
      detached: true,
      stdio: ["ignore", log, log],
    });
    child.unref();
    const info = await waitForDiscovery(options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS, child.pid);
    if (options.keepAlive) {
      await new Promise(() => {}); // hold until our supervisor (e.g. Playwright) kills us
    }
    return formatStatus(info);
  }

  const child = spawn(command, args, { cwd: APP_ROOT, stdio: "inherit" });
  const code = await new Promise<number>((res) => child.on("exit", (c) => res(c ?? 0)));
  process.exit(code);
}

/** Kill this worktree's dev server, then start a fresh one. */
export async function restart(options: StartOptions = {}) {
  await kill();
  return await start(options);
}

/** Stop this worktree's dev server. */
export async function kill() {
  const info = readDevServerInfo(APP_ROOT);
  if (!info || !isPidAlive(info.pid)) return { status: "not running" };
  // The recorded pid is vite's (the discovery plugin writes its own pid);
  // its doppler/pnpm parents exit on their own once vite dies.
  process.kill(info.pid, "SIGTERM");
  for (let i = 0; i < 50 && isPidAlive(info.pid); i++) await sleep(100);
  if (isPidAlive(info.pid)) process.kill(info.pid, "SIGKILL");
  return { status: "stopped", pid: info.pid };
}

/** Show this worktree's dev server state. */
export function status() {
  return formatStatus(readDevServerInfo(APP_ROOT));
}

/** Attach to the recorded OS local dev server log. */
export async function attach() {
  const info = readDevServerInfo(APP_ROOT, { requireLive: true });
  if (!info) throw new Error("No live OS dev server recorded for this worktree.");
  if (!existsSync(LOG_PATH)) {
    throw new Error(
      `No log file at ${LOG_PATH} — the server was started attached (its logs are in ` +
        `that terminal). Only detached starts (pnpm dev start --detach) write the log file.`,
    );
  }
  console.log(
    `Attached to pid ${info.pid} at ${info.baseUrl} (Ctrl-C detaches; server keeps running)`,
  );
  let offset = 0;
  for (;;) {
    const size = existsSync(LOG_PATH) ? statSync(LOG_PATH).size : offset;
    if (size > offset) {
      await new Promise<void>((res, rej) => {
        const stream = createReadStream(LOG_PATH, { start: offset, end: size - 1 });
        stream.pipe(process.stdout, { end: false });
        stream.on("end", res);
        stream.on("error", rej);
      });
      offset = size;
    }
    if (!isPidAlive(info.pid)) return { status: "server exited" };
    await sleep(300);
  }
}

export const localOsDevServer = {
  readLive: () => readDevServerInfo(APP_ROOT, { requireLive: true }),
  resolveTarget: resolveLocalOsDevServerTarget,
  /** Kill the live server iff its workerd RSS is over the limit; returns
   * whether it was killed. The e2e lane calls this between files to recycle a
   * bloating local server before it SIGABRTs mid-suite (see evictIfMemoryPressured). */
  killIfMemoryPressured: evictIfMemoryPressured,
};

export const doppler = {
  loadOsSecrets,
};

/** Resolve the OS local dev server target that a caller should use. */
async function resolveLocalOsDevServerTarget(
  env: NodeJS.ProcessEnv = process.env,
): Promise<
  | { baseUrl: string; kind: "live"; port: number; info: DevServerInfo }
  | { baseUrl: string; kind: "start"; port: number }
> {
  const live = readDevServerInfo(APP_ROOT, { requireLive: true });
  if (live) {
    if (await evictIfMemoryPressured(live)) {
      // Same port so the caller's webServer machinery boots a fresh server
      // at the URL it already resolved.
      return { baseUrl: live.baseUrl.replace(/\/+$/, ""), kind: "start", port: live.port };
    }
    return { baseUrl: live.baseUrl.replace(/\/+$/, ""), info: live, kind: "live", port: live.port };
  }
  const envPort = env.PORT ? Number(env.PORT) : undefined;
  const port = await pickFreePort(envPort || recordedPort());
  return { baseUrl: `http://localhost:${port}`, kind: "start", port };
}

/**
 * Local workerd NEVER evicts worker-loader isolates (upstream: platform
 * concern), every project worker / script run loads one under a fresh key,
 * and all isolates share a ~4GB V8 pointer cage — so a long-lived dev
 * server is a slow-motion SIGABRT (the historical "restart the dev server
 * before every spec run" ritual). Details: tasks/miniflare-oom-investigation.md.
 * Treat a bloated workerd as already dead: kill it so callers start fresh.
 */
async function evictIfMemoryPressured(live: DevServerInfo) {
  // Guard NaN: `rssMb < NaN` is false, so a typo'd env var would otherwise
  // evict every live server on every start.
  const configured = Number(process.env.ITERATE_DEV_WORKERD_RSS_LIMIT_MB);
  const limitMb = Number.isFinite(configured) && configured > 0 ? configured : 2048;
  const rssMb = Math.round(workerdRssKb(live.pid) / 1024);
  if (rssMb < limitMb) return false;
  console.error(
    `[dev] workerd RSS is ${rssMb}MB (limit ${limitMb}MB) — killing pid ${live.pid} for a fresh ` +
      `start before the V8 pointer cage fills and it SIGABRTs mid-request.`,
  );
  await kill();
  return true;
}

/**
 * Sum RSS of the dev server's workerd descendants (vite spawns miniflare
 * which spawns workerd; RSS in kB as reported by ps). workerd is where
 * loader isolates accumulate, so its RSS — not node's heap — is the health
 * signal that predicts the crash.
 */
function workerdRssKb(rootPid: number) {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,rss=,comm="], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) return 0;
  const rows = result.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [pid, ppid, rss, ...comm] = line.trim().split(/\s+/);
      return { pid: Number(pid), ppid: Number(ppid), rss: Number(rss), comm: comm.join(" ") };
    });
  const childrenByPpid = new Map<number, typeof rows>();
  for (const row of rows) {
    childrenByPpid.set(row.ppid, [...(childrenByPpid.get(row.ppid) || []), row]);
  }
  let totalKb = 0;
  const queue = [rootPid];
  while (queue.length > 0) {
    for (const child of childrenByPpid.get(queue.shift()!) || []) {
      if (child.comm.includes("workerd")) totalKb += child.rss;
      queue.push(child.pid);
    }
  }
  return totalKb;
}

/** This worktree's last-used port, so restarts keep stable URLs. */
function recordedPort() {
  return readDevServerInfo(APP_ROOT)?.port;
}

async function pickFreePort(preferred?: number): Promise<number> {
  const tryPort = (port?: number) =>
    new Promise<number | null>((res) => {
      const server = createServer();
      server.once("error", () => res(null));
      server.listen(port ?? 0, "127.0.0.1", () => {
        const address = server.address();
        const got = typeof address === "object" && address ? address.port : null;
        server.close(() => res(got));
      });
    });
  if (preferred) {
    const got = await tryPort(preferred);
    if (got) return got;
  }
  const got = await tryPort();
  if (!got) throw new Error("Could not find a free port for the dev server.");
  return got;
}

async function waitForDiscovery(timeoutMs: number, childPid?: number): Promise<DevServerInfo> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = readDevServerInfo(APP_ROOT, { requireLive: true });
    if (info) return info;
    if (childPid && !isPidAlive(childPid)) {
      throw new Error(`Dev server exited during startup — see ${LOG_PATH}`);
    }
    await sleep(250);
  }
  throw new Error(
    `Dev server did not publish ${devServerDir(APP_ROOT)}/dev-server.json within ${timeoutMs}ms — see ${LOG_PATH}`,
  );
}

/** Download this app's Doppler secrets as a plain object (config from doppler.yaml scoping unless overridden). */
function loadOsSecrets(options: { config?: string; env?: NodeJS.ProcessEnv } = {}) {
  try {
    const result = spawnSync(
      "doppler",
      [
        "secrets",
        "download",
        "--no-file",
        "--format",
        "json",
        ...(options.config ? ["--config", options.config] : []),
      ],
      {
        cwd: APP_ROOT,
        encoding: "utf8",
        env: options.env || process.env,
        maxBuffer: 10 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      return {
        ok: false as const,
        error: result.stderr.trim() || `doppler exited with status ${result.status}`,
      };
    }
    return { ok: true as const, secrets: JSON.parse(result.stdout) as Record<string, string> };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

function formatStatus(info: DevServerInfo | null) {
  if (!info) return { status: "not running" as const };
  const live = isPidAlive(info.pid);
  return {
    status: live ? ("running" as const) : ("stale" as const),
    pid: info.pid,
    port: info.port,
    baseUrl: info.baseUrl,
    startedAt: info.startedAt,
    // The crash predictor: worker-loader isolates accumulate here until the
    // ~4GB pointer cage fills (tasks/miniflare-oom-investigation.md).
    workerdRssMb: live ? Math.round(workerdRssKb(info.pid) / 1024) : undefined,
    log: LOG_PATH,
  };
}

// createCli({...import.meta}) runs the CLI only when this file is the process
// entry (playwright.config.ts imports this module for localOsDevServer).
void createCli({
  ...import.meta,
  name: "dev",
  jsonInput: "auto",
}).run({
  logger: yamlTableConsoleLogger,
  prompts: isAgent() ? undefined : createBuiltInPrompts(),
});
