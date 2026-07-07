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
  if (live) {
    if (requestedPort !== undefined && live.port !== requestedPort) {
      throw new Error(
        `A dev server is already running on port ${live.port} (pid ${live.pid}) but port ` +
          `${requestedPort} was requested — kill it or use restart.`,
      );
    }
    return { ...formatStatus(live), note: "already running — use restart to replace it" };
  }

  const port = requestedPort ?? (await pickFreePort(recordedPort()));
  const env = { ...process.env, ...(await forgeTrustedJwksEnv(options)) };
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
      env,
      stdio: ["ignore", log, log],
    });
    child.unref();
    const info = await waitForDiscovery(options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS, child.pid);
    if (options.keepAlive) {
      await new Promise(() => {}); // hold until our supervisor (e.g. Playwright) kills us
    }
    return formatStatus(info);
  }

  const child = spawn(command, args, { cwd: APP_ROOT, env, stdio: "inherit" });
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
    return { baseUrl: live.baseUrl.replace(/\/+$/, ""), info: live, kind: "live", port: live.port };
  }
  const envPort = env.PORT ? Number(env.PORT) : undefined;
  const port = await pickFreePort(envPort || recordedPort());
  return { baseUrl: `http://localhost:${port}`, kind: "start", port };
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

/**
 * Local dev's answer to deploy-time JWKS baking (scripts/lib/bake-auth-jwks.ts):
 * deployed workers verify auth JWTs against a baked key set that includes the
 * forge public key, but a local dev server has no bake step — without this,
 * `pnpm auth:mint` sessions and forge-minted bearer tokens fail with
 * JWKSNoMatchingKey (tasks/os-dev-server-auth-minting-without-auth-worker.md).
 *
 * When the Doppler config doesn't pin APP_CONFIG_ITERATE_AUTH__JWKS but does
 * carry the forge private key, fetch the issuer's live JWKS, merge the forge
 * public key in, and hand the result to the vite child as that same env var
 * (the generated wrangler config lists it, so the worker picks it up).
 * Best-effort: any failure warns and starts the server without it, exactly as
 * today — never blocks dev boot (unlike the deploy path's 4-minute retry).
 */
async function forgeTrustedJwksEnv(
  options: Pick<StartOptions, "config" | "skipDoppler">,
): Promise<{ APP_CONFIG_ITERATE_AUTH__JWKS?: string }> {
  try {
    const loaded = options.skipDoppler
      ? { ok: true as const, secrets: process.env as Record<string, string | undefined> }
      : loadOsSecrets({ config: options.config });
    if (!loaded.ok) return {};
    const secrets = loaded.secrets;
    if (secrets.APP_CONFIG_ITERATE_AUTH__JWKS?.trim()) return {};
    const forgePrivateJwk = secrets.AUTH_FORGE_PRIVATE_JWK?.trim();
    const issuer = secrets.APP_CONFIG_ITERATE_AUTH__ISSUER?.trim();
    if (!forgePrivateJwk || !issuer) return {};

    const response = await fetch(`${issuer.replace(/\/+$/, "")}/jwks`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`GET ${issuer}/jwks → ${response.status}`);
    const jwks = (await response.json()) as { keys: Record<string, unknown>[] };
    const { d: _privateKey, ...publicJwk } = JSON.parse(forgePrivateJwk) as Record<
      string,
      unknown
    > & { d?: string };
    if (!publicJwk.kid || !publicJwk.kty) return {};
    if (!jwks.keys.some((key) => key.kid === publicJwk.kid)) jwks.keys.push(publicJwk);
    return { APP_CONFIG_ITERATE_AUTH__JWKS: JSON.stringify(jwks) };
  } catch (error) {
    console.warn(
      `Could not merge the forge key into the dev JWKS (forge-minted sessions/tokens won't verify): ${String(error)}`,
    );
    return {};
  }
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
    log: LOG_PATH,
  };
}

// Run the CLI only when invoked directly (playwright.config.ts imports this
// module for localOsDevServer without wanting a CLI).
if (process.argv[1]?.endsWith("dev.ts")) {
  void createCli({
    ...import.meta,
    name: "dev",
    jsonInput: "auto",
  }).run({
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}
