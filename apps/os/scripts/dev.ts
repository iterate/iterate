import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeSync,
} from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { os } from "@orpc/server";
import { createCli } from "trpc-cli";
import { z } from "zod/v4";

import {
  localDevServerLogPath,
  readLocalDevServerInfo,
  releaseLocalDevServerInfo,
  type DevServerInfo,
} from "@iterate-com/shared/alchemy/local-dev-server";

export type LocalOsDevServerTarget =
  | { baseUrl: string; kind: "live"; port: number; info: DevServerInfo }
  | { baseUrl: string; kind: "start"; port: number };

export type StartOptions = {
  attach?: boolean;
  config?: string;
  detach?: boolean;
  keepAlive?: boolean;
  noDoppler?: boolean;
  port?: number;
  timeoutMs?: number;
};

type CliStartOptions = z.input<typeof CliStartOptions>;

const EmptyInput = z.object({});
const CliStartOptions = z.object({
  attach: z.boolean().optional().describe("Keep this process attached to the dev server output."),
  config: z.string().optional().describe("Doppler config to use when entering Doppler."),
  detach: z
    .boolean()
    .optional()
    .describe("Start in the background and return once the discovery file is published."),
  keepAlive: z
    .boolean()
    .optional()
    .describe(
      "Keep this wrapper command alive after detached startup. Intended for Playwright webServer.",
    ),
  skipDoppler: z
    .boolean()
    .optional()
    .describe("Do not enter Doppler before starting. Intended for already-prepared local envs."),
  port: z
    .number()
    .int()
    .min(1)
    .max(65_535)
    .optional()
    .describe("Port the local OS server must use."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum time to wait for detached startup."),
});

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ALCHEMY_DIR = resolve(APP_ROOT, ".alchemy");
const LOG_PATH = localDevServerLogPath(APP_ROOT);
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_KILL_TIMEOUT_MS = 10_000;
const DEFAULT_HEAD_LINES = 80;
const DEFAULT_TAIL_LINES = 80;

/** Start the OS local dev server, or attach if it is already running. */
export default async function start(options: StartOptions = {}) {
  const attach = options.attach === undefined ? !options.detach : options.attach;
  const detach = !attach;
  const keepAlive = Boolean(options.keepAlive);
  const port = options.port === undefined ? undefined : validateExplicitPort(options.port);
  const timeoutMs = options.timeoutMs || DEFAULT_START_TIMEOUT_MS;
  if (keepAlive && !detach) {
    throw new Error("keepAlive requires detach.");
  }

  if (!options.noDoppler && !process.env.DOPPLER_CONFIG) {
    return runInDoppler("start", { ...options, attach, detach, keepAlive, port, timeoutMs });
  }

  const result = await startDevServer({ attach, detach, port, timeoutMs });
  if (keepAlive) await keepProcessAlive();
  return result;
}

/** Restart the OS local dev server. */
export async function restart(options: StartOptions = {}) {
  const attach = options.attach === undefined ? !options.detach : options.attach;
  const detach = !attach;
  const keepAlive = Boolean(options.keepAlive);
  const port = options.port === undefined ? undefined : validateExplicitPort(options.port);
  const timeoutMs = options.timeoutMs || DEFAULT_START_TIMEOUT_MS;
  if (keepAlive && !detach) {
    throw new Error("keepAlive requires detach.");
  }

  if (!options.noDoppler && !process.env.DOPPLER_CONFIG) {
    return runInDoppler("restart", { ...options, attach, detach, keepAlive, port, timeoutMs });
  }

  assertLocalAlchemyDev();
  await kill();
  const result = await startDevServer({ attach, detach, port, timeoutMs });
  if (keepAlive) await keepProcessAlive();
  return result;
}

/** Stop the recorded OS local dev server. */
export async function kill() {
  const info = readLocalDevServerInfo(APP_ROOT, { requireLive: true });
  if (!info) {
    return { killed: false, message: "No live OS dev server recorded for this worktree." };
  }

  try {
    process.kill(info.pid, "SIGTERM");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      releaseLocalDevServerInfo(APP_ROOT, info.pid);
      return {
        killed: false,
        message: `Recorded OS dev server pid ${info.pid} is no longer running.`,
      };
    }
    throw error;
  }
  const stopped = await waitUntil(() => !isPidAlive(info.pid), DEFAULT_KILL_TIMEOUT_MS, 100);
  if (!stopped) {
    throw new Error(
      `OS dev server pid ${info.pid} did not exit after SIGTERM. Stop it manually if needed.`,
    );
  }

  releaseLocalDevServerInfo(APP_ROOT, info.pid);
  console.info(`Stopped OS dev server: ${info.baseUrl} (pid ${info.pid})`);
  return { killed: true, pid: info.pid, baseUrl: info.baseUrl };
}

/** Show the recorded OS local dev server status. */
export function status() {
  return formatStatus(readLocalDevServerInfo(APP_ROOT));
}

/** Attach to the recorded OS local dev server log. */
export async function attach() {
  const info = readLocalDevServerInfo(APP_ROOT, { requireLive: true });
  if (!info) {
    throw new Error("No live OS dev server recorded for this worktree.");
  }
  return await attachToDevServer(info);
}

export const localOsDevServer = {
  readLive: readLiveLocalOsDevServer,
  resolveTarget: resolveLocalOsDevServerTarget,
};

/** Resolve the OS local dev server target that a caller should use. */
async function resolveLocalOsDevServerTarget(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocalOsDevServerTarget> {
  const live = readLiveLocalOsDevServer();
  if (live) {
    return {
      baseUrl: normalizeBaseUrl(live.baseUrl),
      info: live,
      kind: "live",
      port: live.port,
    };
  }

  const recorded = readLocalDevServerInfo(APP_ROOT);
  const envPort = env.PORT ? Number(env.PORT) : undefined;
  const preferredPort = envPort || (recorded && recorded.port) || undefined;
  const port = await pickFreePort(preferredPort);
  return {
    baseUrl: `http://localhost:${port}`,
    kind: "start",
    port,
  };
}

/** Read the live OS local dev server record for this worktree. */
function readLiveLocalOsDevServer() {
  return readLocalDevServerInfo(APP_ROOT, { requireLive: true });
}

async function startDevServer(input: {
  attach: boolean;
  detach: boolean;
  port: number | undefined;
  timeoutMs: number;
}) {
  assertLocalAlchemyDev();
  const shouldStream = !input.detach && input.attach;
  const existing = readLocalDevServerInfo(APP_ROOT, { requireLive: true });
  if (existing) {
    assertDevServerPort(existing, input.port);
    console.info(`OS dev server already running: ${existing.baseUrl} (pid ${existing.pid})`);
    if (shouldStream) await attachToDevServer(existing);
    return formatStatus(existing);
  }

  if (shouldStream) {
    return startAttachedDevServer(input.port);
  }

  return startDetachedDevServer(input.timeoutMs, input.port);
}

async function startAttachedDevServer(port: number | undefined) {
  mkdirSync(ALCHEMY_DIR, { recursive: true });
  const command = "tsx";
  const commandArgs = ["./alchemy.run.ts"];
  const log = createWriteStream(LOG_PATH, { flags: "w" });

  log.write(logHeader(command, commandArgs));

  const child = spawn(command, commandArgs, {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      DEV_SERVER_LOG_PATH: LOG_PATH,
      ...(port ? { PORT: String(port) } : {}),
    },
    stdio: ["inherit", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk: Buffer) => teeOutput(chunk, process.stdout, log));
  child.stderr?.on("data", (chunk: Buffer) => teeOutput(chunk, process.stderr, log));

  child.on("error", (error) => {
    console.error(error);
    log.write(`${error.stack || error.message}\n`);
    log.end(() => process.exit(1));
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => child.kill(signal));
  }

  return new Promise<{ exitCode: number }>((resolve) => {
    child.on("exit", (code, signal) => {
      log.end(() => {
        const exitCode = code || exitCodeForSignal(signal) || 1;
        process.exitCode = exitCode;
        resolve({ exitCode });
      });
    });
  });
}

async function startDetachedDevServer(timeoutMs: number, port: number | undefined) {
  mkdirSync(ALCHEMY_DIR, { recursive: true });
  const command = "tsx";
  const commandArgs = ["./alchemy.run.ts"];
  const logFd = openSync(LOG_PATH, "w");
  writeSync(logFd, logHeader(command, commandArgs));

  const child = spawn(command, commandArgs, {
    cwd: APP_ROOT,
    detached: true,
    env: {
      ...process.env,
      DEV_SERVER_LOG_PATH: LOG_PATH,
      ...(port ? { PORT: String(port) } : {}),
    },
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  closeSync(logFd);

  const info = await waitUntil(
    () => readLocalDevServerInfo(APP_ROOT, { requireLive: true }),
    timeoutMs,
    250,
  );
  if (!info) {
    throw new Error(
      `OS dev server did not publish .alchemy/dev-server.json within ${timeoutMs}ms. ` +
        `Check ${LOG_PATH}. Spawned pid: ${child.pid || "unknown"}.`,
    );
  }

  assertDevServerPort(info, port);
  console.info(`Started OS dev server: ${info.baseUrl} (pid ${info.pid})`);
  return formatStatus(info);
}

async function attachToDevServer(info: DevServerInfo) {
  const logPath = info.logPath?.trim() || LOG_PATH;
  writeAttachPreamble(info, logPath);
  if (!existsSync(logPath)) {
    console.info("Waiting for log file...");
  }

  let offset = existsSync(logPath) ? writeLogExcerpt(logPath) : 0;

  await new Promise<void>((resolvePromise) => {
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(interval);
      process.off("SIGINT", onSigint);
      resolvePromise();
    };

    const onSigint = () => finish();
    process.once("SIGINT", onSigint);

    const interval = setInterval(() => {
      if (existsSync(logPath)) {
        const size = statSync(logPath).size;
        if (size < offset) offset = 0;
        if (size > offset) {
          createReadStream(logPath, { start: offset, end: size - 1 }).pipe(process.stdout, {
            end: false,
          });
          offset = size;
        }
      }
      if (!isPidAlive(info.pid)) finish();
    }, 500);
  });

  return formatStatus(info);
}

async function pickFreePort(preferredPort: number | undefined) {
  if (preferredPort && preferredPort > 0 && (await isPortFree(preferredPort))) {
    return preferredPort;
  }
  return await portFromTemporaryServer(0);
}

async function isPortFree(port: number) {
  try {
    await portFromTemporaryServer(port);
    return true;
  } catch {
    return false;
  }
}

function portFromTemporaryServer(port: number) {
  return new Promise<number>((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("Could not determine free port")));
        return;
      }
      server.close(() => resolvePromise(address.port));
    });
  });
}

function runInDoppler(action: "restart" | "start", options: StartOptions) {
  const dopplerArgs = [
    "run",
    ...(options.config ? ["--config", options.config] : []),
    "--",
    "tsx",
    "./scripts/dev.ts",
    action,
    "--skip-doppler",
    ...(options.detach ? ["--detach"] : []),
    ...(options.keepAlive ? ["--keep-alive"] : []),
    ...(options.port ? ["--port", String(options.port)] : []),
    ...(options.timeoutMs ? ["--timeout-ms", String(options.timeoutMs)] : []),
  ];
  return spawnSyncExitCode("doppler", dopplerArgs);
}

async function keepProcessAlive() {
  const live = readLiveLocalOsDevServer();
  if (!live) {
    throw new Error("OS dev server started but did not publish apps/os/.alchemy/dev-server.json.");
  }

  const baseUrl = normalizeBaseUrl(live.baseUrl);
  console.info(`OS specs using local dev server ${baseUrl} (pid ${live.pid})`);

  await new Promise<void>((resolvePromise) => {
    const interval = setInterval(() => undefined, 60_000);
    const finish = () => {
      clearInterval(interval);
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolvePromise();
    };

    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

function validateExplicitPort(port: number) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Port must be an integer from 1 to 65535. Received: ${port}`);
  }
  return port;
}

function assertDevServerPort(info: DevServerInfo, expectedPort: number | undefined) {
  if (expectedPort === undefined || info.port === expectedPort) return;
  throw new Error(
    `OS dev server is running on port ${info.port}, but port ${expectedPort} was requested.`,
  );
}

function teeOutput(chunk: Buffer, stream: NodeJS.WriteStream, log: NodeJS.WritableStream) {
  stream.write(chunk);
  log.write(chunk);
}

async function waitUntil<T>(
  read: () => T | false | null | undefined,
  timeoutMs: number,
  intervalMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  return read() || null;
}

function formatStatus(info: DevServerInfo | null) {
  if (!info) {
    return { live: false, recorded: false, logPath: LOG_PATH };
  }

  return {
    live: !info.stoppedAt && isPidAlive(info.pid),
    recorded: true,
    pid: info.pid,
    port: info.port,
    baseUrl: info.baseUrl,
    logPath: info.logPath || LOG_PATH,
    startedAt: info.startedAt,
    stoppedAt: info.stoppedAt,
  };
}

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function assertLocalAlchemyDev() {
  const isLocal = /^(1|true|yes)$/i.test(process.env.ALCHEMY_LOCAL?.trim() || "");
  if (!isLocal) {
    throw new Error(
      "Refusing to run the OS dev server because ALCHEMY_LOCAL is not true. " +
        `Doppler config ${process.env.DOPPLER_CONFIG || "(unset)"} would run ` +
        `stage ${process.env.ALCHEMY_STAGE || "(unset)"} as a deploy. ` +
        "Use doppler run --project os --config <config> -- pnpm deploy for intentional deployments.",
    );
  }
}

function writeAttachPreamble(info: DevServerInfo, logPath: string) {
  const baseUrl = new URL(info.baseUrl);
  const parentPid = spawnSync("ps", ["-o", "ppid=", "-p", String(info.pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).stdout?.trim();
  const serverStatus = !info.stoppedAt && isPidAlive(info.pid) ? "live" : "not live";
  const lines = [
    "Attaching to OS dev server",
    `Status: ${serverStatus}`,
    `Base URL: ${info.baseUrl}`,
    `Host: ${baseUrl.hostname}`,
    `Port: ${info.port}`,
    `PID: ${info.pid}`,
    ...(parentPid && /^\d+$/.test(parentPid) ? [`Parent PID: ${parentPid}`] : []),
    `Started: ${info.startedAt}`,
    ...(info.stoppedAt ? [`Stopped: ${info.stoppedAt}`] : []),
    `Log: ${logPath}`,
    "",
  ];

  process.stdout.write(`${lines.join("\n")}\n`);
}

function writeLogExcerpt(path: string) {
  const log = readFileSync(path);
  const content = log.toString("utf8");
  if (content.trim().length === 0) return log.byteLength;

  const lines = content.split(/\r?\n/);
  if (lines.length <= DEFAULT_HEAD_LINES + DEFAULT_TAIL_LINES) {
    process.stdout.write(content.endsWith("\n") ? content : `${content}\n`);
    return log.byteLength;
  }

  const head = lines.slice(0, DEFAULT_HEAD_LINES).join("\n");
  const tail = lines.slice(-DEFAULT_TAIL_LINES).join("\n");
  const omitted = lines.length - DEFAULT_HEAD_LINES - DEFAULT_TAIL_LINES;

  process.stdout.write(`----- log start: first ${DEFAULT_HEAD_LINES} lines -----\n`);
  process.stdout.write(head.endsWith("\n") ? head : `${head}\n`);
  process.stdout.write(`----- omitted ${omitted} log lines -----\n`);
  process.stdout.write(`----- log tail: last ${DEFAULT_TAIL_LINES} lines -----\n`);
  process.stdout.write(tail.endsWith("\n") ? tail : `${tail}\n`);
  return log.byteLength;
}

function logHeader(command: string, commandArgs: string[]) {
  return [
    "# OS dev server log",
    `# Started: ${new Date().toISOString()}`,
    `# Command: ${[command, ...commandArgs].join(" ")}`,
    "",
    "",
  ].join("\n");
}

function spawnSyncExitCode(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd: APP_ROOT,
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(result.error);
    process.exitCode = 1;
    return { exitCode: 1 };
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
  }
  const exitCode = result.status === null ? 1 : result.status;
  process.exitCode = exitCode;
  return { exitCode };
}

function exitCodeForSignal(signal: NodeJS.Signals | null) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return undefined;
}

function normalizeBaseUrl(baseUrl: string) {
  // rm trailing /
  return baseUrl.replace(/\/+$/, "");
}

function cliStartOptions(input: CliStartOptions): StartOptions {
  const { skipDoppler, ...options } = input;
  return { ...options, noDoppler: skipDoppler };
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  void createCli({
    name: "dev",
    router: {
      attach: os
        .meta({ description: "Attach to the recorded OS local dev server log." })
        .input(EmptyInput)
        .handler(async () => attach()),
      kill: os
        .meta({ description: "Stop the recorded OS local dev server." })
        .input(EmptyInput)
        .handler(async () => kill()),
      restart: os
        .meta({ description: "Restart the OS local dev server." })
        .input(CliStartOptions)
        .handler(async ({ input }) => restart(cliStartOptions(input))),
      start: os
        .meta({
          default: true,
          description: "Start the OS local dev server, or attach if it is already running.",
        })
        .input(CliStartOptions)
        .handler(async ({ input }) => start(cliStartOptions(input))),
      status: os
        .meta({ description: "Show the recorded OS local dev server status." })
        .input(EmptyInput)
        .handler(async () => status()),
    },
  }).run();
}
