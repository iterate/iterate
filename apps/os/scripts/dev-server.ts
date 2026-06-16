import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { os as orpc } from "@orpc/server";
import { z } from "zod";

import {
  localDevServerLogPath,
  readLocalDevServerInfo,
  releaseLocalDevServerInfo,
  type DevServerInfo,
} from "@iterate-com/shared/alchemy/local-dev-server";

const APP_ROOT = process.cwd();
const ALCHEMY_DIR = resolve(APP_ROOT, ".alchemy");
const LOG_PATH = localDevServerLogPath(APP_ROOT);
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_KILL_TIMEOUT_MS = 10_000;
const DEFAULT_HEAD_LINES = 80;
const DEFAULT_TAIL_LINES = 80;

const EmptyInput = z.object({});

/**
 * OS local dev lifecycle commands.
 *
 * Normal use from apps/os:
 *
 *   pnpm dev                       # attached start; package.json routes here
 *   pnpm cli dev start --detach    # background start, prints selected URL
 *   pnpm cli dev status
 *   pnpm cli dev attach
 *   pnpm cli dev restart
 *   pnpm cli dev kill
 *
 * The actual Cloudflare/TanStack worker topology is still built by
 * `alchemy.run.ts`; this file only manages the local process lifecycle around
 * it and the `.alchemy/dev-server.json` / `.alchemy/dev-server.log` discovery
 * files that scripts and tests already know how to read.
 */
const StartInput = z.object({
  attach: z
    .boolean()
    .default(true)
    .describe("Keep this process attached to the dev server output."),
  detach: z
    .boolean()
    .default(false)
    .describe("Start in the background and return once the discovery file is published."),
});

export const devServerStatusScript = orpc
  .meta({ description: "Show the recorded OS local dev server status." })
  .input(EmptyInput)
  .handler(async () => devServerStatus());

export const devServerStartScript = orpc
  .meta({
    default: true,
    description: "Start the OS local dev server, or attach if it is already running.",
  })
  .input(StartInput)
  .handler(async ({ input }) => startDevServer(input));

export const devServerRestartScript = orpc
  .meta({ description: "Restart the OS local dev server." })
  .input(StartInput)
  .handler(async ({ input }) => {
    await killDevServer();
    return startDevServer(input);
  });

export const devServerKillScript = orpc
  .meta({ description: "Stop the recorded OS local dev server." })
  .input(EmptyInput)
  .handler(async () => killDevServer());

export const devServerAttachScript = orpc
  .meta({ description: "Attach to the recorded OS local dev server log." })
  .input(EmptyInput)
  .handler(async () => attachToRecordedDevServer());

type StartOptions = z.infer<typeof StartInput>;

export async function runDevServerCommand(argv: string[]): Promise<number> {
  const parsed = parseDirectArgs(argv);

  // These actions only touch the per-worktree discovery/log files, so the
  // direct compatibility wrapper can run them without entering Doppler first.
  // The ORPC app CLI still follows the repo-wide `pnpm cli` Doppler pattern.
  if (parsed.action === "status") {
    process.stdout.write(`${JSON.stringify(await devServerStatus(), null, 2)}\n`);
    return 0;
  }

  if (parsed.action === "kill") {
    process.stdout.write(`${JSON.stringify(await killDevServer(), null, 2)}\n`);
    return 0;
  }

  if (parsed.action === "attach") {
    await attachToRecordedDevServer();
    return 0;
  }

  if (parsed.action === "restart") {
    await killDevServer();
  }

  // `scripts/dev.ts` is kept as a compatibility entrypoint for dev:local and
  // direct script invocations. It re-enters itself inside Doppler for starts,
  // preserving the user's local `doppler setup` unless a config was explicit.
  if (parsed.useDoppler && !process.env.DOPPLER_CONFIG) {
    const dopplerArgs = [
      "run",
      ...(parsed.config ? ["--config", parsed.config] : []),
      "--",
      "tsx",
      "./scripts/dev.ts",
      "--no-doppler",
      ...parsed.forwardedArgv,
    ];
    return spawnSyncExitCode("doppler", dopplerArgs);
  }

  const result = await startDevServer(parsed.start);
  if (!shouldAttach(parsed.start)) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return "exitCode" in result ? result.exitCode : 0;
}

async function startDevServer({
  alchemyArgs = [],
  attach = true,
  detach = false,
  timeoutMs = DEFAULT_START_TIMEOUT_MS,
}: StartOptions & { alchemyArgs?: string[]; timeoutMs?: number }) {
  const shouldStream = !detach && attach;
  const existing = readLocalDevServerInfo(APP_ROOT, { requireLive: true });
  if (existing) {
    // One server per worktree: starting again attaches to the known live
    // process instead of trying to race Alchemy's own local state.
    console.info(`OS dev server already running: ${existing.baseUrl} (pid ${existing.pid})`);
    if (shouldStream) await attachToDevServer(existing);
    return formatStatus(existing);
  }

  if (shouldStream) {
    return startAttachedDevServer(alchemyArgs);
  }

  return startDetachedDevServer({ alchemyArgs, timeoutMs });
}

async function startAttachedDevServer(alchemyArgs: string[]) {
  mkdirSync(ALCHEMY_DIR, { recursive: true });
  const command = "tsx";
  const commandArgs = ["./alchemy.run.ts", ...alchemyArgs];
  const log = createWriteStream(LOG_PATH, { flags: "w" });

  // Attach mode tees the child output to both the terminal and the log file so
  // later `pnpm cli dev attach` calls can show the same boot history.
  log.write(logHeader(command, commandArgs));

  const child = spawn(command, commandArgs, {
    env: {
      ...process.env,
      DEV_SERVER_LOG_PATH: LOG_PATH,
    },
    stdio: ["inherit", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk);
    log.write(chunk);
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
    log.write(chunk);
  });

  child.on("error", (error) => {
    console.error(error);
    log.write(`${error.stack ?? error.message}\n`);
    log.end(() => process.exit(1));
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      child.kill(signal);
    });
  }

  return new Promise<{ exitCode: number }>((resolve) => {
    child.on("exit", (code, signal) => {
      log.end(() => {
        const exitCode = code ?? exitCodeForSignal(signal) ?? 1;
        process.exitCode = exitCode;
        resolve({ exitCode });
      });
    });
  });
}

async function startDetachedDevServer(options: { alchemyArgs: string[]; timeoutMs: number }) {
  mkdirSync(ALCHEMY_DIR, { recursive: true });
  const command = "tsx";
  const commandArgs = ["./alchemy.run.ts", ...options.alchemyArgs];
  const logFd = openSync(LOG_PATH, "w");
  writeSync(logFd, logHeader(command, commandArgs));

  // Detached mode redirects stdout/stderr straight into the log file and then
  // waits for alchemy.run.ts to publish `.alchemy/dev-server.json`; that file,
  // not the spawned pid, is the source of truth for the real worker process.
  const child = spawn(command, commandArgs, {
    detached: true,
    env: {
      ...process.env,
      DEV_SERVER_LOG_PATH: LOG_PATH,
    },
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  closeSync(logFd);

  const info = await waitForLiveInfo(options.timeoutMs);
  if (!info) {
    throw new Error(
      `OS dev server did not publish .alchemy/dev-server.json within ${options.timeoutMs}ms. ` +
        `Check ${LOG_PATH}. Spawned pid: ${child.pid ?? "unknown"}.`,
    );
  }

  console.info(`Started OS dev server: ${info.baseUrl} (pid ${info.pid})`);
  return formatStatus(info);
}

async function killDevServer() {
  const info = readLocalDevServerInfo(APP_ROOT, { requireLive: true });
  if (!info) {
    return { killed: false, message: "No live OS dev server recorded for this worktree." };
  }

  // SIGTERM gives alchemy/vite a chance to mark dev-server.json stopped. We
  // keep SIGKILL out of the public CLI so normal usage has fewer foot-guns.
  process.kill(info.pid, "SIGTERM");
  const stopped = await waitForPidExit(info.pid, DEFAULT_KILL_TIMEOUT_MS);
  if (!stopped) {
    throw new Error(
      `OS dev server pid ${info.pid} did not exit after SIGTERM. Stop it manually if needed.`,
    );
  }

  releaseLocalDevServerInfo(APP_ROOT, info.pid);
  console.info(`Stopped OS dev server: ${info.baseUrl} (pid ${info.pid})`);
  return { killed: true, pid: info.pid, baseUrl: info.baseUrl };
}

async function attachToRecordedDevServer() {
  const info = readLocalDevServerInfo(APP_ROOT, { requireLive: true });
  if (!info) {
    throw new Error("No live OS dev server recorded for this worktree.");
  }
  return attachToDevServer(info);
}

async function attachToDevServer(info: DevServerInfo) {
  const logPath = info.logPath?.trim() || LOG_PATH;
  writeAttachPreamble(info, logPath);
  if (!existsSync(logPath)) {
    console.info("Waiting for log file...");
  } else {
    // Show the boot header/config warnings at the start and the recent tail,
    // without dumping thousands of middle lines from a long-running server.
    writeLogExcerpt(logPath, {
      headLines: DEFAULT_HEAD_LINES,
      tailLines: DEFAULT_TAIL_LINES,
    });
  }

  let offset = existsSync(logPath) ? statSync(logPath).size : 0;
  await new Promise<void>((resolve) => {
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(interval);
      process.off("SIGINT", onSigint);
      resolve();
    };

    const onSigint = () => finish();
    process.once("SIGINT", onSigint);

    const interval = setInterval(() => {
      if (existsSync(logPath)) {
        const size = statSync(logPath).size;
        if (size < offset) offset = 0;
        if (size > offset) {
          // Read only the newly appended byte range; large logs should not be
          // reread from the beginning on every poll.
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

function devServerStatus() {
  const info = readLocalDevServerInfo(APP_ROOT);
  return formatStatus(info);
}

function formatStatus(info: DevServerInfo | null) {
  if (!info) {
    return { live: false, recorded: false, logPath: LOG_PATH };
  }

  const live = !info.stoppedAt && isPidAlive(info.pid);
  return {
    live,
    recorded: true,
    pid: info.pid,
    port: info.port,
    baseUrl: info.baseUrl,
    logPath: info.logPath ?? LOG_PATH,
    startedAt: info.startedAt,
    stoppedAt: info.stoppedAt,
  };
}

async function waitForLiveInfo(timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = readLocalDevServerInfo(APP_ROOT, { requireLive: true });
    if (info) return info;
    await sleep(250);
  }
  return null;
}

async function waitForPidExit(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(100);
  }
  return !isPidAlive(pid);
}

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeAttachPreamble(info: DevServerInfo, logPath: string) {
  const baseUrl = new URL(info.baseUrl);
  const parentPid = readParentPid(info.pid);
  const status = !info.stoppedAt && isPidAlive(info.pid) ? "live" : "not live";
  const lines = [
    "Attaching to OS dev server",
    `Status: ${status}`,
    `Base URL: ${info.baseUrl}`,
    `Host: ${baseUrl.hostname}`,
    `Port: ${info.port}`,
    `PID: ${info.pid}`,
    ...(parentPid ? [`Parent PID: ${parentPid}`] : []),
    `Started: ${info.startedAt}`,
    ...(info.stoppedAt ? [`Stopped: ${info.stoppedAt}`] : []),
    `Log: ${logPath}`,
    "",
  ];

  process.stdout.write(`${lines.join("\n")}\n`);
}

function readParentPid(pid: number) {
  const result = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parentPid = result.stdout?.trim();
  return parentPid && /^\d+$/.test(parentPid) ? Number(parentPid) : null;
}

function writeLogExcerpt(
  path: string,
  options: {
    headLines: number;
    tailLines: number;
  },
) {
  const content = readFileSync(path, "utf8");
  if (content.trim().length === 0) return;

  const lines = content.split(/\r?\n/);
  const headLines = Math.max(0, options.headLines);
  const tailLines = Math.max(0, options.tailLines);
  if (lines.length <= headLines + tailLines) {
    process.stdout.write(content.endsWith("\n") ? content : `${content}\n`);
    return;
  }

  const head = lines.slice(0, headLines).join("\n");
  const tail = tailLines > 0 ? lines.slice(-tailLines).join("\n") : "";
  const omitted = lines.length - headLines - tailLines;

  process.stdout.write(`----- log start: first ${headLines} lines -----\n`);
  process.stdout.write(head.endsWith("\n") ? head : `${head}\n`);
  process.stdout.write(`----- omitted ${omitted} log lines -----\n`);
  if (tailLines > 0) {
    process.stdout.write(`----- log tail: last ${tailLines} lines -----\n`);
    process.stdout.write(tail.endsWith("\n") ? tail : `${tail}\n`);
  }
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
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(result.error);
    return 1;
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
  }
  return result.status ?? 1;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function exitCodeForSignal(signal: NodeJS.Signals | null) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return undefined;
}

function shouldAttach(options: Pick<StartOptions, "attach" | "detach">) {
  return options.detach ? false : options.attach;
}

type DirectAction = "attach" | "kill" | "restart" | "start" | "status";

function parseDirectArgs(argv: string[]) {
  const forwardedArgv: string[] = [];
  const alchemyArgs: string[] = [];
  let action: DirectAction = "start";
  let attach = true;
  let config: string | undefined;
  let useDoppler = true;
  let actionResolved = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--") {
      alchemyArgs.push(...argv.slice(index + 1));
      forwardedArgv.push(...argv.slice(index));
      break;
    }

    if (!actionResolved && isDirectAction(arg)) {
      action = arg;
      actionResolved = true;
      forwardedArgv.push(arg);
      continue;
    }

    if (arg === "--no-doppler") {
      useDoppler = false;
      continue;
    }

    if (arg === "--config") {
      config = requireNext(argv, index, "--config");
      index += 1;
      continue;
    }

    if (arg.startsWith("--config=")) {
      config = arg.slice("--config=".length);
      continue;
    }

    if (arg === "--attach") {
      attach = true;
      forwardedArgv.push(arg);
      continue;
    }

    if (arg === "--detach") {
      attach = false;
      forwardedArgv.push(arg);
      continue;
    }

    actionResolved = true;
    alchemyArgs.push(arg);
    forwardedArgv.push(arg);
  }

  return {
    action,
    config,
    forwardedArgv,
    start: { alchemyArgs, attach, detach: !attach, timeoutMs: DEFAULT_START_TIMEOUT_MS },
    useDoppler,
  };
}

function isDirectAction(value: string): value is DirectAction {
  return (
    value === "attach" ||
    value === "kill" ||
    value === "restart" ||
    value === "start" ||
    value === "status"
  );
}

function requireNext(argv: string[], index: number, flag: string) {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}
